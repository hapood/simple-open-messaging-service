import { Injectable, Logger } from '@nestjs/common';
import { applicationDefault, getApps, getApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging, type Message } from 'firebase-admin/messaging';
import webpush from 'web-push';
import { PrismaService } from '../prisma.service.js';
import { SseService } from '../gateway/sse.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { RegisterDeviceDto } from '../dto/device.dto.js';

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
 * Degradation: each transport is independently gated on its own config — GOOGLE_APPLICATION_CREDENTIALS
 * (env) for FCM, the DB-backed VAPID keypair (SettingsService, admin-managed) for Web Push. Either missing
 * → that transport no-ops (the other still works; both missing → SSE-only, the local/dev path).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly messaging: Messaging | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sse: SseService,
    private readonly settings: SettingsService,
  ) {
    // FCM: applicationDefault() reads the service-account JSON at GOOGLE_APPLICATION_CREDENTIALS. FCM is
    // a file-path credential (a whole service-account JSON), so it stays env/file-based — NOT admin-UI
    // managed like VAPID.
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const app = getApps().length
        ? getApp()
        : initializeApp({ credential: applicationDefault() });
      this.messaging = getMessaging(app);
      this.logger.log('FCM messaging initialized from GOOGLE_APPLICATION_CREDENTIALS');
    } else {
      this.messaging = null;
      this.logger.warn('GOOGLE_APPLICATION_CREDENTIALS unset — FCM dispatch disabled');
    }
    // Web Push: VAPID keys are now DB-backed (SettingsService, admin-managed) and passed PER SEND as the
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
    await this.prisma.pushToken.upsert({
      where: { token: dto.token },
      create: {
        userId,
        token: dto.token,
        platform: dto.platform,
        deviceId: dto.deviceId,
        webP256dh: dto.p256dh,
        webAuth: dto.auth,
      },
      update: {
        userId,
        platform: dto.platform,
        deviceId: dto.deviceId,
        webP256dh: dto.p256dh,
        webAuth: dto.auth,
        lastSeenAt: new Date(),
      },
    });
  }

  /** Remove a registration token. Scoped to the caller — a user cannot unregister another user's device.
   *  deleteMany (not delete) so a not-found / wrong-owner call is a no-op rather than throwing. */
  async unregisterToken(userId: number, token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({
      where: { token, userId },
    });
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

      const tokens = await this.prisma.pushToken.findMany({
        where: { userId: { in: userIds } },
        select: { token: true, platform: true, webP256dh: true, webAuth: true },
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
          this.logger.warn(`FCM sendEach: ${failed} transient failure(s) (not pruned)`);
        }
      }

      // Web Push path (browser/PWA). VAPID is read per send from SettingsService (DB-backed,
      // admin-managed), so the gate is whether a keypair is configured. sendWebPush throws on failure →
      // 404/410 = subscription expired/gone (prune), anything else is transient.
      if (webSubs.length > 0 && this.settings.isWebPushConfigured) {
        const payload = JSON.stringify(data);
        await Promise.all(
          webSubs.map(async (s) => {
            try {
              await this.sendWebPush(
                { endpoint: s.token, keys: { p256dh: s.webP256dh!, auth: s.webAuth! } },
                payload,
              );
            } catch (e) {
              const code = (e as { statusCode?: number }).statusCode;
              if (code === 404 || code === 410) {
                dead.push(s.token);
              } else {
                this.logger.warn(`Web Push transient failure (${code}): ${(e as Error).message}`);
              }
            }
          }),
        );
      }

      if (dead.length > 0) {
        await this.prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
        this.logger.debug(`pruned ${dead.length} stale push subscription(s)`);
      }
    } catch (e) {
      // Last-resort guard: a push failure must NEVER surface to the send path (it's fire-and-forget).
      this.logger.error(`push dispatchForMessage failed: ${(e as Error).message}`);
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
      threadId: number;
      callType: 'AUDIO' | 'VIDEO';
    },
  ): Promise<void> {
    try {
      const tokens = await this.prisma.pushToken.findMany({
        where: { userId: calleeUserId },
        select: { token: true, platform: true, webP256dh: true, webAuth: true },
      });
      if (tokens.length === 0) return;

      // Inline wake-up — the client's call layer consumes this directly (no body pull).
      const data: Record<string, string> = {
        type: 'CALL_INCOMING',
        ts: String(Date.now()),
        callSid: payload.callSid,
        callerUserId: String(payload.callerUserId),
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
          this.logger.warn(`FCM sendEach (call): ${failed} transient failure(s) (not pruned)`);
        }
      }

      // Web Push path (browser/PWA).
      if (webSubs.length > 0 && this.settings.isWebPushConfigured) {
        const body = JSON.stringify(data);
        await Promise.all(
          webSubs.map(async (s) => {
            try {
              await this.sendWebPush(
                { endpoint: s.token, keys: { p256dh: s.webP256dh!, auth: s.webAuth! } },
                body,
              );
            } catch (e) {
              const code = (e as { statusCode?: number }).statusCode;
              if (code === 404 || code === 410) {
                dead.push(s.token);
              } else {
                this.logger.warn(`Web Push transient failure (call, ${code}): ${(e as Error).message}`);
              }
            }
          }),
        );
      }

      if (dead.length > 0) {
        await this.prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
        this.logger.debug(`pruned ${dead.length} stale push subscription(s) (call)`);
      }
    } catch (e) {
      // Fire-and-forget: a push failure must never break the call path.
      this.logger.error(`push dispatchForCall failed: ${(e as Error).message}`);
    }
  }

  // ── admin surface ────────────────────────────────────────────────────────────

  /** FCM transport configured (GOOGLE_APPLICATION_CREDENTIALS set + firebase-admin initialized). */
  get fcmConfigured(): boolean {
    return this.messaging !== null;
  }
  /** Web Push transport configured (a VAPID keypair is set in the settings DB). */
  get webPushConfigured(): boolean {
    return this.settings.isWebPushConfigured;
  }

  /** Admin: paginated device-token list with the owning user's id + account, optional fuzzy search
   *  over account / token / deviceId. Newest lastSeen first. */
  async listTokens(opts: { skip: number; take: number; search?: string }): Promise<{
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
    const where = search
      ? {
          OR: [
            { user: { account: { contains: search, mode: 'insensitive' as const } } },
            { token: { contains: search } },
            { deviceId: { contains: search } },
          ],
        }
      : undefined;
    const [list, total] = await Promise.all([
      this.prisma.pushToken.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        skip: opts.skip,
        take: opts.take,
        include: { user: { select: { id: true, account: true } } },
      }),
      this.prisma.pushToken.count({ where }),
    ]);
    return { list, total };
  }

  /** Admin: delete a device token by id (unregister). Idempotent via deleteMany. */
  async deleteTokenById(tokenId: number): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { id: tokenId } });
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
    const row = await this.prisma.pushToken.findUnique({ where: { id: tokenId } });
    if (!row) return { ok: false, error: 'token not found' };
    const isWeb = !!row.webP256dh && !!row.webAuth;
    try {
      if (isWeb) {
        await this.sendWebPush(
          { endpoint: row.token, keys: { p256dh: row.webP256dh!, auth: row.webAuth! } },
          JSON.stringify({ type: 'ADMIN_TEST', ts: String(Date.now()), title, body }),
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
      if ((e as { code?: string }).code === 'messaging/registration-token-not-registered') {
        await this.prisma.pushToken.deleteMany({ where: { id: tokenId } });
      }
      return { ok: false, error: (e as Error).message };
    }
  }
}
