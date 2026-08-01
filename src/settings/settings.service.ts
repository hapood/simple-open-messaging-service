import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { systemSetting } from '../database/schema.js';
import { loadFederationConfig } from '../federation/federation.config.js';
import {
  type VapidConfig,
  type VapidHealthReport,
  isValidPublicKey,
  isValidPrivateKey,
  isValidSubject,
  pairMatchesKey,
} from './vapid.js';
import {
  type FirebaseClientConfig,
  type FirebaseConfigDescriptor,
  parseGoogleServicesJson,
} from './firebase.js';

const VAPID_KEY = 'vapid';
const TTL_MS = 30_000;
const DEFAULT_SUBJECT = 'mailto:noreply@soms.local';

/** SystemSetting key + bounds for the admin-configurable one-time-code validity window (minutes). Default
 *  10 min; clamped to [1, 1440] so an admin typo can't make codes instantly expire or outlive a day. */
const OTP_TTL_KEY = 'otp:ttlMinutes';
const OTP_TTL_DEFAULT = 10;
const OTP_TTL_MIN = 1;
const OTP_TTL_MAX = 1440;

type VapidEntry = { value: VapidConfig | null; fetchedAt: number };

/**
 * DB-backed, admin-managed runtime settings — the typed facade over the {@link SystemSetting} KV table.
 * Today it owns the Web Push VAPID keypair; future operator-configured values (feature flags, branding,
 * …) extend the same table + this service.
 *
 * Why DB and not env: VAPID is an OPTIONAL transport (Web Push), runtime-toggleable by an admin, and its
 * public key is already served dynamically to browsers. Storing it in the DB lets an admin enable/rotate
 * Web Push from the console with no redeploy or shell access. Bootstrap/identity config (DATABASE_URL,
 * SOMS_DOMAIN) stays in env — it is needed before the app/DB are up.
 *
 * Cache: Web Push reads the keys on every send, so a per-send DB hit would be wasteful. We keep a single
 * cached entry refreshed stale-while-revalidate (sync getter → fire-and-forget refresh on stale, single-
 * flight, proactive 30s interval). Writes update the cache synchronously so THIS instance sees the new
 * keys immediately; other instances pick them up within TTL via the interval. VAPID rotates rarely, so
 * ≤30s cross-instance staleness is acceptable (Redis pub/sub exists if faster coherence is ever needed).
 *
 * Single source of truth: the DB. There is NO env fallback — VAPID_* env vars are never read (a fresh
 * deploy starts with Web Push disabled until an admin generates a keypair in the console). Bootstrap/
 * identity config (DATABASE_URL, SOMS_DOMAIN) still belongs in env — it is needed before the app/DB are up.
 *
 * Threat model: the VAPID private key is stored plaintext. The DB is already the trust root (password
 * hashes, refresh-token hashes, per-device push p256dh/auth keys). A VAPID-key compromise only lets an
 * attacker SEND pushes to existing subscribers (forge the push-service auth JWT), NOT decrypt payloads —
 * RFC 8291 payload encryption uses each subscriber's p256dh/auth ECDH keypair, not the VAPID key. Rotating
 * the keypair breaks existing subscriptions → clients must re-subscribe.
 */
