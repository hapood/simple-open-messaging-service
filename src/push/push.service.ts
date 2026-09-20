import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { configDirectory } from '../common/data-directory.js';
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
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
  isNotNull,
  isNull,
  gt,
  sql,
  type SQL,
} from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { sessionToken, account as user } from '../database/schema.js';
import {
  clearPushRegistration,
  pushRegistrationFields,
} from './push-registration.js';
import { SettingsService } from '../settings/settings.service.js';
import { SseService } from '../gateway/sse.service.js';
import { RegisterDeviceDto } from '../dto/device.dto.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { AccountFeedThrottle } from '../common/account-feed-throttle.js';

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

type SessionPushRegistration = {
  token: string;
  platform: string;
  userId: number;
  sessionId: number;
  pushSubscriptionRev: number;
  expiresAt: Date;
  revokedAt: Date | null;
};

/**
 * Multi-platform push delivery — the wake-up channel that complements SSE.
 *
 * Committed fanout results wake connected clients through their durable Thread Feed. Count or preview
 * changes independently enter a five-second account throttle. PushService sends the `NEW_MESSAGE`
 * data-only payload to registered target sessions that do not currently own a live
 * SSE connection. An online session takes over notification aggregation from its State Feed; other devices
 * remain independently eligible. Duplicate wake delivery is harmless because the pull pipeline is idempotent.
 *
 * Two transports, branched by `SessionToken.pushPlatform`:
 *  - ANDROID / IOS → firebase-admin `sendEach` (data-only, high priority).
 *  - WEB           → `web-push` lib (standard Web Push + VAPID), payload is the JSON-stringified signal.
 *
 * Degradation: each transport is independently gated on its own config — the operator-provided
 * data/firebase-service-account.json for FCM and the managed VAPID keypair for Web Push. Either missing
 * → that transport no-ops (the other still works; both missing → SSE-only, the local/dev path).
 */
