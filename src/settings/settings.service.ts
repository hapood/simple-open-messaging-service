import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import webpush from 'web-push';
import { PrismaService } from '../prisma.service.js';
import { loadFederationConfig } from '../federation/federation.config.js';
import {
  type VapidConfig,
  type VapidHealthReport,
  isValidPublicKey,
  isValidPrivateKey,
  isValidSubject,
  pairMatchesKey,
} from './vapid.js';

const VAPID_KEY = 'vapid';
const TTL_MS = 30_000;
const DEFAULT_SUBJECT = 'mailto:noreply@soms.local';

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
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.refresh();
    } catch (e) {
      // VAPID is optional; a transient DB hiccup at boot must not take the server down — leave the cache
      // empty (webPushConfigured=false) and let the interval retry. Mirrors PushService's own degradation.
      this.logger.warn(`initial settings load failed: ${(e as Error).message}`);
    }
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

  /** Authoritative VAPID descriptor for the admin read view — queries the row directly for the real
   *  updatedAt (not the send-path cache). publicKey is public; privateKey is intentionally absent. */
  async getVapidDescriptor(): Promise<{
    configured: boolean;
    subject?: string;
    publicKey?: string;
    updatedAt?: Date;
  }> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: VAPID_KEY } });
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

  /** Reload the cache from DB (single-flight: concurrent callers share one DB read). No env fallback —
   *  VAPID is DB-only. */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const row = await this.prisma.systemSetting.findUnique({ where: { key: VAPID_KEY } });
        this.entry = {
          value: row ? this.parseVapid(row.value) : null,
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
    return { publicKey, privateKey, subject: subject?.trim() || DEFAULT_SUBJECT };
  }

  /** Persist a VAPID config and update the local cache immediately (other instances pick it up ≤ TTL). */
  async setVapid(cfg: VapidConfig): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key: VAPID_KEY },
      create: { key: VAPID_KEY, value: JSON.stringify(cfg) },
      update: { value: JSON.stringify(cfg) },
    });
    this.entry = { value: cfg, fetchedAt: Date.now() };
  }

  /** Remove the VAPID config (disables Web Push). */
  async clearVapid(): Promise<void> {
    await this.prisma.systemSetting.deleteMany({ where: { key: VAPID_KEY } });
    this.entry = { value: null, fetchedAt: Date.now() };
  }

  /** Validate a VAPID config without any network access (deterministic health check). `fcmConfigured` is
   *  passed in (it comes from PushService / GOOGLE_APPLICATION_CREDENTIALS); `webPushConfigured` in the
   *  report reflects whether THIS cfg is a working Web Push keypair (pairMatches && subjectValid). */
  validateVapid(cfg: VapidConfig | null, fcmConfigured: boolean): VapidHealthReport {
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
        webPushConfigured: false,
        somsDomain,
        errors,
      };
    }
    const publicKeyValid = isValidPublicKey(cfg.publicKey);
    if (!publicKeyValid) errors.push('publicKey must be base64url of a 65-byte uncompressed P-256 point');
    const privateKeyValid = isValidPrivateKey(cfg.privateKey);
    if (!privateKeyValid) errors.push('privateKey must be base64url of a 32-byte scalar');
    const subjectValid = isValidSubject(cfg.subject);
    if (!subjectValid) errors.push('subject must be a mailto: or https: URL');
    const pairMatches = publicKeyValid && privateKeyValid && pairMatchesKey(cfg.publicKey, cfg.privateKey);
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
        return { publicKey: obj.publicKey, privateKey: obj.privateKey, subject: obj.subject };
      }
    } catch {
      // fall through to the warn
    }
    this.logger.warn('stored VAPID row is malformed — treating Web Push as unconfigured');
    return null;
  }
}