@Injectable()
export class SettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettingsService.name);
  private entry: VapidEntry = { value: null, fetchedAt: 0 };
  /** Lazily-loaded Firebase client config from disk (see loadFirebaseClientConfig). `undefined` = not yet
   *  read; `null` = read but unconfigured (no/invalid google-services.json); a config = configured. Cached
   *  for the process lifetime — restart to pick up a changed file (same model as GOOGLE_APPLICATION_CREDENTIALS). */
  private fbFile: FirebaseClientConfig | null | undefined;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.refresh();
    } catch (e) {
      // VAPID is optional; a transient DB hiccup at boot must not take the server down — leave the cache
      // empty (webPushConfigured=false) and let the interval retry. Mirrors PushService's own degradation.
      this.logger.warn(`initial settings load failed: ${(e as Error).message}`);
    }
    // Eager-load the Firebase client config from disk at boot (not lazily on first request) so the one
    // (tiny) sync read happens here, at startup — the admin status + public serve paths then never touch
    // the filesystem. A missing/malformed file logs + leaves FCM unconfigured (see loadFirebaseClientConfig).
    this.fbFile = this.loadFirebaseClientConfig();
    this.timer = setInterval(() => {
      this.refresh().catch((e) =>
        this.logger.debug(`settings refresh failed: ${(e as Error).message}`),
      );
    }, TTL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The current VAPID config, or null when Web Push is not configured. SYNC — never blocks on IO; may
   *  return a value up to TTL_MS stale while a refresh runs in the background. */
  getVapid(): VapidConfig | null {
    if (Date.now() - this.entry.fetchedAt >= TTL_MS) {
      // Stale — kick off a background refresh; return the current (possibly stale) value immediately.
      this.refresh().catch(() => {});
    }
    return this.entry.value;
  }

  get isWebPushConfigured(): boolean {
    return this.getVapid() !== null;
  }

  /** This server's public domain — read-only (from SOMS_DOMAIN env, the federation identity). Surfaced on
   *  the admin Settings page for visibility; not editable (it's a deploy-time identity). */
  get somsDomain(): string {
    return loadFederationConfig().domain;
  }

  /** The admin-configured one-time-code validity window, in minutes (default 10, clamped). Read fresh on
   *  each issue — OTP issuance is rare and admin-triggered, so no cache is warranted (unlike VAPID). */
  async getOtpTtlMinutes(): Promise<number> {
    const row = await this.findSetting(OTP_TTL_KEY);
    const n = row ? Number(row.value) : NaN;
    if (!Number.isFinite(n)) return OTP_TTL_DEFAULT;
    return Math.min(OTP_TTL_MAX, Math.max(OTP_TTL_MIN, Math.trunc(n)));
  }

  /** Persist the one-time-code validity window (minutes). The value is clamped on read too, so an out-of-
   *  range write is still safe, but we clamp on write for a tidy stored value + accurate admin display. */
  async setOtpTtlMinutes(minutes: number): Promise<void> {
    const clamped = Math.min(
      OTP_TTL_MAX,
      Math.max(OTP_TTL_MIN, Math.trunc(minutes)),
    );
    await this.upsertSetting(OTP_TTL_KEY, String(clamped));
  }

  /** Authoritative VAPID descriptor for the admin read view — queries the row directly for the real
   *  updatedAt (not the send-path cache). publicKey is public; privateKey is intentionally absent. */
  async getVapidDescriptor(): Promise<{
    configured: boolean;
    subject?: string;
    publicKey?: string;
    updatedAt?: Date;
  }> {
    const row = await this.findSetting(VAPID_KEY);
    if (!row) return { configured: false };
    const cfg = this.parseVapid(row.value);
    if (!cfg) return { configured: false };
    return {
      configured: true,
      subject: cfg.subject,
      publicKey: cfg.publicKey,
      updatedAt: row.updatedAt,
    };
  }

  /** Reload the VAPID cache from DB (single-flight: concurrent callers share one pass). The Firebase client
   *  config is NOT DB-backed — it lives in a google-services.json file read on demand (see getFirebaseConfig)
   *  — so only VAPID is reloaded here. */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const vapidRow = await this.findSetting(VAPID_KEY);
        this.entry = {
          value: vapidRow ? this.parseVapid(vapidRow.value) : null,
          fetchedAt: Date.now(),
        };
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Generate a fresh P-256 VAPID keypair (library-blessed output: base64url, browser-compatible). */
  generateVapid(subject: string = DEFAULT_SUBJECT): VapidConfig {
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    return {
      publicKey,
      privateKey,
      subject: subject?.trim() || DEFAULT_SUBJECT,
    };
  }

  /** Persist a VAPID config and update the local cache immediately (other instances pick it up ≤ TTL). */
  async setVapid(cfg: VapidConfig): Promise<void> {
    await this.upsertSetting(VAPID_KEY, JSON.stringify(cfg));
    this.entry = { value: cfg, fetchedAt: Date.now() };
  }

  /** Remove the VAPID config (disables Web Push). */
  async clearVapid(): Promise<void> {
    await this.database.db
      .delete(systemSetting)
      .where(eq(systemSetting.key, VAPID_KEY));
    this.entry = { value: null, fetchedAt: Date.now() };
  }

  private findSetting(key: string) {
    return this.database.db.query.systemSetting.findFirst({
      where: eq(systemSetting.key, key),
    });
  }

  private async upsertSetting(key: string, value: string): Promise<void> {
    const updatedAt = new Date();
    await this.database.db
      .insert(systemSetting)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({
        target: systemSetting.key,
        set: { value, updatedAt },
      });
  }

  // ---- Firebase client config (FCM for Android) ---------------------------------------------
  // File-based, NOT DB-backed. google-services.json is a Firebase-console download the operator places on
  // the server — structurally the same kind of artifact as the GOOGLE_APPLICATION_CREDENTIALS service-
  // account key (also a file + env path), NOT a server-generated value like the VAPID keypair. So it lives
  // on disk (FIREBASE_CLIENT_CONFIG env, default data/google-services.json) and is read once at boot. The 4
  // fields are published to clients folded into GET /shell/compat (the connect-time payload) so the Android
  // APK initializes FirebaseApp at runtime without baking google-services.json into the build. Independent of
  // the send-side GOOGLE_APPLICATION_CREDENTIALS path (PushService.fcmConfigured).

  /** The current Firebase client config, or null when no valid google-services.json is present. Returns the
   *  value loaded once at boot (onModuleInit) — restart to pick up a changed file. Published to clients
   *  folded into GET /shell/compat (ShellService.compat). */
  getFirebaseConfig(): FirebaseClientConfig | null {
    return this.fbFile ?? null;
  }

  /** Read + parse the google-services.json file at FIREBASE_CLIENT_CONFIG (default data/google-services.json).
   *  A missing DEFAULT path is the normal "not yet configured" case (null, no warning); but when the operator
   *  explicitly set FIREBASE_CLIENT_CONFIG, an unreadable file is a misconfiguration and is warned so it
   *  surfaces in logs rather than reading as a mysterious "not configured" in the admin UI. A present-but-
   *  malformed file is always warned. Never throws — a bad file leaves FCM unconfigured, never crashes boot. */
  private loadFirebaseClientConfig(): FirebaseClientConfig | null {
    const explicit = !!process.env.FIREBASE_CLIENT_CONFIG;
    const p =
      process.env.FIREBASE_CLIENT_CONFIG ||
      join(process.cwd(), 'data', 'google-services.json');
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch (e) {
      if (explicit) {
        this.logger.warn(
          `FIREBASE_CLIENT_CONFIG points to an unreadable file (${p}): ${(e as Error).message} — FCM client config treated as unconfigured`,
        );
      }
      return null;
    }
    try {
      return parseGoogleServicesJson(raw);
    } catch (e) {
      this.logger.warn(
        `failed to parse ${p} as google-services.json: ${(e as Error).message} — FCM client config treated as unconfigured`,
      );
      return null;
    }
  }

  /** Whether a valid FCM client config is present on disk. Independent of PushService.fcmConfigured (the
   *  send-side service-account). */
  get firebaseClientConfigured(): boolean {
    return this.getFirebaseConfig() !== null;
  }

  /** Firebase descriptor for the admin read view. apiKey is intentionally absent (parallel to the VAPID
   *  descriptor omitting privateKey); the other three fields are shown as proof of which project/app the
   *  on-disk google-services.json configures. */
  getFirebaseDescriptor(): FirebaseConfigDescriptor {
    const cfg = this.getFirebaseConfig();
    if (!cfg) return { configured: false };
    return {
      configured: true,
      projectId: cfg.projectId,
      appId: cfg.appId,
      gcmSenderId: cfg.gcmSenderId,
    };
  }

  /** Validate a VAPID config without any network access (deterministic health check). `fcmConfigured` is
   *  passed in (it comes from PushService / GOOGLE_APPLICATION_CREDENTIALS); `webPushConfigured` in the
   *  report reflects whether THIS cfg is a working Web Push keypair (pairMatches && subjectValid). */
  validateVapid(
    cfg: VapidConfig | null,
    fcmConfigured: boolean,
  ): VapidHealthReport {
    const errors: string[] = [];
    const somsDomain = this.somsDomain;
    if (!cfg) {
      return {
        configured: false,
        publicKeyValid: false,
        privateKeyValid: false,
        pairMatches: false,
        subjectValid: false,
        fcmConfigured,
        firebaseClientConfigured: this.firebaseClientConfigured,
        webPushConfigured: false,
        somsDomain,
        errors,
      };
    }
    const publicKeyValid = isValidPublicKey(cfg.publicKey);
    if (!publicKeyValid)
      errors.push(
        'publicKey must be base64url of a 65-byte uncompressed P-256 point',
      );
    const privateKeyValid = isValidPrivateKey(cfg.privateKey);
    if (!privateKeyValid)
      errors.push('privateKey must be base64url of a 32-byte scalar');
    const subjectValid = isValidSubject(cfg.subject);
    if (!subjectValid) errors.push('subject must be a mailto: or https: URL');
    const pairMatches =
      publicKeyValid &&
      privateKeyValid &&
      pairMatchesKey(cfg.publicKey, cfg.privateKey);
    if (!pairMatches && publicKeyValid && privateKeyValid) {
      errors.push('publicKey does not match privateKey (not a P-256 keypair)');
    }
    return {
      configured: true,
      publicKeyValid,
      privateKeyValid,
      pairMatches,
      subjectValid,
      fcmConfigured,
      firebaseClientConfigured: this.firebaseClientConfigured,
      webPushConfigured: pairMatches && subjectValid,
      somsDomain,
      errors,
    };
  }

  private parseVapid(raw: string): VapidConfig | null {
    try {
      const obj = JSON.parse(raw) as Partial<VapidConfig>;
      if (
        typeof obj.publicKey === 'string' &&
        typeof obj.privateKey === 'string' &&
        typeof obj.subject === 'string'
      ) {
        return {
          publicKey: obj.publicKey,
          privateKey: obj.privateKey,
          subject: obj.subject,
        };
      }
    } catch {
      // fall through to the warn
    }
    this.logger.warn(
      'stored VAPID row is malformed — treating Web Push as unconfigured',
    );
    return null;
  }
}
