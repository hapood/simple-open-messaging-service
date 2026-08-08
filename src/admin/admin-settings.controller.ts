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
import { AdminRole } from '../database/enums.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { SettingsService } from '../settings/settings.service.js';
import type { VapidConfig } from '../settings/vapid.js';
import { PushService } from '../push/push.service.js';
import {
  SaveVapidDto,
  GenerateVapidDto,
  OtpTtlDto,
  FederationDownloadLimitsDto,
} from './admin-settings.dto.js';
import { FederationDownloadScheduler } from '../federation/federation-download-scheduler.js';

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
 *
 * Handlers return raw data (or void for acks); the global SerializeInterceptor wraps the ApiResult
 * envelope. Failures throw BusinessException (the global AllExceptionsFilter renders the body).
 */
@ApiTags('admin')
@Public()
@Controller()
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly pushService: PushService,
    private readonly downloadScheduler: FederationDownloadScheduler,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/notifications')
  @ApiOperation({
    summary:
      'Notification transport config — VAPID status (subject + publicKey, never privateKey), FCM status, server domain',
  })
  async getNotifications() {
    const [vapid, otpTtlMinutes, federationDownloadLimits] = await Promise.all([
      this.settings.getVapidDescriptor(),
      this.settings.getOtpTtlMinutes(),
      this.settings.getFederationDownloadLimits(),
    ]);
    return {
      vapid,
      firebase: this.settings.getFirebaseDescriptor(),
      fcmConfigured: this.pushService.fcmConfigured,
      somsDomain: this.settings.somsDomain,
      otpTtlMinutes,
      federationDownloadLimits,
    };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.federation-download.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/federation-download')
  async setFederationDownloadLimits(@Body() dto: FederationDownloadLimitsDto) {
    await this.settings.setFederationDownloadLimits(
      dto.global,
      dto.perPeer,
      dto.chunkDigestEnabled,
    );
    this.downloadScheduler.invalidateLimits();
    return {
      global: dto.global,
      perPeer: dto.perPeer,
      chunkDigestEnabled: dto.chunkDigestEnabled,
    };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.vapid.generate')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/vapid/generate')
  @ApiOperation({
    summary:
      'Generate a fresh VAPID keypair server-side and persist it (privateKey never returned)',
  })
  async generateVapid(@Body() dto: GenerateVapidDto) {
    // WARNING surfaced by the UI: generating/rotating the keypair breaks existing Web Push subscriptions
    // — browsers bound the subscription to the old VAPID publicKey and must re-subscribe.
    const cfg = this.settings.generateVapid(dto.subject);
    await this.settings.setVapid(cfg);
    return { configured: true, subject: cfg.subject, publicKey: cfg.publicKey };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.vapid.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/vapid/save')
  @ApiOperation({
    summary:
      'Save (paste) a VAPID keypair — validates first, rejects malformed / mismatched pairs',
  })
  async saveVapid(@Body() dto: SaveVapidDto) {
    const cfg: VapidConfig = {
      subject: dto.subject,
      publicKey: dto.publicKey,
      privateKey: dto.privateKey,
    };
    const report = this.settings.validateVapid(
      cfg,
      this.pushService.fcmConfigured,
    );
    if (
      !report.pairMatches ||
      !report.publicKeyValid ||
      !report.privateKeyValid ||
      !report.subjectValid
    ) {
      throw new BusinessException(
        BusinessCode.VAPID_INVALID,
        report.errors[0] ?? 'VAPID keypair invalid',
      );
    }
    await this.settings.setVapid(cfg);
    return { configured: true, subject: cfg.subject, publicKey: cfg.publicKey };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('settings.vapid.clear')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/vapid/clear')
  @ApiOperation({ summary: 'Remove the VAPID keypair — disables Web Push' })
  async clearVapid(): Promise<void> {
    await this.settings.clearVapid();
  }

  // Firebase client config is file-based (google-services.json at FIREBASE_CLIENT_CONFIG), not DB-backed,
  // so there is no admin upload/clear surface here — its status is surfaced read-only in getNotifications
  // above (the `firebase` descriptor + `fcmConfigured`). See SettingsService.getFirebaseConfig.

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.otp-ttl.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/otp-ttl')
  @ApiOperation({
    summary: 'Set the one-time-code validity window (minutes, clamped 1-1440)',
  })
  async setOtpTtl(@Body() dto: OtpTtlDto) {
    await this.settings.setOtpTtlMinutes(dto.ttlMinutes);
    return { otpTtlMinutes: await this.settings.getOtpTtlMinutes() };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/health-check')
  @ApiOperation({
    summary:
      'Validate the configured VAPID keypair + transport status (deterministic, no network)',
  })
  async healthCheck() {
    return this.settings.validateVapid(
      this.settings.getVapid(),
      this.pushService.fcmConfigured,
    );
  }
}
