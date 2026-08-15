import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Get,
  Request,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { NotificationActionService } from '../notification/notification-action.service.js';
import { AwayNotificationService } from '../notification/away-notification.service.js';
import { ThreadListSyncService } from '../thread-sync/thread-list-sync.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  MissedDto,
  MissedSummaryDto,
  ReportActionDto,
} from '../dto/notification.dto.js';

/** Page-size bounds for the paginated missed catch-up (the DTO validates 1–200; this is the default). */
/** Per-page cap for /thread-sync/catch-up (the threadlist body walk). */
const MISSED_MAX_TAKE = 200;

/**
 * The notification + incremental-sync surface.
 *  - GET  /notifications/vapid-key — public Web Push VAPID key (no auth).
 * New code uses two explicit domain resources:
 *  - POST /thread-sync/catch-up — ThreadList preview/read-state catch-up.
 *  - POST /notification-feed/query — system-notification descriptors while the app is away.
 * Legacy `/notifications/missed*` paths remain aliases during rolling client upgrades.
 *
 * Handlers return raw data (the global SerializeInterceptor wraps the ApiResult envelope).
 */
@ApiTags('notification')
@ApiBearerAuth()
@Controller()
export class NotificationController {
  constructor(
    private readonly threadListSync: ThreadListSyncService,
    private readonly awayNotifications: AwayNotificationService,
    private readonly notifAction: NotificationActionService,
    private readonly settings: SettingsService,
  ) {}

  /** Public: the VAPID public key the browser needs to subscribe via PushManager.subscribe. Public (VAPID
   *  public keys are safe to expose), unauthenticated, single source of truth — read from the DB-backed
   *  SettingsService (admin-managed), so it always matches the keypair actually used to send. Empty string
   *  when Web Push is not configured (the browser simply won't subscribe). */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Get('notifications/vapid-key')
  @ApiOperation({
    summary: 'VAPID public key for Web Push subscription (browser)',
  })
  vapidKey() {
    return { publicKey: this.settings.getVapid()?.publicKey ?? '' };
  }

  /** The threadlist body pre-warm — per-thread latest body for threads whose latest-message id ∈ `(from, to]`.
   *  `to` = the newest SSE signal (pinned upper bound); `from` = the high-water mark (advancing lower bound).
   *  Authenticated by the global guard (session token / access JWT). The client walks pages until `!hasMore`,
   *  then sets HWM = `to`. `to ≤ from` (stale SSE) → empty no-op. */
  @HttpCode(HttpStatus.OK)
  @Post(['thread-sync/catch-up', 'notifications/missed-summary'])
  @ApiOperation({
    summary:
      'Threadlist body pre-warm: per-thread latest body in the (from, to] range (double-boundary walk)',
  })
  async missedSummary(
    @Request() req: FastifyRequest,
    @Body() dto: MissedSummaryDto,
  ) {
    const userId = req.user.userId as number;
    const take = Math.min(
      MISSED_MAX_TAKE,
      Math.max(1, dto.take ?? MISSED_MAX_TAKE),
    );
    const from =
      dto.from &&
      typeof dto.from.threadId === 'number' &&
      typeof dto.from.seq === 'number'
        ? { threadId: dto.from.threadId, seq: dto.from.seq }
        : null;
    const to =
      dto.to &&
      typeof dto.to.threadId === 'number' &&
      typeof dto.to.seq === 'number'
        ? { threadId: dto.to.threadId, seq: dto.to.seq }
        : null;
    if (!to) {
      // `to` is @IsRequired on the DTO (ValidationPipe rejects absent); defensive guard for shape.
      return { items: [], hasMore: false, nextCursor: null };
    }
    return this.threadListSync.catchUp(userId, { from, to, take });
  }

  /** The away-notification summary — per-sender aggregation of the messages newer than `since` (the HWM),
   *  authored into ONE descriptor ("X, Y sent you N messages" / "999+" past the 1000-sample) + a composited
   *  stacked-avatar icon. NOTIFICATION renderers only (Web SW / Android FCM-FGS / desktop). One-shot current
   *  snapshot, replace-by-tag. Locale negotiated from `Accept-Language`. */
  @HttpCode(HttpStatus.OK)
  @Post(['notification-feed/query', 'notifications/missed'])
  @ApiOperation({
    summary:
      'Away-notification summary: per-sender aggregation of messages since the high-water mark',
  })
  async missed(@Request() req: FastifyRequest, @Body() dto: MissedDto) {
    const userId = req.user.userId as number;
    const since =
      dto.since &&
      typeof dto.since.threadId === 'number' &&
      typeof dto.since.seq === 'number'
        ? { threadId: dto.since.threadId, seq: dto.since.seq }
        : null;
    return this.awayNotifications.query(userId, {
      since,
      previewMode: dto.previewMode,
      threadHwms: dto.threadHwms,
      acceptLanguage:
        (req.headers['accept-language'] as string | undefined) ?? null,
    });
  }

  /** Report a notification action (button tap / inline reply) back to the server — the round-trip closure
   *  for the descriptor's `actions[]`. Authenticated by the global guard (session token / access JWT). The
   *  service reuses the mark-read / send pipelines (identical semantics to the in-app actions) and is
   *  best-effort (never throws — a shade-button failure just doesn't land). */
  @HttpCode(HttpStatus.OK)
  @Post('notifications/action')
  @ApiOperation({
    summary: 'Report a notification action (button tap / inline reply)',
  })
  async reportAction(
    @Request() req: FastifyRequest,
    @Body() dto: ReportActionDto,
  ) {
    const userId = req.user.userId as number;
    await this.notifAction.handleAction(userId, dto);
    return null;
  }
}
