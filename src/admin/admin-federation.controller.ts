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
import {
  AdminListFederationPeersDto,
  AdminFederationBlockDto,
  AdminFederationSelfCheckDto,
  AdminFederationResetDto,
  AdminFederationIdentityRecoverDto,
} from './admin.dto.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { identityNamespace } from '../database/schema.js';
import { FederationService } from '../federation/federation.service.js';
import { FederationSelfCheckService } from './federation-self-check.service.js';
import { FederationResetService } from './federation-reset.service.js';
import { FederationNamespaceAdminService } from './federation-namespace-admin.service.js';
import { KeypairService } from '../federation/keypair.service.js';

/**
 * Federation trust-lifecycle admin endpoints. Read-only observability of the peer trust state,
 * plus Block/Unblock as the persistent admin control (a blocked peer is refused federation until unblocked). The runtime trust
 * state machine itself — recognition, transport degradation and contact recovery — lives in the
 * federation services
 * and is driven by the S2S I/O paths; these endpoints only read it and flip the blocked bit.
 *
 * Block/Unblock are SUPER_ADMIN-only (high-impact: refuses federation for a whole domain) and audited.
 *
 * Handlers return raw data (or void for acks); the global SerializeInterceptor wraps the ApiResult
 * envelope. Failures throw BusinessException (the global AllExceptionsFilter renders the body).
 */
@ApiTags('admin')
@Public()
@Controller()
export class AdminFederationController {
  constructor(
    private readonly federationService: FederationService,
    private readonly selfCheckService: FederationSelfCheckService,
    private readonly resetService: FederationResetService,
    private readonly namespaceAdmin: FederationNamespaceAdminService,
    private readonly database: DatabaseService,
    private readonly keypair: KeypairService,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers')
  @ApiOperation({
    summary:
      'Federated-peer lifecycle list (trust state + audit cols), paginated + filterable',
  })
  async listPeers(@Body() dto: AdminListFederationPeersDto) {
    return this.federationService.listPeers({
      skip: dto.skip ?? 0,
      take: dto.take ?? 20,
      search: dto.search,
      status: dto.status,
    });
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain')
  @ApiOperation({
    summary: 'Single federated peer detail (current lifecycle state)',
  })
  async peerDetail(@Param('domain') domain: string) {
    // Read directly from the database rather than FederationService — the service is the S2S runtime's
    // concern; this is a trivial current-state read for the console, and keeps the admin surface
    // independent of the federation module's WIP.
    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: eq(identityNamespace.domain, domain),
    });
    if (!peer)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'peer not found');
    return peer;
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/namespaces')
  @ApiOperation({
    summary: 'List identity namespaces owned by a federated peer',
  })
  async peerNamespaces(@Param('domain') domain: string) {
    return this.namespaceAdmin.list(domain);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/identity-reviews')
  @ApiOperation({
    summary:
      'List pending peer identity reviews (domain re-binds, root rotations)',
  })
  async pendingIdentityReviews() {
    return this.namespaceAdmin.pendingReviews();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/local-root-epochs')
  @ApiOperation({
    summary: 'List local federation root identity epochs',
  })
  async localRootEpochs() {
    return this.keypair.getRootEpochs();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.local_root_rotate', { targetType: 'localFederationRoot' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/local-root-epochs/rotate')
  @ApiOperation({
    summary: 'Rotate the local federation root identity epoch immediately',
  })
  async rotateLocalRoot() {
    return this.keypair.rotateRoot();
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.local_root_unpublish', {
    targetType: 'localFederationRoot',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/local-root-epochs/:id/unpublish')
  @ApiOperation({
    summary: 'Stop publishing an expired predecessor root epoch',
  })
  async unpublishLocalRoot(@Param('id') id: string) {
    const rootId = this.requireReviewId(id);
    await this.keypair.unpublishRoot(rootId);
    return { rootId, status: 'unpublished' };
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/identity-reviews/:id/predecessor-check')
  @ApiOperation({
    summary:
      'Seal a fresh challenge under the pinned predecessor root and ask the peer to open it (rotation continuity evidence)',
  })
  async predecessorCheck(@Param('id') id: string) {
    return this.namespaceAdmin.predecessorCheck(this.requireReviewId(id));
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.identity_review_approve', { targetType: 'identityReview' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/identity-reviews/:id/approve')
  @ApiOperation({
    summary: 'Approve a pending peer identity review',
  })
  async approveIdentityReview(@Param('id') id: string) {
    return this.namespaceAdmin.approve(this.requireReviewId(id));
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.identity_review_reject', { targetType: 'identityReview' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/identity-reviews/:id/reject')
  @ApiOperation({
    summary: 'Reject a pending peer identity review',
  })
  async rejectIdentityReview(@Param('id') id: string) {
    return this.namespaceAdmin.reject(this.requireReviewId(id));
  }

  private requireReviewId(raw: string): number {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'reviewId must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    return id;
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/reset-preview')
  @ApiOperation({
    summary:
      'Preview the namespace retired by an identity-mismatch halted peer reset (read-only)',
  })
  async resetPreview(@Param('domain') domain: string) {
    return this.resetService.preview(domain);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.peer.reset_start', {
    targetType: 'peer',
    targetParam: 'domain',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/reset')
  @ApiOperation({
    summary: 'Retire the active namespace of an identity-mismatch halted peer',
  })
  async resetPeer(
    @Param('domain') domain: string,
    @Body() dto: AdminFederationResetDto,
  ) {
    return this.resetService.start(domain, dto.confirmDomain);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.peer.identity_recover', {
    targetType: 'peer',
    targetParam: 'domain',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/recover-identity')
  @ApiOperation({
    summary:
      'Recover an identity-mismatch halted peer only when the original pinned identity is reachable again',
  })
  async recoverPeerIdentity(
    @Param('domain') domain: string,
    @Body() dto: AdminFederationIdentityRecoverDto,
  ) {
    return this.federationService.manuallyRecoverPinnedIdentity(
      domain,
      dto.confirmDomain,
    );
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.peer.block', { targetType: 'peer', targetParam: 'domain' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/block')
  @ApiOperation({
    summary: 'Block a peer domain — federation is refused until unblocked',
  })
  async blockPeer(
    @Param('domain') domain: string,
    @Body() dto: AdminFederationBlockDto,
  ): Promise<void> {
    await this.federationService.markBlocked(domain, dto.note);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.peer.unblock', {
    targetType: 'peer',
    targetParam: 'domain',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/unblock')
  @ApiOperation({
    summary:
      'Unblock a peer domain — moves to pending; the next contact re-handshakes',
  })
  async unblockPeer(@Param('domain') domain: string): Promise<void> {
    await this.federationService.markUnblocked(domain);
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/self-check')
  @ApiOperation({
    summary:
      'S2S handshake self-check — probes this server own DNS/SRV/TLS/well-known/key/clock from the external viewpoint (read-only)',
  })
  async selfCheck(@Body() dto: AdminFederationSelfCheckDto) {
    return this.selfCheckService.run({
      ntpServer: dto?.ntpServer,
      dnsResolver: dto?.dnsResolver,
    });
  }
}
