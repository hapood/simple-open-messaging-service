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
import { AdminRole, Prisma } from '../prisma/generated/client.js';
import { AdminSetQuotaDto } from './admin.dto.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { QuotaService } from '../quota/quota.service.js';

/**
 * Admin Quotas endpoints — the operator surface for the unified daily-quota system (see
 * src/quota/quota.service.ts). Lists every quota NODE (the local server's
 * own SOMS_DOMAIN plus each federated peer) with today's usage + per-category limits, and sets a node's
 * per-category overrides (null = use the global default). Reads are any admin; writes are SUPER_ADMIN
 * only — mirroring AdminFederationController's block/unblock gate.
 *
 * @Public() opts out of the global SessionAuthGuard so this controller's own route-scoped AdminAuthGuard
 * (the admin JWT) runs instead — the same opt-out the other admin controllers use.
 */
@ApiTags('admin')
@Public()
@Controller()
export class AdminQuotaController {
  constructor(private readonly quota: QuotaService) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/quota/nodes')
  @ApiOperation({ summary: 'List all quota nodes (local + each federated peer) with today usage + limits' })
  async listNodes(): Promise<ApiResult> {
    const data = await this.quota.listNodes();
    return { code: BusinessCode.OK, message: 'success', data };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('quota.node.setLimits', { targetType: 'quota-node', targetParam: 'domain' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/quota/nodes/:domain')
  @ApiOperation({ summary: "Set a quota node's per-category daily limits (a null field = use the default)" })
  async setLimits(
    @Param('domain') domain: string,
    @Body() dto: AdminSetQuotaDto,
  ): Promise<ApiResult> {
    try {
      await this.quota.setLimits(domain, dto);
    } catch (e) {
      // setLimits on an unknown peer (not in FederatedPeer) throws Prisma P2025. The admin page only
      // lists existing peers, so this is a race (peer removed between list + set); surface 200 + NOT_FOUND
      // to stay consistent with the admin envelope (the local node is always settable — it never 404s).
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        return { code: BusinessCode.NOT_FOUND, message: 'quota node not found' };
      }
      throw e;
    }
    return { code: BusinessCode.OK, message: 'success' };
  }
}
