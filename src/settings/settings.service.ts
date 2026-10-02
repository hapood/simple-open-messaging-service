import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import webpush from 'web-push';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { configDirectory } from '../common/data-directory.js';
import { systemSetting } from '../database/schema.js';
import { loadFederationConfig } from '../federation/federation.config.js';
import { federationDownloadSettingKeys } from '../federation/federation-download-scheduler.js';
import { federationHttpSettingKeys } from '../federation/federation-http-scheduler.js';
import {
  FEDERATION_HISTORY_ACCESS_SETTING_KEY,
  federationHistoryAccessEnabled,
} from '../federation/federation-history-access-setting.js';
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

const VAPID_PATH = configDirectory('vapid-key.json');
const FIREBASE_CLIENT_PATH = configDirectory('google-services.json');

/** SystemSetting key + bounds for the admin-configurable one-time-code validity window (minutes). Default
 *  10 min; clamped to [1, 1440] so an admin typo can't make codes instantly expire or outlive a day. */
const OTP_TTL_KEY = 'otp:ttlMinutes';
const OTP_TTL_DEFAULT = 10;
const OTP_TTL_MIN = 1;
const OTP_TTL_MAX = 1440;
const FEDERATION_CHUNK_DIGEST_KEY = 'federation:media:chunkDigestEnabled';

