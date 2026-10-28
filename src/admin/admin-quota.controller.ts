import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Body,
  Param,
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
import { AdminContinueQuotaDto, AdminSetQuotaDto } from './admin.dto.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { QuotaService } from '../quota/quota.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { FederationDownloadRecoveryService } from '../federation/federation-download-recovery.service.js';

/**
 * Admin quota endpoints for federated peer servers AND local users (see src/quota/quota.service.ts and
 * src/quota/user-quota.service.ts). Lists each peer domain with today's usage + per-category limits; sets a
 * peer's overrides (null = default); surfaces tripped circuit breakers; and the "continue / add quota" action
 * that bumps an entity's ADDITIVE daily allowance to unblock a tripped breaker. Reads are any admin; writes
 * are SUPER_ADMIN only.
 *
 * Handlers return raw data (or void for acks); the global SerializeInterceptor wraps the ApiResult envelope.
 *
 * @Public() opts out of the global SessionAuthGuard so this controller's own route-scoped AdminAuthGuard runs
 * instead — the same opt-out the other admin controllers use.
 */
@ApiTags('admin')
@Public()
@Controller()
export class AdminQuotaController {
  constructor(
    private readonly quota: QuotaService,
    private readonly userQuota: UserQuotaService,
    private readonly federationDownloads: FederationDownloadRecoveryService,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/quota/nodes')
  @ApiOperation({
    summary: 'List federated peers with today quota usage + limits',
  })
  async listNodes() {
    return this.quota.listNodes();
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/quota/breakers')
  @ApiOperation({
    summary:
      'All currently-tripped quota circuit breakers (federation peers + local users)',
  })
  async trippedBreakers() {
    const [peers, users] = await Promise.all([
      this.quota.trippedBreakers(),
      this.userQuota.trippedBreakers(),
    ]);
    return { peers, users };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('quota.node.setLimits', {
    targetType: 'quota-node',
    targetParam: 'domain',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/quota/nodes/:domain')
  @ApiOperation({
    summary:
      "Set a federated peer's per-dimension daily limits (null = default)",
  })
  async setLimits(
    @Param('domain') domain: string,
    @Body() dto: AdminSetQuotaDto,
  ): Promise<void> {
    const namespaceId = await this.quota.activeNamespaceId(domain);
    await this.quota.setLimits(namespaceId, {
      maxFileBytes: dto.maxFileBytes == null ? null : BigInt(dto.maxFileBytes),
      dailyMsgLimit: dto.dailyMsgLimit,
      dailyRequestLimit: dto.dailyRequestLimit,
      dailySignalLimit: dto.dailySignalLimit,
      dailyFileLimit: dto.dailyFileLimit,
      dailyFileBytesLimit:
        dto.dailyFileBytesLimit != null
          ? BigInt(dto.dailyFileBytesLimit)
          : null,
    });
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('quota.node.continue', {
    targetType: 'quota-node',
    targetParam: 'domain',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/quota/nodes/:domain/continue')
  @ApiOperation({
    summary:
      "Add today's additive quota to a tripped federated peer and clear its breaker if within limits",
  })
  async continuePeer(
    @Param('domain') domain: string,
    @Body() dto: AdminContinueQuotaDto,
  ) {
    const namespaceId = await this.quota.activeNamespaceId(domain);
    const status = await this.quota.addQuota(namespaceId, {
      addMsg: dto.addMsg,
      addRequest: dto.addRequest,
      addSignal: dto.addSignal,
      addFile: dto.addFile,
      addFileBytes:
        dto.addFileBytes != null ? BigInt(dto.addFileBytes) : undefined,
    });
    if (!status.tripped) {
      await this.federationDownloads.wakeQuotaPaused(namespaceId);
    }
    return status;
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('quota.user.continue', {
    targetType: 'user',
    targetParam: 'id',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/quota/continue')
  @ApiOperation({
    summary:
      "Add today's additive quota to a tripped local user and clear its breaker if within limits",
  })
  async continueUser(
    @Param('id') id: string,
    @Body() dto: AdminContinueQuotaDto,
  ) {
    const userId = Number(id);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid user id',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.userQuota.addQuota(userId, {
      addMsg: dto.addMsg,
      addRequest: dto.addRequest,
      addSignal: dto.addSignal,
      addFile: dto.addFile,
      addFileBytes:
        dto.addFileBytes != null ? BigInt(dto.addFileBytes) : undefined,
    });
  }
}
