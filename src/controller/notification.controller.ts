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
 *  - GET  /notifications/vapid-key — public Web Push VAPID key (no auth).
 *  - GET  /push/firebase-config    — public Firebase client config (4 fields) for Android FCM runtime init.
 *  - POST /notifications/missed     — the cross-thread incremental-sync endpoint (global guard: session
 *    token OR access JWT). `summary:true` returns the unread-thread snapshot the FCM/WorkManager
 *    notification coalescing consumes; the default returns paginated messages (init seed =
 *    newest-per-thread; catch-up = messages newer than the high-water-mark, time-ascending).
 */
@ApiTags('notification')
@ApiBearerAuth()
@Controller()
export class NotificationController {
  constructor(
    private readonly notifQuery: NotificationQueryService,
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

  /** Public: the 4 Firebase client fields an Android client needs to initialize FirebaseApp at runtime.
   *  The APK ships WITHOUT google-services.json (each operator runs their own Firebase project), so the
   *  client fetches this after resolving its server origin and manually calls FirebaseApp.initializeApp at
   *  process start. Public + unauthenticated — these values identify a Firebase project, they do not
   *  authenticate anything (they ship inside the APK in the usual baked model). `{configured:false}` when
   *  the operator hasn't uploaded a google-services.json → the client clears its native FCM config. */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Get('push/firebase-config')
  @ApiOperation({ summary: 'Firebase client config for Android FCM runtime initialization (public)' })
  firebaseConfig(): ApiResult {
    const cfg = this.settings.getFirebaseConfig();
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: cfg
        ? {
            configured: true,
            apiKey: cfg.apiKey,
            projectId: cfg.projectId,
            appId: cfg.appId,
            gcmSenderId: cfg.gcmSenderId,
          }
        : { configured: false },
    };
  }

  /** Cross-thread incremental sync (app-open / reconnect catch-up) OR the unread-thread summary.
   *  Authenticated by the global guard (session token / access JWT). `summary:true` feeds the
   *  FCM/WorkManager unread-thread coalescing; the default returns paginated messages. */
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
}
