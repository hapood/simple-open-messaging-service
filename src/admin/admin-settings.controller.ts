import { Public } from '../common/public.decorator.js';
import {
  BadRequestException,
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
import { SettingsService } from '../settings/settings.service.js';
import { PushService } from '../push/push.service.js';
import {
  OtpTtlDto,
  AdminSessionPolicyDto,
  FederationDownloadLimitsDto,
  FederationHttpLimitsDto,
  FederationHistoryAccessDto,
  FederationQuotaDefaultsDto,
  FederationTransportDto,
  UserQuotaDefaultsDto,
} from './admin-settings.dto.js';
import { getManagedSecretStatus } from '../auth/jwt-secret.js';
import { KeypairService } from '../federation/keypair.service.js';
import { FederationDownloadScheduler } from '../federation/federation-download-scheduler.js';
import { FederationHttpScheduler } from '../federation/federation-http-scheduler.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { AdminAuthService } from './admin-auth.service.js';
import { FederationTransportConfigService } from '../federation/federation-transport-config.service.js';
import { DiscoveryService } from '../federation/discovery.service.js';

/**
 * Admin runtime settings and read-only server-key inventory. Application-owned keys are generated in
 * fixed files and can never be created, replaced, or removed through HTTP.
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
    private readonly httpScheduler: FederationHttpScheduler,
    private readonly keypair: KeypairService,
    private readonly userQuota: UserQuotaService,
    private readonly quota: QuotaService,
    private readonly adminAuth: AdminAuthService,
    private readonly transportConfig: FederationTransportConfigService,
    private readonly discovery: DiscoveryService,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings')
  @ApiOperation({
    summary: 'Read the complete admin-managed runtime settings model',
  })
  async getSettings() {
    const [
      vapid,
      otpTtlMinutes,
      federationDownloadLimits,
      federationHttpLimits,
      federationHistoryAccessEnabled,
    ] = await Promise.all([
      this.settings.getVapidDescriptor(),
      this.settings.getOtpTtlMinutes(),
      this.settings.getFederationDownloadLimits(),
      this.settings.getFederationHttpLimits(),
      this.settings.getFederationHistoryAccessEnabled(),
    ]);
    return {
      vapid,
      firebase: this.settings.getFirebaseDescriptor(),
      fcmConfigured: this.pushService.fcmConfigured,
      somsDomain: this.settings.somsDomain,
      otpTtlMinutes,
      federationDownloadLimits,
      federationHttpLimits,
      federationHistoryAccessEnabled,
      userQuotaDefaults: this.userQuota.getDefaultLimits(),
      federationQuotaDefaults: this.quota.getDefaultLimits(),
      adminSessionPolicy: this.adminAuth.getSessionPolicy(),
      federationTransport: this.transportConfig.get(),
    };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.federation-transport.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/federation-transport')
  async setFederationTransport(@Body() body: FederationTransportDto) {
    try {
      const value = await this.transportConfig.set(body);
      this.discovery.invalidateAllRoutes();
      return value;
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'invalid federation transport settings',
      );
    }
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.admin-session-policy.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/admin-session-policy')
  async setAdminSessionPolicy(@Body() body: AdminSessionPolicyDto) {
    try {
      return await this.adminAuth.setSessionPolicy({ ...body });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'invalid session policy',
      );
    }
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.federation-quota-defaults.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/federation-quota-defaults')
  async setFederationQuotaDefaults(@Body() body: FederationQuotaDefaultsDto) {
    try {
      return await this.quota.setDefaultLimits({ ...body });
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'invalid quota defaults',
      );
    }
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.user-quota-defaults.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/user-quota-defaults')
  async setUserQuotaDefaults(@Body() body: UserQuotaDefaultsDto) {
    try {
      return await this.userQuota.setDefaultLimits(body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'invalid quota defaults',
      );
    }
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.federation-http.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/federation-http')
  async setFederationHttpLimits(@Body() dto: FederationHttpLimitsDto) {
    await this.settings.setFederationHttpLimits(dto.global, dto.perPeer);
    this.httpScheduler.invalidateLimits();
    return { global: dto.global, perPeer: dto.perPeer };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.federation-history-access.save')
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/federation-history-access')
  async setFederationHistoryAccess(@Body() dto: FederationHistoryAccessDto) {
    await this.settings.setFederationHistoryAccessEnabled(dto.enabled);
    return { enabled: dto.enabled };
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

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/settings/keys')
  @ApiOperation({
    summary: 'Read-only status for every application-owned server key',
  })
  getKeys() {
    const federation = this.keypair.getStatus();
    return [
      {
        id: 'federation-root',
        kind: 'asymmetric',
        ...federation,
        publicKey: federation.available
          ? this.keypair.getRootPublicKeyB64()
          : undefined,
      },
      {
        id: 'federation-signing',
        kind: 'asymmetric',
        ...federation,
        keyId: federation.available ? this.keypair.getKeyId() : undefined,
        publicKey: federation.available
          ? this.keypair.getPublicKeyB64()
          : undefined,
        createdAt: federation.available
          ? this.keypair.getCreatedAt()
          : undefined,
      },
      { id: 'vapid', kind: 'asymmetric', ...this.settings.getVapidKeyStatus() },
      {
        id: 'admin-jwt',
        kind: 'symmetric',
        ...getManagedSecretStatus('jwt-admin.key'),
      },
      {
        id: 'password-pepper',
        kind: 'symmetric',
        ...getManagedSecretStatus('password-pepper.key'),
      },
      {
        id: 'two-factor',
        kind: 'symmetric',
        ...getManagedSecretStatus('2fa.key'),
      },
      {
        id: 'firebase-service-account',
        kind: 'external',
        ...this.pushService.getFcmCredentialStatus(),
      },
    ];
  }

  // Firebase client config is file-based (data/google-services.json), not DB-backed,
  // so there is no admin upload/clear surface here — its status is surfaced read-only in getSettings
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
