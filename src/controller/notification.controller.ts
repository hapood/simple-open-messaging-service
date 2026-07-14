import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Get,
  Request,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { NotificationTokenGuard } from '../auth/notification-token.guard.js';
import { SseService } from '../gateway/sse.service.js';
import { NotificationQueryService } from '../notification/notification-query.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * Read-only notification surface for background clients that hold ONLY the scoped notification token
 * (no access token, no live WebView):
 *  - POST /notifications/missed — the WorkManager poller's one-shot HTTP pull.
 *  - GET  /notifications/stream — the Android foreground service's live SSE feed.
 *
 * Both reuse {@link NotificationQueryService.buildUnreadSnapshot} for the unread-threads snapshot: the
 * HTTP endpoint returns it once per poll; the stream pushes it on every change (and once on connect)
 * so the FGS can render ONE coalesced away-notification statelessly (last snapshot wins).
 *
 * Auth is {@link NotificationTokenGuard} (not JwtAuthGuard): a scoped 30-day opaque token validated by
 * DB lookup, minted at POST /auth/notification-token. The stream validates once at connect, then pushes
 * for the connection's lifetime; mid-stream revocation drops the connection via SseService's
 * `auth.sessions-invalidated` handler.
 */
@ApiTags('notification')
@ApiBearerAuth()
@Public()
@Controller()
export class NotificationController {
  constructor(
    private readonly notifQuery: NotificationQueryService,
    private readonly sseService: SseService,
    private readonly settings: SettingsService,
  ) {}

  /** Public: the VAPID public key the browser needs to subscribe via PushManager.subscribe. Public (VAPID
   *  public keys are safe to expose), unauthenticated, single source of truth — read from the DB-backed
   *  SettingsService (admin-managed), so it always matches the keypair actually used to send. Empty string
   *  when Web Push is not configured (the browser simply won't subscribe). */
  @HttpCode(HttpStatus.OK)
  @Get('notifications/vapid-key')
  @ApiOperation({ summary: 'VAPID public key for Web Push subscription (browser)' })
  vapidKey(): ApiResult {
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { publicKey: this.settings.getVapid()?.publicKey ?? '' },
    };
  }

  @UseGuards(NotificationTokenGuard)
  @HttpCode(HttpStatus.OK)
  @Post('notifications/missed')
  @ApiOperation({ summary: 'Threads with unread messages + display names (background poller)' })
  async missed(@Request() req: FastifyRequest): Promise<ApiResult> {
    const data = await this.notifQuery.buildUnreadSnapshot(req.user.userId as number);
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  /** Live SSE feed of the same unread-threads snapshot consumed by the Android foreground service.
   *  NotificationTokenGuard validates the scoped token once at connect; SseService owns the stream
   *  (headers + heartbeat + res.on('close') cleanup, mirroring GET /events). On connect the current
   *  snapshot is pushed immediately so the FGS renders the away-notification without waiting for the
   *  next message; subsequent frames are pushed by the send-message fan-out. */
  @UseGuards(NotificationTokenGuard)
  @Get('notifications/stream')
  @ApiOperation({ summary: 'Live unread-threads SSE stream (Android foreground service)' })
  async stream(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    reply.hijack();
    const userId = (req.user as { userId: number }).userId;
    // Forward the request Origin so the hijacked raw stream carries its CORS header (hijack bypasses
    // @fastify/cors); harmless when the FGS is a native client with no Origin.
    this.sseService.registerNotif(userId, reply.raw, req.headers.origin);
    // Push the current snapshot so the FGS's away-notification is correct from the first moment.
    const snapshot = await this.notifQuery.buildUnreadSnapshot(userId);
    this.sseService.pushNotifSnapshot(userId, snapshot);
  }
}
