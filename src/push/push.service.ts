import { Injectable, Logger } from '@nestjs/common';
import { applicationDefault, getApps, getApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging, type Message } from 'firebase-admin/messaging';
import webpush from 'web-push';
import { PrismaService } from '../prisma.service.js';
import { SseService } from '../gateway/sse.service.js';
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
 * Degradation: each transport is independently gated on its env config — GOOGLE_APPLICATION_CREDENTIALS
 * for FCM, VAPID_* for Web Push. Either missing → that transport no-ops (the other still works; both
 * missing → SSE-only, the local/dev path).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly messaging: Messaging | null;
  private readonly webPushEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sse: SseService,
  ) {
    // FCM: applicationDefault() reads the service-account JSON at GOOGLE_APPLICATION_CREDENTIALS.
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
    // Web Push: setVapidDetails is module-global; call once. VAPID_SUBJECT should be a mailto: or URL
    // contact (per RFC 8292) — the push service surfaces it to the subscriber for identity.
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT ?? 'mailto:noreply@soms.local',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY,
      );
      this.webPushEnabled = true;
      this.logger.log('Web Push initialized from VAPID_* keys');
    } else {
      this.webPushEnabled = false;
      this.logger.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY unset — Web Push dispatch disabled');
    }
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

  /**
   * Fan out a wake-up signal for a freshly written message. Fire-and-forget from
   * MessageController.sendMessage (never awaited) — push latency must not delay the sender's HTTP
   * response. Never throws: every step is guarded so a push failure can never break message delivery.
   *
   * Recipient filtering: exclude the sender (their own SSE echo already syncs their other devices) and
   * any recipient with a live SSE connection (SseService.isUserOnline — no double-delivery, no wasted
   * battery). Remaining targets are looked up by userId and each token receives an identical data
   * payload, branched by platform: ANDROID/IOS → FCM `sendEach`, WEB → Web Push `sendNotification`.
   * Per-token errors that indicate a definitively-dead subscription (FCM UNREGISTERED / Web Push 404/410)
   * are pruned; transient errors are left alone to self-heal on retry.
   */
  async dispatchForMessage(
    recipientUserIds: { userId: number }[],
    senderId: number,
    threadId: number,
    msgData: { id?: string | number; contentType?: string; content?: string },
  ): Promise<void> {
    try {
      const targets = recipientUserIds
        .map((r) => r.userId)
        .filter((uid) => uid !== senderId && !this.sse.isUserOnline(uid));
      if (targets.length === 0) return;

      const tokens = await this.prisma.pushToken.findMany({
        where: { userId: { in: targets } },
        select: { token: true, platform: true, webP256dh: true, webAuth: true },
      });
      if (tokens.length === 0) return;

      // Data-only wake-up signal — identical fields across transports. FCM requires string values;
      // Web Push carries the JSON-stringified form. `messageId` is the BigInt→string id from
      // serializeBody. Preview is included only for PURE_TEXT (truncated) as a notification teaser;
      // non-text types let the client derive a content-type label. No `notification` field for FCM —
      // its presence would make the OS show it itself and bypass onMessageReceived on background.
      const data: Record<string, string> = {
        threadId: String(threadId),
        messageId: String(msgData.id ?? ''),
        contentType: String(msgData.contentType ?? ''),
        ts: String(Date.now()),
      };
      if (msgData.contentType === 'PURE_TEXT' && typeof msgData.content === 'string') {
        data.preview = msgData.content.slice(0, 120);
      }

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

      // Web Push path (browser/PWA). sendNotification throws on failure → 404/410 = subscription
      // expired/gone (prune), anything else is transient.
      if (webSubs.length > 0 && this.webPushEnabled) {
        const payload = JSON.stringify(data);
        await Promise.all(
          webSubs.map(async (s) => {
            try {
              await webpush.sendNotification(
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

  // ── admin surface ────────────────────────────────────────────────────────────

  /** FCM transport configured (GOOGLE_APPLICATION_CREDENTIALS set + firebase-admin initialized). */
  get fcmConfigured(): boolean {
    return this.messaging !== null;
  }
  /** Web Push transport configured (VAPID_* keys set). */
  get webPushConfigured(): boolean {
    return this.webPushEnabled;
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
        if (!this.webPushEnabled) return { ok: false, error: 'Web Push not configured' };
        await webpush.sendNotification(
          { endpoint: row.token, keys: { p256dh: row.webP256dh!, auth: row.webAuth! } },
          JSON.stringify({ type: 'admin-test', title, body }),
        );
        return { ok: true };
      }
      if (!this.messaging) return { ok: false, error: 'FCM not configured' };
      await this.messaging.send({
        token: row.token,
        data: { type: 'admin-test', title, body },
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
