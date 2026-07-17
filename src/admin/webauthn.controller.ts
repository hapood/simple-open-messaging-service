import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Body,
  Param,
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
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { WebAuthnRegBeginDto, WebAuthnRegFinishDto, WebAuthnRenameDto } from './admin.dto.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/**
 * Admin self-service WebAuthn (passkey) enrollment + management. Mirrors TwoFactorController: every
 * handler authenticates the calling admin via AdminAuthGuard (@Public only opts out of the global
 * SessionAuthGuard). The current admin both IS the actor and the target (no @Roles — any role may harden
 * its own account). State-changing handlers carry @Audit.
 *
 * The LOGIN endpoints (pre-session) live in AdminController, not here — same split as TOTP. All domain
 * logic lives in AdminAuthService (which delegates the crypto + credential storage to WebAuthnService);
 * this controller parses input, extracts the adminId principal, derives the browser origin from the
 * request header, and wraps the {code,message,data} envelope.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(AdminAuthGuard, ThrottleGuard)
@Throttle(10, 60) // defense-in-depth ceiling on the authenticated passkey endpoints
@Controller()
export class WebAuthnController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  private ok(data?: unknown): ApiResult {
    return data === undefined
      ? { code: BusinessCode.OK, message: 'success' }
      : { code: BusinessCode.OK, message: 'success', data };
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/webauthn/status')
  @ApiOperation({ summary: "Current admin's passkey status (availability + enabled + credential count)" })
  async status(@Req() req: FastifyRequest): Promise<ApiResult> {
    return this.ok(await this.adminAuth.webAuthnStatus(this.adminId(req)));
  }

  @Audit('admin.webauthn_register_begin', { targetType: 'admin' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/webauthn/registration/begin')
  @ApiOperation({ summary: 'Begin passkey enrollment (re-auth required) → options + pending token' })
  async registrationBegin(
    @Req() req: FastifyRequest,
    @Body() dto: WebAuthnRegBeginDto,
  ): Promise<ApiResult> {
    return this.ok(
      await this.adminAuth.beginWebAuthnRegistration(this.adminId(req), dto.password, dto.nickname),
    );
  }

  @Audit('admin.webauthn_register_finish', { targetType: 'webauthn_credential' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/webauthn/registration/finish')
  @ApiOperation({ summary: 'Confirm passkey enrollment → persists the credential' })
  async registrationFinish(
    @Req() req: FastifyRequest,
    @Body() dto: WebAuthnRegFinishDto,
  ): Promise<ApiResult> {
    return this.ok(
      await this.adminAuth.completeWebAuthnRegistration(
        this.adminId(req),
        dto.pendingToken,
        dto.registrationResponse,
      ),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('admin/webauthn/credentials')
  @ApiOperation({ summary: "List the current admin's saved passkeys" })
  async list(@Req() req: FastifyRequest): Promise<ApiResult> {
    return this.ok(await this.adminAuth.listWebAuthnCredentials(this.adminId(req)));
  }

  @Audit('admin.webauthn_rename', { targetType: 'webauthn_credential', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/webauthn/credentials/:id/rename')
  @ApiOperation({ summary: 'Rename a saved passkey' })
  async rename(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() dto: WebAuthnRenameDto,
  ): Promise<ApiResult> {
    await this.adminAuth.renameWebAuthnCredential(this.adminId(req), this.parseRowId(id), dto.nickname);
    return this.ok();
  }

  @Audit('admin.webauthn_delete', { targetType: 'webauthn_credential', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/webauthn/credentials/:id/delete')
  @ApiOperation({ summary: 'Delete a saved passkey' })
  async delete(@Req() req: FastifyRequest, @Param('id') id: string): Promise<ApiResult> {
    return this.ok(await this.adminAuth.removeWebAuthnCredential(this.adminId(req), this.parseRowId(id)));
  }

  private adminId(req: FastifyRequest): number {
    const id = (req.user as { adminId?: number } | undefined)?.adminId;
    if (id === undefined) {
      throw new BusinessException(BusinessCode.UNAUTHENTICATED, 'no admin session', HttpStatus.OK);
    }
    return id;
  }

  private parseRowId(id: string): bigint {
    try {
      return BigInt(id);
    } catch {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid credential id',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
