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
import { AdminSetQuotaDto } from './admin.dto.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { QuotaService } from '../quota/quota.service.js';

/**
 * Admin Quotas endpoints — the operator surface for the unified daily-quota system (see
 * src/quota/quota.service.ts). Lists every quota NODE (the local server's
 * own SOMS_DOMAIN plus each federated peer) with today's usage + per-category limits, and sets a node's
 * per-category overrides (null = use the global default). Reads are any admin; writes are SUPER_ADMIN
 * only — mirroring AdminFederationController's block/unblock gate.
 *
 * Handlers return raw data (or void for acks); the global SerializeInterceptor wraps the ApiResult
 * envelope. Failures throw BusinessException (the global AllExceptionsFilter renders the body).
 *
 * @Public() opts out of the global SessionAuthGuard so this controller's own route-scoped AdminAuthGuard
 * runs instead — the same opt-out the other admin controllers use.
 */
@ApiTags('admin')
@Public()
@Controller()
export class AdminQuotaController {
  constructor(private readonly quota: QuotaService) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/quota/nodes')
  @ApiOperation({
    summary:
      'List all quota nodes (local + each federated peer) with today usage + limits',
  })
  async listNodes() {
    return this.quota.listNodes();
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
      "Set a quota node's per-category daily limits (a null field = use the default)",
  })
  async setLimits(
    @Param('domain') domain: string,
    @Body() dto: AdminSetQuotaDto,
  ): Promise<void> {
    await this.quota.setLimits(domain, dto);
  }
}
