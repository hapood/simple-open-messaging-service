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
  NotificationFeedQueryDto,
  ThreadCatchUpDto,
  ReportActionDto,
} from '../dto/notification.dto.js';

/** Per-page cap for /thread-sync/catch-up (the threadlist body walk). */
const CATCH_UP_MAX_TAKE = 200;

/**
 * The notification + incremental-sync surface.
 *  - GET  /notifications/vapid-key — public Web Push VAPID key (no auth).
 * New code uses two explicit domain resources:
 *  - POST /thread-sync/catch-up — ThreadList preview/read-state catch-up.
 *  - POST /notification-feed/query — system-notification descriptors while the app is away.
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

  /** Read one page of the compacted per-user message feed and hydrate its changed threads. */
  @HttpCode(HttpStatus.OK)
  @Post('thread-sync/catch-up')
  @ApiOperation({
    summary: 'Read changed thread previews from the per-user message feed',
  })
  async catchUp(@Request() req: FastifyRequest, @Body() dto: ThreadCatchUpDto) {
    const userId = req.user.userId as number;
    const take = Math.min(
      CATCH_UP_MAX_TAKE,
      Math.max(1, dto.take ?? CATCH_UP_MAX_TAKE),
    );
    return this.threadListSync.catchUp(userId, {
      after: dto.after ?? 0,
      ...(dto.through !== undefined ? { through: dto.through } : {}),
      take,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('thread-sync/tombstones')
  @ApiOperation({
    summary: 'Read the compacted per-user message tombstone feed',
  })
  async catchUpTombstones(
    @Request() req: FastifyRequest,
    @Body() dto: ThreadCatchUpDto,
  ) {
    const take = Math.min(
      CATCH_UP_MAX_TAKE,
      Math.max(1, dto.take ?? CATCH_UP_MAX_TAKE),
    );
    return this.threadListSync.catchUpTombstones(req.user.userId as number, {
      after: dto.after ?? 0,
      ...(dto.through !== undefined ? { through: dto.through } : {}),
      take,
    });
  }

  /** Build a current notification snapshot for threads changed after a per-user message-feed cursor. */
  @HttpCode(HttpStatus.OK)
  @Post('notification-feed/query')
  @ApiOperation({
    summary:
      'Build notifications from changed threads in the per-user message feed',
  })
  async queryNotifications(
    @Request() req: FastifyRequest,
    @Body() dto: NotificationFeedQueryDto,
  ) {
    const userId = req.user.userId as number;
    return this.awayNotifications.query(userId, {
      after: dto.after,
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
