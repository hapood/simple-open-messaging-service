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
import { NotificationActionService } from '../notification/notification-action.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { MissedDto, ReportActionDto } from '../dto/notification.dto.js';

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

  /** The unified missed summary + server-authored notification descriptors (one row per thread: newest
   *  message body + unread count + display name, PLUS the localized title/body + composited stacked-avatar
   *  icon every notification renderer consumes). Authenticated by the global guard (session token / access
   *  JWT). Absent `cursor` → the newest `take` threads (the background away-notification paths + the initial
   *  threadlist hydrate); `cursor` → forward pagination (threads newer than the cursor, ASC). The response
   *  carries `nextCursor` (the page's max-id item) + `notifications[]` (the descriptors). Locale is
   *  negotiated from `Accept-Language` (stateless — the device language the client already knows). */
  @HttpCode(HttpStatus.OK)
  @Post('notifications/missed')
  @ApiOperation({
    summary:
      'Missed summary (latest message per thread) + notification descriptors, forward-paginated by (threadId, seq) cursor',
  })
  async missed(
    @Request() req: FastifyRequest,
    @Body() dto: MissedDto,
  ): Promise<ApiResult> {
    const userId = req.user.userId as number;
    const take = Math.min(
      MISSED_MAX_TAKE,
      Math.max(1, dto.take ?? MISSED_DEFAULT_TAKE),
    );
    const cursor =
      dto.cursor && typeof dto.cursor.threadId === 'number' && typeof dto.cursor.seq === 'number'
        ? { threadId: dto.cursor.threadId, seq: dto.cursor.seq }
        : null;
    const data = await this.notifQuery.buildNotifyResponse(userId, {
      cursor,
      take,
      acceptLanguage: (req.headers['accept-language'] as string | undefined) ?? null,
    });
    return { code: BusinessCode.OK, message: 'successful', data };
  }

  /** Report a notification action (button tap / inline reply) back to the server — the round-trip closure
   *  for the descriptor's `actions[]`. Authenticated by the global guard (session token / access JWT). The
   *  service reuses the mark-read / send pipelines (identical semantics to the in-app actions) and is
   *  best-effort (never throws — a shade-button failure just doesn't land). */
  @HttpCode(HttpStatus.OK)
  @Post('notifications/action')
  @ApiOperation({ summary: 'Report a notification action (button tap / inline reply)' })
  async reportAction(
    @Request() req: FastifyRequest,
    @Body() dto: ReportActionDto,
  ): Promise<ApiResult> {
    const userId = req.user.userId as number;
    await this.notifAction.handleAction(userId, dto);
    return { code: BusinessCode.OK, message: 'successful', data: null };
  }
}
