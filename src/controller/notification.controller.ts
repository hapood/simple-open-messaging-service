import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { Public } from '../common/public.decorator.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettingsService } from '../settings/settings.service.js';

/**
 * The Web Push subscription configuration surface.
 *  - GET  /notifications/vapid-key — public Web Push VAPID key (no auth).
 *
 * Handlers return raw data (the global SerializeInterceptor wraps the ApiResult envelope).
 */
@ApiTags('notification')
@Controller()
export class NotificationController {
  constructor(private readonly settings: SettingsService) {}

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
}
