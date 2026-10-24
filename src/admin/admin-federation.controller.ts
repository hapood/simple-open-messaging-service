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
  AdminFederationRetireDto,
  AdminFederationReviewApproveDto,
  AdminFederationIdentityRecoverDto,
  AdminFederationMessageProvenanceDto,
  AdminFederationHealthProbeDto,
} from './admin.dto.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { FederationPeerLifecycle } from '../federation/federation-peer-lifecycle.js';
import { FederationRetireService } from './federation-retire.service.js';
import { FederationNamespaceAdminService } from './federation-namespace-admin.service.js';
import { KeypairService } from '../federation/keypair.service.js';
import { FederationRecognitionService } from '../federation/federation-recognition.service.js';
import { FederationAdminMessageProvenanceService } from '../federation/federation-admin-message-provenance.service.js';
import { FederationAdminHealthProbeService } from '../federation/federation-admin-health-probe.service.js';

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
    private readonly peerLifecycle: FederationPeerLifecycle,
    private readonly retireService: FederationRetireService,
    private readonly namespaceAdmin: FederationNamespaceAdminService,
    private readonly keypair: KeypairService,
    private readonly recognition: FederationRecognitionService,
    private readonly messageProvenance: FederationAdminMessageProvenanceService,
    private readonly healthProbe: FederationAdminHealthProbeService,
  ) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers')
  @ApiOperation({
    summary:
      'Federated-peer lifecycle list (trust state + audit cols), paginated + filterable',
  })
  async listPeers(@Body() dto: AdminListFederationPeersDto) {
    return this.peerLifecycle.list({
      skip: dto.skip ?? 0,
      take: dto.take ?? 20,
      search: dto.search,
      status: dto.status,
      namespaceId: dto.namespaceId,
    });
  }

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain')
  @ApiOperation({
    summary: 'Single federated peer detail (current lifecycle state)',
  })
  async peerDetail(@Param('domain') domain: string) {
    return this.peerLifecycle.detail(domain);
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
  @Audit('federation.identity_review_approve', { targetType: 'identityReview' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/identity-reviews/:id/approve')
  @ApiOperation({
    summary:
      'Approve a pending peer identity review (root rotation verifies predecessor possession automatically)',
  })
  async approveIdentityReview(
    @Param('id') id: string,
    @Body() dto: AdminFederationReviewApproveDto,
  ) {
    return this.namespaceAdmin.approve(
      this.requireReviewId(id),
      dto.resolution,
    );
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
  @Post('admin/federation/peers/:domain/retire-preview')
  @ApiOperation({
    summary: 'Preview the namespace a peer retirement will archive (read-only)',
  })
  async retirePreview(@Param('domain') domain: string) {
    return this.retireService.preview(domain);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.peer.retire_start', {
    targetType: 'peer',
    targetParam: 'domain',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/retire')
  @ApiOperation({
    summary: 'Retire the active namespace of an identity-mismatch halted peer',
  })
  async retirePeer(
    @Param('domain') domain: string,
    @Body() dto: AdminFederationRetireDto,
  ) {
    return this.retireService.start(domain, dto.confirmDomain);
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
    return this.peerLifecycle.manuallyRecoverPinnedIdentity(
      domain,
      dto.confirmDomain,
    );
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.SUPER_ADMIN)
  @Audit('federation.peer.recognize', {
    targetType: 'peer',
    targetParam: 'domain',
  })
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/peers/:domain/recognize')
  @ApiOperation({
    summary: 'Start or retry outbound recognition with a federated peer',
  })
  async recognizePeer(@Param('domain') domain: string) {
    if (
      domain.trim().toLowerCase().replace(/\.+$/, '') ===
      this.keypair.getIdentityDomain()
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'local identity is not a federation peer',
      );
    }
    return this.recognition.recognize(domain);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/health/probe')
  @ApiOperation({
    summary:
      'Probe one federated namespace through the signed S2S health endpoint',
  })
  async probeFederationHealth(@Body() dto: AdminFederationHealthProbeDto) {
    return this.healthProbe.probe(dto.namespaceId);
  }

  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('admin/federation/message-provenance/verify')
  @ApiOperation({
    summary: 'Verify one federated message with its authoritative peer',
  })
  async verifyMessageProvenance(
    @Body() dto: AdminFederationMessageProvenanceDto,
  ) {
    return this.messageProvenance.verify(dto.threadId, dto.seq);
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
    await this.peerLifecycle.markBlocked(domain, dto.note);
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
    await this.peerLifecycle.markUnblocked(domain);
  }
}
