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
import { SettingsService } from '../settings/settings.service.js';
import {
  NotificationFeedQueryDto,
  ReportActionDto,
} from '../dto/notification.dto.js';

/**
 * The notification + incremental-sync surface.
 *  - GET  /notifications/vapid-key — public Web Push VAPID key (no auth).
 *  - POST /notification-feed/query — system-notification descriptors while the app is away.
 *
 * Handlers return raw data (the global SerializeInterceptor wraps the ApiResult envelope).
 */
@ApiTags('notification')
@ApiBearerAuth()
@Controller()
export class NotificationController {
  constructor(
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

  /** Build a current notification snapshot for thread heads changed after a ClientStateFeed cursor. */
  @HttpCode(HttpStatus.OK)
  @Post('notification-feed/query')
  @ApiOperation({
    summary: 'Build notifications from changed thread heads in ClientStateFeed',
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
