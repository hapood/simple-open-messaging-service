import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dataDirectory } from '../common/data-directory.js';
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  applicationDefault,
  getApps,
  getApp,
  initializeApp,
} from 'firebase-admin/app';
import {
  getMessaging,
  type Messaging,
  type Message,
} from 'firebase-admin/messaging';
import webpush from 'web-push';
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  type SQL,
} from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { pushToken, user } from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { RegisterDeviceDto } from '../dto/device.dto.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

export type FcmProbeStatus = {
  probeId: string;
  stage: 'fcm_accepted' | 'device_received' | 'failed';
  createdAt: number;
  acceptedAt?: number;
  receivedAt?: number;
  latencyMs?: number;
  errorCode?: string;
};

type FcmProbeEntry = FcmProbeStatus & {
  userId: number;
  token: string;
  sending?: boolean;
};

/**
 * Multi-platform push delivery — the wake-up channel that complements SSE.
 *
 * Design (see plans/virtual-forging-fairy.md): on every NEW_MESSAGE the server fans out an SSE signal
 * to online recipients; PushService fans out a wake-up to OFFLINE recipients only (skip-when-online).
 * The payload is the SAME data-only signal regardless of transport — the client's pull pipeline is
 * already idempotent at three layers, so a duplicate SSE+push pull collapses silently, and a duplicate
 * across transports (FCM + Web Push) collapses too.
 *
 * Two transports, branched by `PushToken.platform`:
 *  - ANDROID / IOS → firebase-admin `sendEach` (data-only, high priority).
 *  - WEB           → `web-push` lib (standard Web Push + VAPID), payload is the JSON-stringified signal.
 *
 * Degradation: each transport is independently gated on its own config — the operator-provided
 * data/firebase-service-account.json for FCM and the managed VAPID keypair for Web Push. Either missing
 * → that transport no-ops (the other still works; both missing → SSE-only, the local/dev path).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly messaging: Messaging | null;
  private readonly fcmCredentialPath: string;
  private readonly fcmProbes = new Map<string, FcmProbeEntry>();
  private readonly fcmProbeCooldowns = new Map<string, number>();

  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
    private readonly settings: SettingsService,
    @Optional()
    @Inject('SOMS_TEST_FIREBASE_SERVICE_ACCOUNT_PATH')
    testFirebaseServiceAccountPath?: string,
  ) {
    this.fcmCredentialPath =
      testFirebaseServiceAccountPath ??
      dataDirectory('firebase-service-account.json');
    if (existsSync(this.fcmCredentialPath)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = this.fcmCredentialPath;
      const app = getApps().length
        ? getApp()
        : initializeApp({ credential: applicationDefault() });
      this.messaging = getMessaging(app);
      this.logger.log(
        `FCM messaging initialized from ${this.fcmCredentialPath}`,
      );
    } else {
      this.messaging = null;
      this.logger.warn(
        `FCM service-account file not found at ${this.fcmCredentialPath} — FCM dispatch disabled`,
      );
    }
    // Web Push: VAPID keys are fixed-file managed by SettingsService and passed PER SEND as the
    // vapidDetails option (see sendWebPush) — NOT the module-global setVapidDetails. Nothing to init here:
    // settings.isWebPushConfigured is the runtime gate, and an admin key rotation takes effect on the next
    // send with no restart.
  }

  /** Upsert a registration token for the authenticated user. `token` is globally unique (one row per
   *  device), so the upsert re-owns the row to the current user on an account switch on the same device
   *  and bumps lastSeenAt on every re-register (token rotation, app upgrade, periodic heartbeat). For
   *  WEB the subscription's p256dh + auth keys are stored alongside (the server must encrypt the Web
   *  Push payload to these keys before sending). */
  async registerToken(userId: number, dto: RegisterDeviceDto): Promise<void> {
    const now = new Date();
    await this.database.db
      .insert(pushToken)
      .values({
        userId,
        token: dto.token,
        platform: dto.platform,
        deviceId: dto.deviceId,
        webP256dh: dto.p256dh,
        webAuth: dto.auth,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pushToken.token,
        set: {
          userId,
          platform: dto.platform,
          deviceId: dto.deviceId,
          webP256dh: dto.p256dh,
          webAuth: dto.auth,
          updatedAt: now,
          lastSeenAt: now,
        },
      });
  }

  /** Remove a registration token. Scoped to the caller — a user cannot unregister another user's device.
   *  deleteMany (not delete) so a not-found / wrong-owner call is a no-op rather than throwing. */
  async unregisterToken(userId: number, token: string): Promise<void> {
    await this.database.db
      .delete(pushToken)
      .where(and(eq(pushToken.token, token), eq(pushToken.userId, userId)));
  }

  /** Send a data-only probe to the caller's registered Android token. Probe state is intentionally
   * process-local and short-lived: this is an interactive diagnostic, not delivery telemetry. */
  async createFcmProbe(userId: number, token: string): Promise<FcmProbeStatus> {
    this.pruneFcmProbes();
    const now = Date.now();
    const cooldownKey = `${userId}:${token}`;
    const lastProbeAt = this.fcmProbeCooldowns.get(cooldownKey) ?? 0;
    const retryAfterMs = 30_000 - (now - lastProbeAt);
    if (retryAfterMs > 0) {
      throw new BusinessException(
        BusinessCode.RATE_LIMITED,
        'FCM health check is cooling down',
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfter: Math.ceil(retryAfterMs / 1000) },
      );
    }

    const row = await this.database.db.query.pushToken.findFirst({
      where: and(
        eq(pushToken.userId, userId),
        eq(pushToken.token, token),
        eq(pushToken.platform, 'ANDROID'),
      ),
    });
    if (!row) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'current Android FCM token is not registered',
      );
    }

    this.fcmProbeCooldowns.set(cooldownKey, now);
    const probeId = randomUUID();
    const entry: FcmProbeEntry = {
      probeId,
      userId,
      token,
      stage: 'failed',
      createdAt: now,
      sending: true,
    };
    this.fcmProbes.set(probeId, entry);

    if (!this.messaging) {
      entry.errorCode = 'FCM_NOT_CONFIGURED';
      return this.publicFcmProbe(entry);
    }
    try {
      await this.messaging.send({
        token,
        data: { type: 'FCM_HEALTH_PROBE', probeId, ts: String(now) },
        android: { priority: 'high', ttl: 30_000 },
      });
      if (entry.stage !== 'device_received') entry.stage = 'fcm_accepted';
      entry.acceptedAt = Date.now();
    } catch (e) {
      entry.errorCode =
        (e as { code?: string }).code ??
        (e as Error).message ??
        'FCM_SEND_FAILED';
    } finally {
      entry.sending = false;
    }
    return this.publicFcmProbe(entry);
  }

  getFcmProbe(userId: number, probeId: string): FcmProbeStatus {
    this.pruneFcmProbes();
    const entry = this.fcmProbes.get(probeId);
    if (!entry || entry.userId !== userId) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'FCM health check not found',
      );
    }
    return this.publicFcmProbe(entry);
  }

  acknowledgeFcmProbe(userId: number, probeId: string): FcmProbeStatus {
    this.pruneFcmProbes();
    const entry = this.fcmProbes.get(probeId);
    if (!entry || entry.userId !== userId) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'FCM health check not found',
      );
    }
    if (entry.sending || entry.stage === 'fcm_accepted') {
      entry.stage = 'device_received';
      entry.receivedAt = Date.now();
      entry.latencyMs = entry.receivedAt - entry.createdAt;
    }
    return this.publicFcmProbe(entry);
  }

  private publicFcmProbe(entry: FcmProbeEntry): FcmProbeStatus {
    const {
      userId: _userId,
      token: _token,
      sending: _sending,
      ...status
    } = entry;
    return status;
  }

  private pruneFcmProbes(): void {
    const cutoff = Date.now() - 60_000;
    for (const [probeId, entry] of this.fcmProbes) {
      if (entry.createdAt < cutoff) this.fcmProbes.delete(probeId);
    }
    for (const [key, createdAt] of this.fcmProbeCooldowns) {
      if (createdAt < cutoff) this.fcmProbeCooldowns.delete(key);
    }
  }

  /** Send one Web Push notification, passing the VAPID details PER CALL from SettingsService (NOT the
   *  module-global setVapidDetails). Reading the (DB-backed) keypair on each send means an admin rotation
   *  takes effect immediately on the next send, with no restart and no event wiring. Throws if Web Push is
   *  not configured (the caller decides how to surface that); otherwise rethrows web-push's error, which
   *  carries `.statusCode` (404/410 = subscription gone). */
  private async sendWebPush(
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ): Promise<void> {
    const vapid = this.settings.getVapid();
    if (!vapid) throw new Error('Web Push not configured');
    await webpush.sendNotification(sub, payload, {
      vapidDetails: {
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
    });
  }

  /**
   * Fan out an identity-only wake-up for a freshly written message. Fire-and-forget from
   * MessageFanoutService (never awaited) — push latency must not delay the sender's HTTP response. Never
   * throws: every step is guarded so a push failure can never break message delivery.
   *
   * Recipient filtering: the caller (fanout) already excluded the sender + muted + blocked recipients;
   * here we additionally skip any recipient with a live SSE connection (SseService.isUserOnline — no
   * double-delivery, no wasted battery). Remaining targets each receive the SAME data-only payload
   * `{ type:'NEW_MESSAGE', ts, threadId, seq }`, branched by platform: ANDROID/IOS → FCM `sendEach`,
   * WEB → Web Push `sendNotification`. Per-token errors that indicate a definitively-dead subscription
   * (FCM UNREGISTERED / Web Push 404/410) are pruned; transient errors are left alone to self-heal.
   */
  async dispatchForMessage(
    targets: { userId: number }[],
    threadId: number,
    seq: number,
  ): Promise<void> {
    try {
      const userIds = targets
        .map((r) => r.userId)
        .filter((uid) => !this.sse.isUserOnline(uid));
      if (userIds.length === 0) return;

      const tokens = await this.database.db.query.pushToken.findMany({
        where: inArray(pushToken.userId, userIds),
        columns: {
          token: true,
          platform: true,
          webP256dh: true,
          webAuth: true,
        },
      });
      if (tokens.length === 0) return;

      // Identity-only wake-up — {type, ts, threadId, seq}. No body/preview/contentType/msgid: the client
      // pulls the body. FCM requires string values; Web Push carries the JSON-stringified form. No
      // `notification` field for FCM — its presence would make the OS show it itself and bypass
      // onMessageReceived on background.
      const data: Record<string, string> = {
        type: 'NEW_MESSAGE',
        ts: String(Date.now()),
        threadId: String(threadId),
        seq: String(seq),
      };

      const dead: string[] = [];
      // Branch by SUBSCRIPTION SHAPE, not the platform label: a Web Push subscription is identified by
      // having p256dh+auth keys — true for every browser/PWA context (desktop Chrome/Firefox/Safari,
      // Android webview PWA, AND iOS-Safari-installed-as-PWA). The platform enum is transport-oriented
      // (WEB = Web Push, ANDROID = FCM, IOS reserved for a hypothetical future native APNs app), so
      // iOS-PWA subs register as WEB and correctly route here. No native APNs path exists today.
      const webSubs = tokens.filter((t) => !!t.webP256dh && !!t.webAuth);
      const fcmTokens = tokens.filter((t) => !t.webP256dh || !t.webAuth);

      // FCM path (ANDROID / IOS).
      if (fcmTokens.length > 0 && this.messaging) {
        const messages: Message[] = fcmTokens.map((t) => ({
          token: t.token,
          data,
          android: { priority: 'high', ttl: 2_419_200 }, // 28 days — the FCM max retention window
        }));
        const res = await this.messaging.sendEach(messages);
        res.responses.forEach((r, i) => {
          if (
            !r.success &&
            r.error?.code === 'messaging/registration-token-not-registered'
          ) {
            dead.push(fcmTokens[i].token);
          }
        });
        const failed = res.failureCount - dead.length;
        if (failed > 0) {
          this.logger.warn(
            `FCM sendEach: ${failed} transient failure(s) (not pruned)`,
          );
        }
      }

      // Web Push path (browser/PWA). VAPID is read per send from SettingsService (file-backed,
      // admin-managed), so the gate is whether a keypair is configured. sendWebPush throws on failure →
      // 404/410 = subscription expired/gone (prune), anything else is transient.
      if (webSubs.length > 0 && this.settings.isWebPushConfigured) {
        const payload = JSON.stringify(data);
        await Promise.all(
          webSubs.map(async (s) => {
            try {
              await this.sendWebPush(
                {
                  endpoint: s.token,
                  keys: { p256dh: s.webP256dh!, auth: s.webAuth! },
                },
                payload,
              );
            } catch (e) {
              const code = (e as { statusCode?: number }).statusCode;
              if (code === 404 || code === 410) {
                dead.push(s.token);
              } else {
                this.logger.warn(
                  `Web Push transient failure (${code}): ${(e as Error).message}`,
                );
              }
            }
          }),
        );
      }

      if (dead.length > 0) {
        await this.database.db
          .delete(pushToken)
          .where(inArray(pushToken.token, dead));
        this.logger.debug(`pruned ${dead.length} stale push subscription(s)`);
      }
    } catch (e) {
      // Last-resort guard: a push failure must NEVER surface to the send path (it's fire-and-forget).
      this.logger.error(
        `push dispatchForMessage failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Fan out an INCOMING-CALL wake-up to a callee. Mirrors dispatchForMessage with two deliberate
   * differences for the ringing case:
   *  (1) NO skip-when-online — the phone must ring even when the callee's desktop has a live SSE
   *      connection. (dispatchForMessage skips online recipients because the message body is also
   *      delivered in-band over SSE; a ring, by contrast, must reach every device.)
   *  (2) type = 'CALL_INCOMING' carrying { ts, callSid, callerUserId, threadId, callType } so the
   *      client's call-handling layer (NOT the message-pull pipeline) wakes and surfaces the incoming-
   *      call UI. FCM ttl is short (30s) — a ring is ephemeral, so a stale wake-up must not outlive it.
   * Same FCM (data-only, high priority) + Web Push branch by subscription shape, same dead-token
   * pruning. Fire-and-forget from CallsService; never throws (a push failure must not break ringing).
   */
  async dispatchForCall(
    calleeUserId: number,
    payload: {
      callSid: string;
      callerUserId: number;
      callerName: string;
      callerAvatar: string;
      threadId: number;
      callType: 'AUDIO' | 'VIDEO';
    },
  ): Promise<void> {
    try {
      const tokens = await this.database.db.query.pushToken.findMany({
        where: eq(pushToken.userId, calleeUserId),
        columns: {
          token: true,
          platform: true,
          webP256dh: true,
          webAuth: true,
        },
      });
      if (tokens.length === 0) return;

      // Inline wake-up — the client's call layer consumes this directly (no body pull).
      const data: Record<string, string> = {
        type: 'CALL_INCOMING',
        ts: String(Date.now()),
        callSid: payload.callSid,
        callerUserId: String(payload.callerUserId),
        callerName: payload.callerName,
        callerAvatar: payload.callerAvatar,
        threadId: String(payload.threadId),
        callType: payload.callType,
      };

      const dead: string[] = [];
      // Same subscription-shape branch as dispatchForMessage.
      const webSubs = tokens.filter((t) => !!t.webP256dh && !!t.webAuth);
      const fcmTokens = tokens.filter((t) => !t.webP256dh || !t.webAuth);

      // FCM path (ANDROID / IOS).
      if (fcmTokens.length > 0 && this.messaging) {
        const messages: Message[] = fcmTokens.map((t) => ({
          token: t.token,
          data,
          android: { priority: 'high', ttl: 30_000 }, // 30s — a ring is ephemeral
        }));
        const res = await this.messaging.sendEach(messages);
        res.responses.forEach((r, i) => {
          if (
            !r.success &&
            r.error?.code === 'messaging/registration-token-not-registered'
          ) {
            dead.push(fcmTokens[i].token);
          }
        });
        const failed = res.failureCount - dead.length;
        if (failed > 0) {
          this.logger.warn(
            `FCM sendEach (call): ${failed} transient failure(s) (not pruned)`,
          );
        }
      }

      // Web Push path (browser/PWA).
      if (webSubs.length > 0 && this.settings.isWebPushConfigured) {
        const body = JSON.stringify(data);
        await Promise.all(
          webSubs.map(async (s) => {
            try {
              await this.sendWebPush(
                {
                  endpoint: s.token,
                  keys: { p256dh: s.webP256dh!, auth: s.webAuth! },
                },
                body,
              );
            } catch (e) {
              const code = (e as { statusCode?: number }).statusCode;
              if (code === 404 || code === 410) {
                dead.push(s.token);
              } else {
                this.logger.warn(
                  `Web Push transient failure (call, ${code}): ${(e as Error).message}`,
                );
              }
            }
          }),
        );
      }

      if (dead.length > 0) {
        await this.database.db
          .delete(pushToken)
          .where(inArray(pushToken.token, dead));
        this.logger.debug(
          `pruned ${dead.length} stale push subscription(s) (call)`,
        );
      }
    } catch (e) {
      // Fire-and-forget: a push failure must never break the call path.
      this.logger.error(`push dispatchForCall failed: ${(e as Error).message}`);
    }
  }

  // ── admin surface ────────────────────────────────────────────────────────────

  /** FCM transport configured (the conventional service-account file loaded successfully). */
  get fcmConfigured(): boolean {
    return this.messaging !== null;
  }

  /** Read-only metadata for the operator-provided Firebase credential. Never exposes credential content. */
  getFcmCredentialStatus() {
    if (!existsSync(this.fcmCredentialPath)) {
      return { configured: false, valid: false, reason: 'file not found' };
    }
    try {
      const raw = readFileSync(this.fcmCredentialPath, 'utf8');
      const value = JSON.parse(raw) as Record<string, unknown>;
      const valid =
        value.type === 'service_account' &&
        typeof value.project_id === 'string' &&
        typeof value.client_email === 'string' &&
        typeof value.private_key === 'string';
      const stat = statSync(this.fcmCredentialPath);
      return {
        configured: true,
        valid,
        projectId:
          typeof value.project_id === 'string' ? value.project_id : undefined,
        clientEmail:
          typeof value.client_email === 'string'
            ? value.client_email
            : undefined,
        fingerprint: createHash('sha256')
          .update(raw)
          .digest('hex')
          .slice(0, 16),
        createdAt: stat.birthtime.toISOString(),
        permissionsSecure: (stat.mode & 0o077) === 0,
        reason: valid ? undefined : 'invalid Firebase service-account JSON',
      };
    } catch {
      return {
        configured: true,
        valid: false,
        reason: 'invalid Firebase service-account JSON',
      };
    }
  }
  /** Web Push transport configured (the managed VAPID key file loaded successfully). */
  get webPushConfigured(): boolean {
    return this.settings.isWebPushConfigured;
  }

  /** Admin: paginated device-token list with the owning user's id + account, optional fuzzy search
   *  over account / token / deviceId. Newest lastSeen first. */
  async listTokens(opts: {
    skip: number;
    take: number;
    search?: string;
  }): Promise<{
    list: Array<{
      id: number;
      userId: number;
      platform: string;
      token: string;
      deviceId: string | null;
      createdAt: Date;
      lastSeenAt: Date;
      user: { id: number; account: string } | null;
    }>;
    total: number;
  }> {
    const search = opts.search?.trim();
    const where: SQL | undefined = search
      ? or(
          ilike(user.account, `%${search}%`),
          ilike(pushToken.token, `%${search}%`),
          ilike(pushToken.deviceId, `%${search}%`),
        )
      : undefined;
    const [rows, total] = await Promise.all([
      this.database.db
        .select({ token: pushToken, userId: user.id, account: user.account })
        .from(pushToken)
        .leftJoin(user, eq(user.id, pushToken.userId))
        .where(where)
        .orderBy(desc(pushToken.lastSeenAt))
        .offset(opts.skip)
        .limit(opts.take),
      this.database.db
        .select({ value: count() })
        .from(pushToken)
        .leftJoin(user, eq(user.id, pushToken.userId))
        .where(where)
        .then((result) => result[0]?.value ?? 0),
    ]);
    const list = rows.map(({ token, userId, account }) => ({
      ...token,
      user:
        userId === null || account === null ? null : { id: userId, account },
    }));
    return { list, total };
  }

  /** Admin: delete a device token by id (unregister). Idempotent via deleteMany. */
  async deleteTokenById(tokenId: number): Promise<void> {
    await this.database.db.delete(pushToken).where(eq(pushToken.id, tokenId));
  }

  /** Admin: send a one-off test push to a specific device token (looked up by id) to verify delivery.
   *  Routes by subscription shape — FCM (`send`) for ANDROID/IOS, Web Push for browser subs. The payload
   *  carries `type: 'admin-test'` so the client posts the literal title/body as a notification (a delivery
   *  check) instead of triggering a real message wake-up. Returns `{ ok, error? }`; never throws. */
  async sendTestPush(
    tokenId: number,
    title: string,
    body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const row = await this.database.db.query.pushToken.findFirst({
      where: eq(pushToken.id, tokenId),
    });
    if (!row) return { ok: false, error: 'token not found' };
    const isWeb = !!row.webP256dh && !!row.webAuth;
    try {
      if (isWeb) {
        await this.sendWebPush(
          {
            endpoint: row.token,
            keys: { p256dh: row.webP256dh!, auth: row.webAuth! },
          },
          JSON.stringify({
            type: 'ADMIN_TEST',
            ts: String(Date.now()),
            title,
            body,
          }),
        );
        return { ok: true };
      }
      if (!this.messaging) return { ok: false, error: 'FCM not configured' };
      await this.messaging.send({
        token: row.token,
        data: { type: 'ADMIN_TEST', ts: String(Date.now()), title, body },
        android: { priority: 'high' },
      });
      return { ok: true };
    } catch (e) {
      // A definitively-dead FCM token surfaces here — prune it so the list self-cleans.
      if (
        (e as { code?: string }).code ===
        'messaging/registration-token-not-registered'
      ) {
        await this.database.db
          .delete(pushToken)
          .where(eq(pushToken.id, tokenId));
      }
      return { ok: false, error: (e as Error).message };
    }
  }
}
