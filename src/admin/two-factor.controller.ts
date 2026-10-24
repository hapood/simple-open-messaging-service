import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { Audit } from './audit.decorator.js';
import { AdminAuthService } from './admin-auth.service.js';
import { ThrottleGuard, Throttle } from '../rate-limit/throttle.guard.js';
import { TwoFactorSetupVerifyDto } from './admin.dto.js';
import { AccountSecurityService } from './account-security.service.js';
import { SecurityProofDto } from './account-security.dto.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/**
 * Admin self-service TOTP two-factor (Google/Microsoft Authenticator). Every handler authenticates the
 * calling admin via AdminAuthGuard (the controller is @Public only to opt out of the global SessionAuthGuard,
 * which guards user sessions — admin auth is a separate mechanism). The current admin both IS the actor and
 * the target, so RBAC is not involved (no @Roles — any role may harden its own account). State-changing
 * handlers carry @Audit so enrollment / disable / regeneration land in AdminActionLog.
 *
 * Security mutations live in AccountSecurityService, which coordinates fresh proofs and atomic
 * revocation. This controller only parses input, extracts the admin principal, and returns raw
 * data (the global SerializeInterceptor wraps the {code,message,data} envelope; failures throw
 * BusinessException).
 */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(AdminAuthGuard, ThrottleGuard)
@Throttle('admin.two-factor')
@Controller()
export class TwoFactorController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly security: AccountSecurityService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('admin/2fa/status')
  @ApiOperation({
    summary: "Current admin's 2FA status (enabled + remaining backup codes)",
  })
  async status(@Req() req: FastifyRequest) {
    return this.adminAuth.twoFactorStatus(this.adminId(req));
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/2fa/setup')
  @ApiOperation({
    summary: 'Begin 2FA enrollment (otpauth URI + secret + pending token)',
  })
  async setup(@Req() req: FastifyRequest, @Body() dto: SecurityProofDto) {
    return this.security.beginEnrollment(
      this.adminId(req),
      req.user.sessionId!,
      'totp-enable',
      dto,
    );
  }

  @Audit('admin.2fa_enable', { targetType: 'admin' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/2fa/setup/verify')
  @ApiOperation({
    summary:
      'Confirm 2FA enrollment (verify first code) → enables + returns backup codes once',
  })
  async setupVerify(
    @Req() req: FastifyRequest,
    @Body() dto: TwoFactorSetupVerifyDto,
  ) {
    return this.security.completeEnrollment(
      this.adminId(req),
      req.user.sessionId!,
      'totp-enable',
      dto.pendingToken,
      dto.code,
    );
  }

  @Audit('admin.2fa_disable', { targetType: 'admin' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/2fa/disable')
  @ApiOperation({
    summary: 'Disable 2FA (requires current password + a live 2FA factor)',
  })
  async disable(
    @Req() req: FastifyRequest,
    @Body() dto: SecurityProofDto,
  ): Promise<void> {
    await this.security.mutate(
      this.adminId(req),
      req.user.sessionId!,
      'totp-disable',
      dto,
    );
  }

  @Audit('admin.2fa_regenerate_backup', { targetType: 'admin' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/2fa/backup/regenerate')
  @ApiOperation({
    summary:
      'Regenerate backup codes (requires a live 2FA factor) → new codes returned once',
  })
  async regenerate(@Req() req: FastifyRequest, @Body() dto: SecurityProofDto) {
    return this.security.mutate(
      this.adminId(req),
      req.user.sessionId!,
      'backup-regenerate',
      dto,
    );
  }

  private adminId(req: FastifyRequest): number {
    const id = (req.user as { adminId?: number } | undefined)?.adminId;
    if (id === undefined) {
      throw new BusinessException(
        BusinessCode.UNAUTHENTICATED,
        'no admin session',
        HttpStatus.OK,
      );
    }
    return id;
  }
}
