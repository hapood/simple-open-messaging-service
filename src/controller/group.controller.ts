import {
  Controller,
  Post,
  Body,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { GroupRole } from '../database/enums.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { GroupService } from '../group/group.service.js';
import { InviteService } from '../invite/invite.service.js';
import { FederationService } from '../federation/federation.service.js';
import { UserService } from '../user/user.service.js';
import { ThreadAccessGuard } from '../thread-participant/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { RolesGuard } from '../group/roles.guard.js';
import { Roles } from '../group/roles.decorator.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';
import {
  CreateGroupDto,
  InviteGroupDto,
  GroupIdDto,
  GroupTerminalActionDto,
  KickGroupDto,
  TransferGroupDto,
  SetRoleGroupDto,
  UpdateGroupDto,
  QueryGroupJoinRequestsDto,
  QueryGroupInviteCandidatesDto,
  HandleGroupJoinRequestDto,
  ReadGroupJoinRequestsDto,
  FederatedGroupJoinRequestDto,
} from '../dto/group.dto.js';
import { CreateGroupResponseDto } from '../dto/response.dto.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { DatabaseService } from '../database/database.service.js';
import { envelope } from '../common/api-result.js';

@ApiTags('group')
@Controller()
export class GroupController {
  constructor(
    private readonly groupService: GroupService,
    private readonly participantService: ThreadParticipantService,
    private readonly inviteService: InviteService,
    private readonly federationService: FederationService,
    private readonly userService: UserService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly userQuota: UserQuotaService,
    private readonly database: DatabaseService,
  ) {}

  @UseGuards(ThrottleGuard)
  @Throttle('group.create')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/create')
  @ApiOperation({
    summary: 'Create a group',
  })
  @ApiResultResponse(CreateGroupResponseDto)
  async createNewGroup(
    @Request() req: FastifyRequest,
    @Body() dto: CreateGroupDto,
  ) {
    const owner = req.user.userId;
    const grp = await this.groupService.createNewGroup({
      name: dto.name,
      description: dto.description,
      avatar: dto.avatar,
      owner,
    });
    // Client routes identify a group conversation by its thread id.
    return { threadId: grp.threadId, groupId: grp.threadId };
  }

  /**
   * Invite friends into a group by updating membership state. Local invitees receive a client-state
   * projection; federated invitees receive the group-authored relationship state through the state feed.
   */
  private async writeInvites(
    inviter: number,
    group: {
      threadId: number;
      account: string;
      name: string;
      avatar: string;
      profileRev: number;
    },
    userIds: number[],
  ): Promise<{
    invited: number[];
    skipped: { userId: number; reason: string }[];
  }> {
    const deduped = Array.from(new Set(userIds));
    const invited: number[] = [];
    const skipped: { userId: number; reason: string }[] = [];
    const groupAccount = group.account;
    if (!groupAccount) {
      // Should not happen (inviter + group exist) — fail every target loudly rather than silent skip.
      return {
        invited,
        skipped: deduped.map((userId) => ({
          userId,
          reason: 'inviter or group missing',
        })),
      };
    }
    const targets = deduped.length
      ? await this.userService.queryUsers({ where: { id: { in: deduped } } })
      : [];
    const byId = new Map(targets.map((u) => [u.id, u]));
    for (const userId of deduped) {
      const target = byId.get(userId);
      if (!target) {
        skipped.push({ userId, reason: 'user not found' });
        continue;
      }
      // The inviter's P2P thread with the target (shared for local; the inviter's mirror for federated).
      const p2pThreadId = await this.participantService.findP2PThreadBetween(
        inviter,
        userId,
      );
      if (p2pThreadId === null) {
        skipped.push({ userId, reason: 'not a friend or no conversation' });
        continue;
      }
      try {
        let statePeers = new Map<string, bigint>();
        const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
        await this.inviteService.createGroupInvite(
          inviter,
          group.threadId,
          userId,
          '',
          undefined,
          async (tx) => {
            statePeers =
              await this.federationService.writeGroupRelationshipIntentInTx(
                tx,
                group.threadId,
                userId,
                '',
                'REQUESTED',
                clientFeedUpdates,
              );
          },
        );
        await this.federationService.pushStateFeedDomains(statePeers.keys());
        clientFeedUpdates.forEach((pending) =>
          this.clientStateFeed.notifyFeedUpdated(pending),
        );
        invited.push(userId);
      } catch (e) {
        skipped.push({
          userId,
          reason: `invite failed: ${(e as Error)?.message ?? String(e)}`,
        });
      }
    }
    return { invited, skipped };
  }

  @UseGuards(ThreadAccessGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<InviteGroupDto>('groupId')
  @Post('group/invite')
  @ApiOperation({
    summary: 'Invite friends to an existing group',
  })
  async inviteUsers(
    @Request() req: FastifyRequest,
    @Body() dto: InviteGroupDto,
  ) {
    const threadId = req.threadAccess!.threadId;
    const inviter = req.user.userId;
    const trd = await this.groupService.findGroupByThreadId(threadId);
    const group = trd?.group;
    const role = req.threadAccess!.participant.role;
    if (role !== GroupRole.OWNER && role !== GroupRole.ADMIN) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'only group managers may invite',
      );
    }
    const { invited, skipped } = await this.writeInvites(
      inviter,
      {
        threadId,
        account: group?.account ?? '',
        name: group?.name ?? '',
        avatar: group?.avatar ?? '',
        profileRev: group?.profileRev ?? 0,
      },
      dto.userIds,
    );
    return { invited, skipped };
  }

  @UseGuards(ThreadAccessGuard, RolesGuard)
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<QueryGroupInviteCandidatesDto>('groupId')
  @Post('group/invite-candidates')
  @ApiOperation({
    summary: 'List friends with authoritative group invitation state',
  })
  async queryInviteCandidates(
    @Request() req: FastifyRequest,
    @Body() dto: QueryGroupInviteCandidatesDto,
  ) {
    return this.groupService.queryInviteCandidates(
      req.threadAccess!.threadId,
      req.user.userId,
      dto.afterUserId,
      dto.search,
      dto.take ?? 20,
    );
  }

  @UseGuards(ThreadAccessGuard, RolesGuard)
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<QueryGroupJoinRequestsDto>('groupId')
  @Post('group/join-requests')
  @ApiOperation({ summary: 'List valid pending group join applications' })
  async queryJoinRequests(
    @Request() req: FastifyRequest,
    @Body() dto: QueryGroupJoinRequestsDto,
  ) {
    return this.groupService.queryJoinRequests(
      req.threadAccess!.threadId,
      req.user.userId,
      dto.before,
      dto.take ?? 20,
    );
  }

  @UseGuards(ThreadAccessGuard, RolesGuard)
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<QueryGroupJoinRequestsDto>('groupId')
  @Post('group/invitations')
  @ApiOperation({ summary: 'List projected group invitations' })
  async queryInvitations(
    @Request() req: FastifyRequest,
    @Body() dto: QueryGroupJoinRequestsDto,
  ) {
    return this.groupService.queryInvitations(
      req.threadAccess!.threadId,
      req.user.userId,
      dto.before,
      dto.take ?? 20,
    );
  }

  @UseGuards(ThreadAccessGuard, RolesGuard)
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<ReadGroupJoinRequestsDto>('groupId')
  @Post('group/join-requests/read')
  @ApiOperation({
    summary: 'Advance the account-wide join-request read watermark',
  })
  async markJoinRequestsRead(
    @Request() req: FastifyRequest,
    @Body() dto: ReadGroupJoinRequestsDto,
  ): Promise<void> {
    await this.groupService.markJoinRequestsRead(
      req.threadAccess!.threadId,
      req.user.userId,
      dto.readFeedId,
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.join-request-action')
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<HandleGroupJoinRequestDto>('groupId')
  @Post('group/join-request/accept')
  @ApiOperation({ summary: 'Accept a pending group join application' })
  async acceptJoinRequest(
    @Request() req: FastifyRequest,
    @Body() dto: HandleGroupJoinRequestDto,
  ): Promise<void> {
    await this.groupService.handleJoinRequest(
      req.threadAccess!.threadId,
      BigInt(dto.requestId),
      'ACCEPTED',
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.join-request-action')
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<HandleGroupJoinRequestDto>('groupId')
  @Post('group/join-request/reject')
  @ApiOperation({ summary: 'Reject/delete a pending group join application' })
  async rejectJoinRequest(
    @Request() req: FastifyRequest,
    @Body() dto: HandleGroupJoinRequestDto,
  ): Promise<void> {
    await this.groupService.handleJoinRequest(
      req.threadAccess!.threadId,
      BigInt(dto.requestId),
      'REVOKED',
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.join-request-action')
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<HandleGroupJoinRequestDto>('groupId')
  @Post('group/invitation/revoke')
  @ApiOperation({ summary: 'Revoke a pending group invitation' })
  async revokeInvitation(
    @Request() req: FastifyRequest,
    @Body() dto: HandleGroupJoinRequestDto,
  ): Promise<void> {
    await this.groupService.revokeInvitation(
      req.threadAccess!.threadId,
      BigInt(dto.requestId),
    );
  }

  @UseGuards(ThrottleGuard)
  @Throttle('group.join-request')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/join-request')
  @ApiOperation({
    summary: 'Author the local USER→GROUP request for an existing invitation',
  })
  async joinRequestedGroup(
    @Request() req: FastifyRequest,
    @Body() dto: GroupIdDto,
  ): Promise<void> {
    await this.federationService.acceptGroupRequest(
      dto.groupId,
      req.user.userId,
    );
  }

  @UseGuards(ThrottleGuard)
  @Throttle('group.join-request')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/federated-join-request')
  @ApiOperation({ summary: 'Apply to a federated group by Address' })
  async requestFederatedGroupJoin(
    @Request() req: FastifyRequest,
    @Body() dto: FederatedGroupJoinRequestDto,
  ) {
    const account = dto.account.trim().toLowerCase();
    const domain = dto.domain.trim().toLowerCase();
    if (!account.startsWith('!'))
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'group account must start with !',
      );
    if (domain === 'local' || domain === this.federationService.ourDomain)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'local groups do not use the federated join route',
      );
    await this.federationService.ensurePeerTrusted(domain);
    await this.database.db.transaction((tx) =>
      this.userQuota.tick(req.user.userId, 'requests', tx),
    );
    await this.federationService.requestFederatedGroupJoin(
      req.user.userId,
      { account, domain },
      dto.note ?? '',
      { displayName: dto.displayName, avatar: dto.avatar },
    );
    return envelope(
      { account, domain },
      {
        message: 'group join request sent',
        messageKey: 'group.msg.joinRequestSent',
      },
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle('group.leave')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupTerminalActionDto>('groupId')
  @Post('group/leave')
  @ApiOperation({ summary: 'Leave a group (owner must transfer first)' })
  async leaveGroup(
    @Request() req: FastifyRequest,
    @Body() dto: GroupTerminalActionDto,
  ): Promise<void> {
    if (req.threadAccess!.groupDissolved) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    const threadId = req.threadAccess!.threadId;
    const { participant } = req.threadAccess!;
    await this.groupService.leaveGroup({
      userId: req.user.userId,
      threadId,
      role: participant.role,
      deleteData: dto.deleteData ?? false,
    });
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle('group.dissolve')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupTerminalActionDto>('groupId')
  @Post('group/dissolve')
  @ApiOperation({ summary: 'Dissolve a group (owner only)' })
  async dissolveGroup(
    @Request() req: FastifyRequest,
    @Body() dto: GroupTerminalActionDto,
  ): Promise<void> {
    // Kept outside RolesGuard so a retry after a lost success response stays idempotent even though
    // RolesGuard rejects other mutations once dissolved. Ownership still comes from the guarded row.
    if (req.threadAccess.participant.role !== GroupRole.OWNER) {
      throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'owner only');
    }
    const threadId = req.threadAccess!.threadId;
    await this.groupService.dissolveGroup({
      threadId,
      operatorUserId: req.user.userId,
      deleteForUserId: dto.deleteData ? req.user.userId : undefined,
    });
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.kick')
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<KickGroupDto>('groupId')
  @Post('group/kick')
  @ApiOperation({ summary: 'Kick a member (owner/admin, must outrank target)' })
  async kickMember(
    @Request() req: FastifyRequest,
    @Body() dto: KickGroupDto,
  ): Promise<void> {
    const threadId = req.threadAccess!.threadId;
    const target = await this.groupService.resolveActiveMember(threadId, dto);
    await this.groupService.kickMember({
      threadId,
      operatorUserId: req.user.userId,
      targetUserId: target.userId,
    });
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.transfer')
  @Roles(GroupRole.OWNER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<TransferGroupDto>('groupId')
  @Post('group/transfer')
  @ApiOperation({ summary: 'Transfer ownership to a member (owner only)' })
  async transferOwnership(
    @Request() req: FastifyRequest,
    @Body() dto: TransferGroupDto,
  ): Promise<void> {
    const threadId = req.threadAccess!.threadId;
    const target = await this.groupService.resolveActiveMember(threadId, dto);
    await this.groupService.transferOwnership({
      threadId,
      fromUserId: req.user.userId,
      toUserId: target.userId,
    });
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.set-role')
  @Roles(GroupRole.OWNER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<SetRoleGroupDto>('groupId')
  @Post('group/set-role')
  @ApiOperation({ summary: "Set a member's role to ADMIN/MEMBER (owner only)" })
  async setRole(
    @Request() req: FastifyRequest,
    @Body() dto: SetRoleGroupDto,
  ): Promise<void> {
    const threadId = req.threadAccess!.threadId;
    const target = await this.groupService.resolveActiveMember(threadId, dto);
    await this.groupService.setRole({
      threadId,
      targetUserId: target.userId,
      role: dto.role,
      operatorUserId: req.user.userId,
    });
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.update')
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<UpdateGroupDto>('groupId')
  @Post('group/update')
  @ApiOperation({ summary: 'Update group name/avatar (admin+)' })
  async updateGroup(
    @Request() req: FastifyRequest,
    @Body() dto: UpdateGroupDto,
  ): Promise<void> {
    const threadId = req.threadAccess!.threadId;
    await this.groupService.updateGroup({
      threadId,
      name: dto.name,
      description: dto.description,
      avatar: dto.avatar,
    });
  }
}