@Injectable()
export class PushService implements OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  private readonly messaging: Messaging | null;
  private readonly fcmCredentialPath: string;
  private readonly fcmProbes = new Map<string, FcmProbeEntry>();
  private readonly fcmProbeCooldowns = new Map<string, number>();
  private readonly messageThrottle = new AccountFeedThrottle(
    5_000,
    (userId, threadFeedEndId) =>
      this.dispatchForMessage([{ userId, threadFeedEndId }]),
    (error) => this.logger.warn(`Thread push hint failed: ${String(error)}`),
  );

  /** Only notification-relevant projection changes enter this account window.
   * Session validity and SSE ownership are checked by dispatch at send time. */
  enqueueForMessage(
    targets: { userId: number; threadFeedEndId: number }[],
  ): void {
    for (const { userId, threadFeedEndId } of targets)
      this.messageThrottle.enqueue(userId, threadFeedEndId);
  }

  onModuleDestroy(): void {
    this.messageThrottle.stop();
  }

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
      configDirectory('firebase-service-account.json');
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
    // VAPID credentials are loaded from the managed file at boot and passed per send.
  }

  /** The authenticated session owns one registration. A stale generation never
   * replaces current state, including requests that crossed a logout/login. */
  async registerToken(
    userId: number,
    sessionId: number,
    dto: RegisterDeviceDto,
  ): Promise<{
    sessionId: number;
    pushSubscriptionRev: number;
    registered: boolean;
  }> {
    if (dto.sessionId !== sessionId)
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'push session changed',
      );
    if (dto.platform === 'WEB' && (!dto.p256dh || !dto.auth))
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'Web Push requires encryption keys',
      );
    return this.database.db.transaction(async (tx) => {
      // Serialize transfers of the same installation token, including when it
      // is not yet stored. Session locks are always acquired in ID order.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${dto.token}, 74129))`,
      );
      const rows = await tx
        .select()
        .from(sessionToken)
        .where(
          or(
            eq(sessionToken.id, sessionId),
            eq(sessionToken.pushToken, dto.token),
          ),
        )
        .orderBy(sessionToken.id)
        .for('no key update');
      const current = rows.find(
        (row) => row.id === sessionId && row.userId === userId,
      );
      if (!current || current.revokedAt || current.expiresAt <= new Date())
        throw new BusinessException(
          BusinessCode.SESSION_REVOKED,
          'session is no longer active',
        );
      if (current.pushSubscriptionRev !== dto.pushSubscriptionRev)
        return {
          sessionId,
          pushSubscriptionRev: current.pushSubscriptionRev,
          registered: false,
        };
      // A delayed request from an older login must not steal a newer login's token.
      if (rows.some((row) => row.id > sessionId && row.pushToken === dto.token))
        throw new BusinessException(
          BusinessCode.ALREADY_EXISTS,
          'push token belongs to a newer session',
        );
      for (const row of rows) {
        if (row.id !== sessionId && row.pushToken === dto.token)
          await tx
            .update(sessionToken)
            .set(clearPushRegistration)
            .where(eq(sessionToken.id, row.id));
      }
      await tx
        .update(sessionToken)
        .set({
          pushToken: dto.token,
          pushPlatform: dto.platform,
          pushDeviceId: dto.deviceId ?? null,
          pushP256dh: dto.platform === 'WEB' ? dto.p256dh! : null,
          pushAuth: dto.platform === 'WEB' ? dto.auth! : null,
          pushRegisteredAt: new Date(),
        })
        .where(eq(sessionToken.id, sessionId));
      return {
        sessionId,
        pushSubscriptionRev: current.pushSubscriptionRev,
        registered: true,
      };
    });
  }

  /** Compare the exact send snapshot so a late failure cannot invalidate a
   * replacement. Concurrent failures increment the generation only once. */
  async invalidateSubscription(
    snapshot: Pick<
      SessionPushRegistration,
      'sessionId' | 'userId' | 'token' | 'pushSubscriptionRev'
    >,
  ): Promise<void> {
    const [changed] = await this.database.db
      .update(sessionToken)
      .set({
        ...clearPushRegistration,
        pushSubscriptionRev: sql`${sessionToken.pushSubscriptionRev} + 1`,
      })
      .where(
        and(
          eq(sessionToken.id, snapshot.sessionId),
          eq(sessionToken.userId, snapshot.userId),
          eq(sessionToken.pushToken, snapshot.token),
          eq(sessionToken.pushSubscriptionRev, snapshot.pushSubscriptionRev),
          isNull(sessionToken.revokedAt),
        ),
      )
      .returning({ pushSubscriptionRev: sessionToken.pushSubscriptionRev });
    if (changed)
      this.sse.onPushSubscriptionChanged(
        snapshot.userId,
        snapshot.sessionId,
        changed.pushSubscriptionRev,
      );
  }

  private async registrations(where?: SQL) {
    const rows = await this.database.db
      .select(pushRegistrationFields)
      .from(sessionToken)
      .where(
        and(
          where,
          isNotNull(sessionToken.pushToken),
          isNull(sessionToken.revokedAt),
          gt(sessionToken.expiresAt, new Date()),
        ),
      );
    return rows.filter(
      (
        row,
      ): row is typeof row & {
        token: string;
        platform: NonNullable<typeof row.platform>;
        lastSeenAt: Date;
      } =>
        row.token !== null && row.platform !== null && row.lastSeenAt !== null,
    );
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

    const [row] = await this.registrations(
      and(
        eq(sessionToken.userId, userId),
        eq(sessionToken.pushToken, token),
        eq(sessionToken.pushPlatform, 'ANDROID'),
      ),
    );
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
      if (entry.errorCode === 'messaging/registration-token-not-registered')
        await this.invalidateSubscription(row);
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

  /** Session authorization and exact-session SSE ownership gate out-of-band delivery. */
  private canDeliverOutOfBand(
    token: SessionPushRegistration,
    now: Date,
  ): boolean {
    return (
      token.revokedAt === null &&
      token.expiresAt > now &&
      !this.sse.isSessionOnline(token.userId, token.sessionId)
    );
  }

  /** Encrypt for the subscription and authenticate with the managed VAPID keypair. */
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
   * Deliver one admitted round of identity-only wake-ups. The account throttle
   * invokes this outside durable fanout completion and the HTTP send path.
   * Provider failures are logged and never propagated to the caller.
   *
   * Recipient filtering: only count or preview changes enter the throttle.
   * A token is suppressed only when its exact authenticated session owns a live SSE connection; that device
   * takes over notification aggregation from `STATE_FEED_UPDATED`. Other devices receive the same payload
   * `{ type:'NEW_MESSAGE', threadFeedEndId }`, branched by platform: ANDROID/IOS → FCM `sendEach`,
   * WEB → Web Push `sendNotification`. Per-token errors that indicate a definitively-dead subscription
   * (FCM UNREGISTERED / Web Push 404/410) are cleared and advance the session revision; other errors preserve registration.
   */
  async dispatchForMessage(
    targets: { userId: number; threadFeedEndId: number }[],
  ): Promise<void> {
    try {
      const heads = new Map<number, number>();
      for (const target of targets) {
        if (
          !Number.isInteger(target.threadFeedEndId) ||
          target.threadFeedEndId < 0 ||
          target.threadFeedEndId > 2_147_483_647
        )
          throw new Error('Invalid thread feed push target');
        heads.set(
          target.userId,
          Math.max(heads.get(target.userId) ?? 0, target.threadFeedEndId),
        );
      }
      const userIds = [...heads.keys()];
      if (userIds.length === 0) return;

      const tokens = await this.registrations(
        inArray(sessionToken.userId, userIds),
      );
      const now = new Date();
      const deliverableTokens = tokens.filter((token) =>
        this.canDeliverOutOfBand(token, now),
      );
      if (deliverableTokens.length === 0) return;

      // Identity-only wake-up — {type, threadFeedEndId}. No body/preview/contentType/msgid: the client
      // pulls the body. FCM requires string values; Web Push carries the JSON-stringified form. No
      // `notification` field for FCM — its presence would make the OS show it itself and bypass
      // onMessageReceived on background.
      const dataFor = (userId: number): Record<string, string> => ({
        type: 'NEW_MESSAGE',
        threadFeedEndId: String(heads.get(userId)!),
      });

      const dead: SessionPushRegistration[] = [];
      // Branch by SUBSCRIPTION SHAPE, not the platform label: a Web Push subscription is identified by
      // having p256dh+auth keys — true for every browser/PWA context (desktop Chrome/Firefox/Safari,
      // Android webview PWA, AND iOS-Safari-installed-as-PWA). The platform enum is transport-oriented
      // (WEB = Web Push, ANDROID = FCM, IOS reserved for a hypothetical future native APNs app), so
      // iOS-PWA subs register as WEB and correctly route here. No native APNs path exists today.
      const webSubs = deliverableTokens.filter(
        (token) => !!token.webP256dh && !!token.webAuth,
      );
      const fcmTokens = deliverableTokens.filter(
        (token) => !token.webP256dh || !token.webAuth,
      );

      // FCM path (ANDROID / IOS).
      if (fcmTokens.length > 0 && this.messaging) {
        const messages: Message[] = fcmTokens.map((t) => ({
          token: t.token,
          data: dataFor(t.userId),
          android: { priority: 'high', ttl: 2_419_200 }, // 28 days — the FCM max retention window
        }));
        const res = await this.messaging.sendEach(messages);
        res.responses.forEach((r, i) => {
          if (
            !r.success &&
            r.error?.code === 'messaging/registration-token-not-registered'
          ) {
            dead.push(fcmTokens[i]);
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
        await Promise.all(
          webSubs.map(async (s) => {
            try {
              await this.sendWebPush(
                {
                  endpoint: s.token,
                  keys: { p256dh: s.webP256dh!, auth: s.webAuth! },
                },
                JSON.stringify(dataFor(s.userId)),
              );
            } catch (e) {
              const code = (e as { statusCode?: number }).statusCode;
              if (code === 404 || code === 410) {
                dead.push(s);
              } else {
                this.logger.warn(
                  `Web Push transient failure (${code}): ${(e as Error).message}`,
                );
              }
            }
          }),
        );
      }

      for (const snapshot of dead) await this.invalidateSubscription(snapshot);
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
   *  (1) The phone must ring on every eligible offline device even when another device has a live SSE
   *      connection. As with message Push, foreground suppression is exact-session and device-local.
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
      callerUserId: number | null;
      /** Web Push has no native SQLite cache; Android FCM deliberately omits these fields. */
      callerName: string;
      callerAvatar: string;
      callerAccount: string;
      callerDomain: string;
      threadId: number;
      callType: 'AUDIO' | 'VIDEO';
    },
  ): Promise<void> {
    try {
      const tokens = await this.registrations(
        eq(sessionToken.userId, calleeUserId),
      );
      const now = new Date();
      const deliverableTokens = tokens.filter((token) =>
        this.canDeliverOutOfBand(token, now),
      );
      if (deliverableTokens.length === 0) return;

      // Inline wake-up — the client's call layer consumes this directly (no body pull).
      const data: Record<string, string> = {
        type: 'CALL_INCOMING',
        ts: String(Date.now()),
        callSid: payload.callSid,
        callerUserId:
          payload.callerUserId === null ? '' : String(payload.callerUserId),
        callerAccount: payload.callerAccount,
        callerDomain: payload.callerDomain,
        threadId: String(payload.threadId),
        callType: payload.callType,
      };

      const dead: SessionPushRegistration[] = [];
      // Same subscription-shape branch as dispatchForMessage.
      const webSubs = deliverableTokens.filter(
        (t) => !!t.webP256dh && !!t.webAuth,
      );
      const fcmTokens = deliverableTokens.filter(
        (t) => !t.webP256dh || !t.webAuth,
      );

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
            dead.push(fcmTokens[i]);
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
        const body = JSON.stringify({
          ...data,
          callerName: payload.callerName,
          callerAvatar: payload.callerAvatar,
        });
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
                dead.push(s);
              } else {
                this.logger.warn(
                  `Web Push transient failure (call, ${code}): ${(e as Error).message}`,
                );
              }
            }
          }),
        );
      }

      for (const snapshot of dead) await this.invalidateSubscription(snapshot);
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
        createdAt: stat.birthtimeMs,
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
    const where = and(
      isNotNull(sessionToken.pushToken),
      isNull(sessionToken.revokedAt),
      gt(sessionToken.expiresAt, new Date()),
      search
        ? or(
            ilike(user.account, `%${search}%`),
            ilike(sessionToken.pushToken, `%${search}%`),
            ilike(sessionToken.pushDeviceId, `%${search}%`),
          )
        : undefined,
    );
    const [rows, total] = await Promise.all([
      this.database.db
        .select({
          token: pushRegistrationFields,
          userId: user.id,
          account: user.account,
        })
        .from(sessionToken)
        .leftJoin(user, eq(user.id, sessionToken.userId))
        .where(where)
        .orderBy(desc(sessionToken.pushRegisteredAt))
        .offset(opts.skip)
        .limit(opts.take),
      this.database.db
        .select({ value: count() })
        .from(sessionToken)
        .leftJoin(user, eq(user.id, sessionToken.userId))
        .where(where)
        .then((result) => result[0]?.value ?? 0),
    ]);
    const list = rows.map(({ token, userId, account }) => ({
      ...token,
      token: token.token!,
      platform: token.platform!,
      lastSeenAt: token.lastSeenAt!,
      user:
        userId === null || account === null ? null : { id: userId, account },
    }));
    return { list, total };
  }

  /** Administrative removal clears delivery without revoking the login or
   * requesting immediate recovery. A later client bootstrap may register again. */
  async deleteTokenById(tokenId: number): Promise<void> {
    await this.database.db
      .update(sessionToken)
      .set(clearPushRegistration)
      .where(eq(sessionToken.id, tokenId));
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
    const [row] = await this.registrations(eq(sessionToken.id, tokenId));
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
      // Both transports use the same conditional invalidation and SSE recovery path.
      if (
        (e as { code?: string }).code ===
          'messaging/registration-token-not-registered' ||
        (isWeb && [404, 410].includes((e as { statusCode: number }).statusCode))
      ) {
        await this.invalidateSubscription(row);
      }
      return { ok: false, error: (e as Error).message };
    }
  }
}
