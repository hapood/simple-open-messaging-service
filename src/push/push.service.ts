import { Injectable, Logger } from '@nestjs/common';
import { applicationDefault, getApps, getApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging, type Message } from 'firebase-admin/messaging';
import { PrismaService } from '../prisma.service.js';
import { SseService } from '../gateway/sse.service.js';
import { RegisterDeviceDto } from '../dto/device.dto.js';

/**
 * FCM push delivery — the wake-up channel that complements SSE.
 *
 * Design (see plans/virtual-forging-fairy.md): on every NEW_MESSAGE the server fans out an SSE signal
 * to online recipients; PushService fans out a data-only FCM message to OFFLINE recipients only
 * (skip-when-online). FCM is a *transport for the same wake-up signal* — the client's pull pipeline is
 * already idempotent at three layers, so a duplicate SSE+FCM pull collapses silently. Data-only + high
 * priority keeps the canonical Message row as the single source of truth and lets the client build the
 * visible notification (full theming, foreground suppression, deep-link routing).
 *
 * Degradation: with GOOGLE_APPLICATION_CREDENTIALS unset, `messaging` is null and dispatch is a no-op —
 * the app falls back to SSE-only. This is the local/dev path; production sets the env var.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly messaging: Messaging | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sse: SseService,
  ) {
    // applicationDefault() reads the service-account JSON at GOOGLE_APPLICATION_CREDENTIALS. We gate
    // on the env var so a missing credential degrades to SSE-only rather than throwing on every send.
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const app = getApps().length
        ? getApp()
        : initializeApp({ credential: applicationDefault() });
      this.messaging = getMessaging(app);
      this.logger.log('FCM messaging initialized from GOOGLE_APPLICATION_CREDENTIALS');
    } else {
      this.messaging = null;
      this.logger.warn('GOOGLE_APPLICATION_CREDENTIALS unset — FCM dispatch disabled (SSE-only)');
    }
  }

  /** Upsert a registration token for the authenticated user. `token` is globally unique (one row per
   *  device), so the upsert re-owns the row to the current user on an account switch on the same device
   *  and bumps lastSeenAt on every re-register (token rotation, app upgrade, periodic heartbeat). */
  async registerToken(userId: number, dto: RegisterDeviceDto): Promise<void> {
    await this.prisma.pushToken.upsert({
      where: { token: dto.token },
      create: {
        userId,
        token: dto.token,
        platform: dto.platform,
        deviceId: dto.deviceId,
      },
      update: {
        userId,
        platform: dto.platform,
        deviceId: dto.deviceId,
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
   * Fan out a data-only FCM message for a freshly written message. Fire-and-forget from
   * MessageController.sendMessage (never awaited) — push latency must not delay the sender's HTTP
   * response. Never throws: every step is guarded so a push failure can never break message delivery.
   *
   * Recipient filtering: exclude the sender (their own SSE echo already syncs their other devices) and
   * any recipient with a live SSE connection (SseService.isUserOnline — no double-delivery, no wasted
   * battery). Remaining targets are looked up by userId and each token receives an identical data
   * payload; sendEach returns a per-token result so UNREGISTERED tokens are pruned (transient errors
   * are left alone — they self-heal on retry).
   */
  async dispatchForMessage(
    recipientUserIds: { userId: number }[],
    senderId: number,
    threadId: number,
    msgData: { id?: string | number; contentType?: string; content?: string },
  ): Promise<void> {
    if (!this.messaging) return;
    try {
      const targets = recipientUserIds
        .map((r) => r.userId)
        .filter((uid) => uid !== senderId && !this.sse.isUserOnline(uid));
      if (targets.length === 0) return;

      const tokens = await this.prisma.pushToken.findMany({
        where: { userId: { in: targets } },
        select: { token: true },
      });
      if (tokens.length === 0) return;

      // Data-only: every value MUST be a string (FCM requirement). `messageId` is the BigInt→string id
      // already produced by serializeBody. Preview is included only for PURE_TEXT (truncated) so the
      // system notification can show a teaser; non-text types fall back to a content-type label the
      // client derives. No `notification` field — its presence would make the OS show the notification
      // itself and bypass onMessageReceived on background delivery, defeating client-built display.
      const data: Record<string, string> = {
        threadId: String(threadId),
        messageId: String(msgData.id ?? ''),
        contentType: String(msgData.contentType ?? ''),
        ts: String(Date.now()),
      };
      if (msgData.contentType === 'PURE_TEXT' && typeof msgData.content === 'string') {
        data.preview = msgData.content.slice(0, 120);
      }

      const messages: Message[] = tokens.map((t) => ({
        token: t.token,
        data,
        android: { priority: 'high', ttl: 2_419_200 }, // 28 days — the FCM max retention window
      }));

      const res = await this.messaging.sendEach(messages);

      // Prune only definitively-dead tokens. Other errors (throttle/internal/unavailable) are transient
      // and deleting on them would leak rows as devices reconnect. sendEach gives a per-message error
      // so the prune targets precisely.
      const dead: string[] = [];
      res.responses.forEach((r, i) => {
        if (
          !r.success &&
          r.error?.code === 'messaging/registration-token-not-registered'
        ) {
          dead.push(tokens[i].token);
        }
      });
      if (dead.length > 0) {
        await this.prisma.pushToken.deleteMany({ where: { token: { in: dead } } });
        this.logger.debug(`pruned ${dead.length} stale FCM token(s)`);
      }
      const failed = res.failureCount - dead.length;
      if (failed > 0) {
        this.logger.warn(`FCM sendEach: ${failed} transient failure(s) (not pruned)`);
      }
    } catch (e) {
      // Last-resort guard: a push failure must NEVER surface to the send path (it's fire-and-forget).
      this.logger.error(`FCM dispatchForMessage failed: ${(e as Error).message}`);
    }
  }
}
