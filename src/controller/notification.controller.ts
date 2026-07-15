import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Get,
  Request,
  Req,
  Res,
  Body,
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
import { MissedDto } from '../dto/notification.dto.js';

/** Page-size bounds for the paginated missed catch-up (the DTO validates 1–200; this is the default). */
const MISSED_DEFAULT_TAKE = 50;
const MISSED_MAX_TAKE = 200;

/**
 * The notification + incremental-sync surface.
 *  - GET  /notifications/vapid-key  — public Web Push VAPID key (no auth).
 *  - POST /notifications/missed     — the repurposed cross-thread incremental-sync endpoint (global
 *    guard: session token OR access JWT). `summary:true` returns the legacy unread-thread snapshot for
 *    the FCM/WorkManager coalescing during the transition; the default returns paginated messages
 *    (init seed = newest-per-thread; catch-up = messages newer than the high-water-mark, time-ascending).
 *  - GET  /notifications/stream     — the Android foreground service's live SSE feed. @Public +
 *    NotificationTokenGuard (scoped 30-day notification token) during the transition; removed in Phase 4
 *    once the FGS holds /events directly.
 */
@ApiTags('notification')
@ApiBearerAuth()
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
  @Public()
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

  /** Cross-thread incremental sync (app-open / reconnect catch-up) OR the legacy unread snapshot.
   *  Authenticated by the global guard (session token / access JWT) — the same credential the rest of
   *  the API accepts. `summary:true` keeps the FCM/WorkManager unread-thread shape alive during the
   *  transition (Phase 4 collapses it onto the message path). */
  @HttpCode(HttpStatus.OK)
  @Post('notifications/missed')
  @ApiOperation({
    summary:
      'Catch up on missed messages since a high-water-mark (paginated), or the unread-thread summary',
  })
  async missed(
    @Request() req: FastifyRequest,
    @Body() dto: MissedDto,
  ): Promise<ApiResult> {
    const userId = req.user.userId as number;
    if (dto.summary) {
      const data = await this.notifQuery.buildUnreadSnapshot(userId);
      return { code: BusinessCode.OK, message: 'successful', data };
    }
    const take = Math.min(
      MISSED_MAX_TAKE,
      Math.max(1, dto.take ?? MISSED_DEFAULT_TAKE),
    );
    const data = await this.notifQuery.buildMissedPage(userId, {
      since: dto.since,
      cursor: dto.cursor,
      take,
    });
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  /** Live SSE feed of the same unread-threads snapshot consumed by the Android foreground service.
   *  NotificationTokenGuard validates the scoped token once at connect; SseService owns the stream
   *  (headers + heartbeat + res.on('close') cleanup, mirroring GET /events). On connect the current
   *  snapshot is pushed immediately so the FGS renders the away-notification without waiting for the
   *  next message; subsequent frames are pushed by the send-message fan-out.
   *  @Public() + NotificationTokenGuard during the transition (Phase 4 removes this route entirely once
   *  the FGS holds /events directly and builds notifications from the live message stream). */
  @Public()
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