/**
 * Runtime settings facade. Mutable operator settings live in SystemSetting; application-owned VAPID
 * identity follows the same fixed-file lifecycle as every other server key.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private vapid!: VapidConfig;
  /** Lazily-loaded Firebase client config from disk (see loadFirebaseClientConfig). `undefined` = not yet
   *  read; `null` = read but unconfigured (no/invalid google-services.json); a config = configured. Cached
   *  for the process lifetime — restart to pick up a changed file. */
  private fbFile: FirebaseClientConfig | null | undefined;

  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly vapidPathOverride?: string,
    @Optional() private readonly firebaseClientPathOverride?: string,
  ) {}

  private get vapidPath(): string {
    return this.vapidPathOverride ?? VAPID_PATH;
  }

  async onModuleInit(): Promise<void> {
    this.vapid = this.loadOrCreateVapid();
    // Eager-load the Firebase client config from disk at boot (not lazily on first request) so the one
    // (tiny) sync read happens here, at startup — the admin status + public serve paths then never touch
    // the filesystem. A missing/malformed file logs + leaves FCM unconfigured (see loadFirebaseClientConfig).
    this.fbFile = this.loadFirebaseClientConfig();
  }

  getVapid(): VapidConfig {
    return this.vapid;
  }

  get isWebPushConfigured(): boolean {
    return true;
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

  async getFederationHistoryAccessEnabled(): Promise<boolean> {
    const row = await this.findSetting(FEDERATION_HISTORY_ACCESS_SETTING_KEY);
    return federationHistoryAccessEnabled(row?.value);
  }

  async setFederationHistoryAccessEnabled(enabled: boolean): Promise<void> {
    await this.upsertSetting(
      FEDERATION_HISTORY_ACCESS_SETTING_KEY,
      String(enabled),
    );
  }

  async getFederationDownloadLimits(): Promise<{
    global: number;
    perPeer: number;
    chunkDigestEnabled: boolean;
  }> {
    const [globalRow, peerRow, chunkDigestRow] = await Promise.all([
      this.findSetting(federationDownloadSettingKeys.globalLimit),
      this.findSetting(federationDownloadSettingKeys.peerLimit),
      this.findSetting(FEDERATION_CHUNK_DIGEST_KEY),
    ]);
    return {
      global: this.parseBoundedInt(globalRow?.value, 10, 1, 100),
      perPeer: this.parseBoundedInt(peerRow?.value, 2, 1, 100),
      chunkDigestEnabled: chunkDigestRow?.value === 'true',
    };
  }

  async getFederationHttpLimits(): Promise<{
    global: number;
    perPeer: number;
  }> {
    const [globalRow, peerRow] = await Promise.all([
      this.findSetting(federationHttpSettingKeys.globalLimit),
      this.findSetting(federationHttpSettingKeys.peerLimit),
    ]);
    return {
      global: this.parseBoundedInt(globalRow?.value, 16, 1, 100),
      perPeer: this.parseBoundedInt(peerRow?.value, 8, 1, 100),
    };
  }

  async setFederationHttpLimits(
    global: number,
    perPeer: number,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const updatedAt = new Date();
      for (const [key, value] of [
        [federationHttpSettingKeys.globalLimit, global],
        [federationHttpSettingKeys.peerLimit, perPeer],
      ] as const) {
        await tx
          .insert(systemSetting)
          .values({ key, value: String(value), updatedAt })
          .onConflictDoUpdate({
            target: systemSetting.key,
            set: { value: String(value), updatedAt },
          });
      }
    });
  }

  async isFederationChunkDigestEnabled(): Promise<boolean> {
    return (
      (await this.findSetting(FEDERATION_CHUNK_DIGEST_KEY))?.value === 'true'
    );
  }

  async setFederationDownloadLimits(
    global: number,
    perPeer: number,
    chunkDigestEnabled: boolean,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const updatedAt = new Date();
      for (const [key, value] of [
        [federationDownloadSettingKeys.globalLimit, global],
        [federationDownloadSettingKeys.peerLimit, perPeer],
        [FEDERATION_CHUNK_DIGEST_KEY, chunkDigestEnabled],
      ] as const) {
        await tx
          .insert(systemSetting)
          .values({ key, value: String(value), updatedAt })
          .onConflictDoUpdate({
            target: systemSetting.key,
            set: { value: String(value), updatedAt },
          });
      }
    });
  }

  private parseBoundedInt(
    value: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
      ? parsed
      : fallback;
  }

  getVapidDescriptor(): {
    configured: boolean;
    subject?: string;
    publicKey?: string;
    updatedAt?: Date;
  } {
    const stat = statSync(this.vapidPath);
    return {
      configured: true,
      subject: this.vapid.subject,
      publicKey: this.vapid.publicKey,
      updatedAt: stat.birthtime,
    };
  }

  getVapidKeyStatus() {
    const stat = statSync(this.vapidPath);
    return {
      configured: true,
      valid: this.validateVapid(this.vapid, false).webPushConfigured,
      publicKey: this.vapid.publicKey,
      fingerprint: createHash('sha256')
        .update(this.vapid.publicKey)
        .digest('hex')
        .slice(0, 16),
      createdAt: stat.birthtimeMs,
      permissionsSecure: (stat.mode & 0o077) === 0,
    };
  }

  private loadOrCreateVapid(): VapidConfig {
    const path = this.vapidPath;
    if (existsSync(path)) {
      const parsed = this.parseVapid(readFileSync(path, 'utf8'));
      if (!parsed) throw new Error(`invalid managed VAPID key file: ${path}`);
      const report = this.validateVapid(parsed, false);
      if (!report.webPushConfigured) throw new Error(report.errors.join('; '));
      return parsed;
    }
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    const config = {
      publicKey,
      privateKey,
      subject: `https://${this.somsDomain}`,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    this.logger.warn(`Auto-generated persistent VAPID key: ${path}`);
    return config;
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
  // the server — structurally the same kind of artifact as the Firebase service-account key, NOT a
  // server-generated value like the VAPID keypair. It lives at the fixed data/google-services.json path
  // and is read once at boot. The 4
  // fields are published to clients folded into GET /client/compat (the connect-time payload) so the Android
  // APK initializes FirebaseApp at runtime without baking google-services.json into the build. Independent of
  // the send-side data/firebase-service-account.json file (PushService.fcmConfigured).

  /** The current Firebase client config, or null when no valid google-services.json is present. Returns the
   *  value loaded once at boot (onModuleInit) — restart to pick up a changed file. Published to clients
   *  folded into GET /client/compat (ClientCompatService.compat). */
  getFirebaseConfig(): FirebaseClientConfig | null {
    return this.fbFile ?? null;
  }

  /** Read + parse data/google-services.json. A missing file is the normal "not yet configured" case.
   *  A malformed file is warned. Never throws — a bad file leaves FCM unconfigured, never crashes boot. */
  private loadFirebaseClientConfig(): FirebaseClientConfig | null {
    const p = this.firebaseClientPathOverride ?? FIREBASE_CLIENT_PATH;
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch (e) {
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
   *  passed in (it comes from PushService); `webPushConfigured` in the
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
    return null;
  }
}
