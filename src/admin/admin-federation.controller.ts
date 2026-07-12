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
import { AdminRole } from '../prisma/generated/client.js';
import {
  AdminListFederationPeersDto,
  AdminFederationPeerEventsDto,
  AdminFederationBlockDto,
  AdminFederationSelfCheckDto,
} from './admin.dto.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { PrismaService } from '../prisma.service.js';
import { FederationService } from '../federation/federation.service.js';
import { FederationSelfCheckService } from './federation-self-check.service.js';

/**
 * Federation trust-lifecycle admin endpoints. Read-only observability of the peer trust state +
 * its append-only event timeline (the trust→connection-loss process), plus Block/Unblock as the
 * persistent admin control (a blocked peer is refused federation until unblocked). The runtime trust
 * state machine itself — markTrusted / markDemoted / markContactSuccess — lives in FederationService
 * and is driven by the S2S I/O paths; these endpoints only read it and flip the blocked bit.
 *
 * Block/Unblock are SUPER_ADMIN-only (high-impact: refuses federation for a whole domain) and audited.
 */
@ApiTags('admin')
@Public()
@Controller()
export class AdminFederationController {
  constructor(
    private readonly federationService: FederationService,
    private readonly selfCheckService: FederationSelfCheckService,
    private readonly prisma: PrismaService,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers')
  @ApiOperation({ summary: 'Federated-peer lifecycle list (trust state + audit cols), paginated + filterable' })
  async listPeers(@Body() dto: AdminListFederationPeersDto): Promise<ApiResult> {
    const data = await this.federationService.listPeers({
      skip: dto.skip ?? 0,
      take: dto.take ?? 20,
      search: dto.search,
      status: dto.status,
    });
    return { code: BusinessCode.OK, message: 'success', data };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain')
  @ApiOperation({ summary: 'Single federated peer detail (current lifecycle state)' })
  async peerDetail(@Param('domain') domain: string): Promise<ApiResult> {
    // Read directly from Prisma rather than FederationService — the service is the S2S runtime's
    // concern; this is a trivial current-state read for the console, and keeps the admin surface
    // independent of the federation module's WIP.
    const peer = await this.prisma.federatedPeer.findUnique({ where: { domain } });
    if (!peer) return { code: BusinessCode.NOT_FOUND, message: 'peer not found' };
    return { code: BusinessCode.OK, message: 'success', data: peer };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/events')
  @ApiOperation({ summary: 'A peer trust-lifecycle event timeline (trust → demote → re-trust …)' })
  async peerEvents(
    @Param('domain') domain: string,
    @Body() dto: AdminFederationPeerEventsDto,
  ): Promise<ApiResult> {
    const data = await this.federationService.peerEvents(domain, dto.take ?? 100);
    return { code: BusinessCode.OK, message: 'success', data };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.peer.block', { targetType: 'peer', targetParam: 'domain' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/block')
  @ApiOperation({ summary: 'Block a peer domain — federation is refused until unblocked' })
  async blockPeer(
    @Param('domain') domain: string,
    @Body() dto: AdminFederationBlockDto,
  ): Promise<ApiResult> {
    await this.federationService.markBlocked(domain, dto.note);
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.peer.unblock', { targetType: 'peer', targetParam: 'domain' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/unblock')
  @ApiOperation({ summary: 'Unblock a peer domain — moves to pending; the next contact re-handshakes' })
  async unblockPeer(@Param('domain') domain: string): Promise<ApiResult> {
    await this.federationService.markUnblocked(domain);
    return { code: BusinessCode.OK, message: 'success' };
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/self-check')
  @ApiOperation({
    summary: 'S2S handshake self-check — probes this server own DNS/SRV/TLS/well-known/key/clock from the external viewpoint (read-only)',
  })
  async selfCheck(@Body() dto: AdminFederationSelfCheckDto): Promise<ApiResult> {
    const data = await this.selfCheckService.run({ ntpServer: dto?.ntpServer, dnsResolver: dto?.dnsResolver });
    return { code: BusinessCode.OK, message: 'success', data };
  }
}
