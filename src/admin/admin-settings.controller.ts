import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';
import { AdminRole } from '../prisma/generated/client.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { SettingsService } from '../settings/settings.service.js';
import type { VapidConfig } from '../settings/vapid.js';
import { PushService } from '../push/push.service.js';
import { SaveVapidDto, GenerateVapidDto, OtpTtlDto, SaveFirebaseConfigDto } from './admin-settings.dto.js';

/**
 * Admin-managed runtime settings — the DB-backed "Settings" console page. Today this is the Web Push
 * VAPID keypair (enable / generate / paste / rotate / clear) plus a deterministic health check. The VAPID
 * keys live in the SystemSetting KV table (SettingsService), NOT env, so an admin can toggle Web Push
 * with no redeploy or shell access.
 *
 * RBAC: read + health-check are open to every admin role (VIEWER incl.); generate/save require ADMIN+
 * (rotation breaks existing Web Push subscriptions → clients re-subscribe, so it's gated like other
 * routine mutations); clear is SUPER_ADMIN-only (disables Web Push entirely). Every mutation is audited.
 *
 * Security: the VAPID private key is WRITE-ONLY from this surface — only publicKey + subject are ever
 * returned. Generate creates the pair server-side so the private key never transits the browser at all.
 */
@ApiTags('admin')
@Public()
@Controller()
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly pushService: PushService,
  ) {}

  private ok(data?: unknown): ApiResult {
    return data === undefined
      ? { code: BusinessCode.OK, message: 'success' }
      : { code: BusinessCode.OK, message: 'success', data };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/notifications')
  @ApiOperation({
    summary: 'Notification transport config — VAPID status (subject + publicKey, never privateKey), FCM status, server domain',
  })
  async getNotifications(): Promise<ApiResult> {
    const [vapid, firebase] = await Promise.all([
      this.settings.getVapidDescriptor(),
      this.settings.getFirebaseDescriptor(),
    ]);
    return this.ok({
      vapid,
      firebase,
      fcmConfigured: this.pushService.fcmConfigured,
      somsDomain: this.settings.somsDomain,
      otpTtlMinutes: await this.settings.getOtpTtlMinutes(),
    });
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.vapid.generate')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/vapid/generate')
  @ApiOperation({
    summary: 'Generate a fresh VAPID keypair server-side and persist it (privateKey never returned)',
  })
  async generateVapid(@Body() dto: GenerateVapidDto): Promise<ApiResult> {
    // WARNING surfaced by the UI: generating/rotating the keypair breaks existing Web Push subscriptions
    // — browsers bound the subscription to the old VAPID publicKey and must re-subscribe.
    const cfg = this.settings.generateVapid(dto.subject);
    await this.settings.setVapid(cfg);
    return this.ok({ configured: true, subject: cfg.subject, publicKey: cfg.publicKey });
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.vapid.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/vapid/save')
  @ApiOperation({
    summary: 'Save (paste) a VAPID keypair — validates first, rejects malformed / mismatched pairs',
  })
  async saveVapid(@Body() dto: SaveVapidDto): Promise<ApiResult> {
    const cfg: VapidConfig = {
      subject: dto.subject,
      publicKey: dto.publicKey,
      privateKey: dto.privateKey,
    };
    const report = this.settings.validateVapid(cfg, this.pushService.fcmConfigured);
    if (!report.pairMatches || !report.publicKeyValid || !report.privateKeyValid || !report.subjectValid) {
      throw new BusinessException(
        BusinessCode.VAPID_INVALID,
        report.errors[0] ?? 'VAPID keypair invalid',
      );
    }
    await this.settings.setVapid(cfg);
    return this.ok({ configured: true, subject: cfg.subject, publicKey: cfg.publicKey });
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('settings.vapid.clear')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/vapid/clear')
  @ApiOperation({ summary: 'Remove the VAPID keypair — disables Web Push' })
  async clearVapid(): Promise<ApiResult> {
    await this.settings.clearVapid();
    return this.ok();
  }

  // ---- Firebase client config (FCM for Android) ---------------------------------------------
  // The operator uploads their google-services.json; the server parses + publishes the 4 client fields to
  // Android clients (the APK ships without google-services.json; clients fetch + initialize FirebaseApp at
  // runtime). RBAC mirrors VAPID: save = ADMIN+, clear = SUPER_ADMIN. Independent of the send-side
  // GOOGLE_APPLICATION_CREDENTIALS path (fcmConfigured above).

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.firebase.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/firebase/save')
  @ApiOperation({
    summary: "Upload the operator's google-services.json — parses + publishes the 4 FCM client fields to Android clients",
  })
  async saveFirebase(@Body() dto: SaveFirebaseConfigDto): Promise<ApiResult> {
    let descriptor;
    try {
      descriptor = await this.settings.setFirebaseConfig(dto.googleServicesJson);
    } catch (e) {
      // parseGoogleServicesJson throws on malformed JSON / missing fields / wrong package name.
      throw new BusinessException(
        BusinessCode.FCM_CONFIG_INVALID,
        (e as Error).message || 'google-services.json invalid',
      );
    }
    return this.ok(descriptor);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('settings.firebase.clear')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/firebase/clear')
  @ApiOperation({ summary: 'Remove the Firebase client config — clients clear their native FCM config' })
  async clearFirebase(): Promise<ApiResult> {
    await this.settings.clearFirebaseConfig();
    return this.ok();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.otp-ttl.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/otp-ttl')
  @ApiOperation({ summary: 'Set the one-time-code validity window (minutes, clamped 1-1440)' })
  async setOtpTtl(@Body() dto: OtpTtlDto): Promise<ApiResult> {
    await this.settings.setOtpTtlMinutes(dto.ttlMinutes);
    return this.ok({ otpTtlMinutes: await this.settings.getOtpTtlMinutes() });
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/health-check')
  @ApiOperation({
    summary: 'Validate the configured VAPID keypair + transport status (deterministic, no network)',
  })
  async healthCheck(): Promise<ApiResult> {
    const report = this.settings.validateVapid(
      this.settings.getVapid(),
      this.pushService.fcmConfigured,
    );
    return this.ok(report);
  }
}
