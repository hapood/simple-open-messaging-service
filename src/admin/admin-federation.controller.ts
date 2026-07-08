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
import {
  AdminListFederationPeersDto,
  AdminFederationPeerEventsDto,
  AdminFederationBlockDto,
} from './admin.dto.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { FederationService } from '../federation/federation.service.js';

/**
 * Federation trust-lifecycle admin endpoints. Read-only observability of the peer trust state +
 * its append-only event timeline (the trust→connection-loss process), plus Block/Unblock as the
 * persistent admin control (a blocked peer is refused federation until unblocked). The runtime trust
 * state machine itself — markTrusted / markDemoted / markContactSuccess — lives in FederationService
 * and is driven by the S2S I/O paths; these endpoints only read it and flip the blocked bit.
 *
 * Mirrors AdminController: @Controller() with full admin/federation/... paths, AdminAuthGuard,
 * ApiResult envelope, POST + @Body/@Param.
 */
@ApiTags('admin')
@Controller()
export class AdminFederationController {
  constructor(private readonly federationService: FederationService) {}

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
  @Post('admin/federation/peers/:domain/events')
  @ApiOperation({ summary: 'A peer trust-lifecycle event timeline (trust → demote → re-trust …)' })
  async peerEvents(
    @Param('domain') domain: string,
    @Body() dto: AdminFederationPeerEventsDto,
  ): Promise<ApiResult> {
    const data = await this.federationService.peerEvents(domain, dto.take ?? 100);
    return { code: BusinessCode.OK, message: 'success', data };
  }

  @UseGuards(AdminAuthGuard)
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

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/unblock')
  @ApiOperation({ summary: 'Unblock a peer domain — moves to pending; the next contact re-handshakes' })
  async unblockPeer(@Param('domain') domain: string): Promise<ApiResult> {
    await this.federationService.markUnblocked(domain);
    return { code: BusinessCode.OK, message: 'success' };
  }
}
