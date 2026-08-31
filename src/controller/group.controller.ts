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
import { FederationService } from '../federation/federation.service.js';
import { UserService } from '../user/user.service.js';
import { ThreadAccessGuard } from '../thread-participant/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { RolesGuard } from '../group/roles.guard.js';
import { Roles } from '../group/roles.decorator.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
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
import { DomainCommandQueueService } from '../domain-command/domain-command-queue.service.js';
import { DomainCommandType } from '../domain-command/domain-command.constants.js';
import { DomainCommandAcceptedDto } from '../dto/domain-command.dto.js';

@ApiTags('group')
@Controller()
export class GroupController {
  constructor(
    private readonly groupService: GroupService,
    private readonly participantService: ThreadParticipantService,
    private readonly federationService: FederationService,
    private readonly userService: UserService,
    private readonly domainCommands: DomainCommandQueueService,
  ) {}

  private async enqueueGroupCommand(
    threadId: number,
    actorUserId: number,
    commandType: string,
    payload: Record<string, unknown>,
  ): Promise<DomainCommandAcceptedDto> {
    const address = await this.groupService.resolveGroupCommandScope(threadId);
    const { commandId } = await this.domainCommands.enqueue({
      aggregate: { type: 'GROUP', address },
      commandType,
      actorUserId,
      payload: { threadId, ...payload },
    });
    return { commandId: commandId.toString(), status: 'PENDING' };
  }

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
   * Validate each target and durably enqueue one group-scoped invitation command.
   */
  private async writeInvites(
    inviter: number,
    group: {
      threadId: number;
      account: string;
      domain: string;
    },
    userIds: number[],
  ): Promise<{
    invited: number[];
    commands: Array<{
      userId: number;
      commandId: string;
      status: 'PENDING';
    }>;
    skipped: { userId: number; reason: string }[];
  }> {
    const deduped = Array.from(new Set(userIds));
    const invited: number[] = [];
    const commands: Array<{
      userId: number;
      commandId: string;
      status: 'PENDING';
    }> = [];
    const skipped: { userId: number; reason: string }[] = [];
    const groupAccount = group.account;
    if (!groupAccount) {
      // Should not happen (inviter + group exist) — fail every target loudly rather than silent skip.
      return {
        invited,
        commands,
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
        const { commandId } = await this.domainCommands.enqueue({
          aggregate: {
            type: 'GROUP',
            address: { account: group.account, domain: group.domain },
          },
          commandType: DomainCommandType.INVITE_GROUP_MEMBER,
          actorUserId: inviter,
          payload: { threadId: group.threadId, targetUserId: userId },
        });
        invited.push(userId);
        commands.push({
          userId,
          commandId: commandId.toString(),
          status: 'PENDING',
        });
      } catch (e) {
        skipped.push({
          userId,
          reason: `invite failed: ${(e as Error)?.message ?? String(e)}`,
        });
      }
    }
    return { invited, commands, skipped };
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
    return this.writeInvites(
      inviter,
      {
        threadId,
        account: group?.account ?? '',
        domain: group?.domain ?? '',
      },
      dto.userIds,
    );
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
  @ApiResultResponse(DomainCommandAcceptedDto)
  async acceptJoinRequest(
    @Request() req: FastifyRequest,
    @Body() dto: HandleGroupJoinRequestDto,
  ): Promise<DomainCommandAcceptedDto> {
    const threadId = req.threadAccess!.threadId;
    const requestId = BigInt(dto.requestId);
    const request = await this.groupService.resolveGroupRequestCommandScope({
      threadId,
      managerUserId: req.user.userId,
      requestId,
      direction: 'APPLICATION',
    });
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DomainCommandType.ACCEPT_GROUP_JOIN_REQUEST,
      { requestId: requestId.toString(), memberUserId: request.memberUserId },
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
  @ApiResultResponse(DomainCommandAcceptedDto)
  async rejectJoinRequest(
    @Request() req: FastifyRequest,
    @Body() dto: HandleGroupJoinRequestDto,
  ): Promise<DomainCommandAcceptedDto> {
    const threadId = req.threadAccess!.threadId;
    const requestId = BigInt(dto.requestId);
    const request = await this.groupService.resolveGroupRequestCommandScope({
      threadId,
      managerUserId: req.user.userId,
      requestId,
      direction: 'APPLICATION',
    });
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DomainCommandType.REJECT_GROUP_JOIN_REQUEST,
      { requestId: requestId.toString(), memberUserId: request.memberUserId },
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
  @ApiResultResponse(DomainCommandAcceptedDto)
  async revokeInvitation(
    @Request() req: FastifyRequest,
    @Body() dto: HandleGroupJoinRequestDto,
  ): Promise<DomainCommandAcceptedDto> {
    const threadId = req.threadAccess!.threadId;
    const requestId = BigInt(dto.requestId);
    const request = await this.groupService.resolveGroupRequestCommandScope({
      threadId,
      managerUserId: req.user.userId,
      requestId,
      direction: 'INVITATION',
    });
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DomainCommandType.REVOKE_GROUP_INVITATION,
      { requestId: requestId.toString(), memberUserId: request.memberUserId },
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
  @ApiResultResponse(DomainCommandAcceptedDto)
  async joinRequestedGroup(
    @Request() req: FastifyRequest,
    @Body() dto: GroupIdDto,
  ): Promise<DomainCommandAcceptedDto> {
    const actorUserId = req.user.userId;
    const address =
      await this.federationService.resolveAcceptGroupRequestCommandScope(
        dto.groupId,
        actorUserId,
      );
    const { commandId } = await this.domainCommands.enqueue({
      aggregate: { type: 'GROUP', address },
      commandType: DomainCommandType.ACCEPT_GROUP_INVITATION,
      actorUserId,
      payload: { threadId: dto.groupId },
    });
    return { commandId: commandId.toString(), status: 'PENDING' };
  }

  @UseGuards(ThrottleGuard)
  @Throttle('group.join-request')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/federated-join-request')
  @ApiOperation({ summary: 'Apply to a federated group by Address' })
  @ApiResultResponse(DomainCommandAcceptedDto)
  async requestFederatedGroupJoin(
    @Request() req: FastifyRequest,
    @Body() dto: FederatedGroupJoinRequestDto,
  ): Promise<DomainCommandAcceptedDto> {
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
    const actorUserId = req.user.userId;
    const { commandId } = await this.domainCommands.enqueue({
      aggregate: { type: 'GROUP', address: { account, domain } },
      commandType: DomainCommandType.REQUEST_FEDERATED_GROUP_JOIN,
      actorUserId,
      payload: {
        account,
        domain,
        note: dto.note ?? '',
        displayName: dto.displayName,
        ...(dto.avatar ? { avatar: dto.avatar } : {}),
      },
    });
    return { commandId: commandId.toString(), status: 'PENDING' };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle('group.leave')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupTerminalActionDto>('groupId')
  @Post('group/leave')
  @ApiOperation({ summary: 'Leave a group (owner must transfer first)' })
  @ApiResultResponse(DomainCommandAcceptedDto)
  async leaveGroup(
    @Request() req: FastifyRequest,
    @Body() dto: GroupTerminalActionDto,
  ): Promise<DomainCommandAcceptedDto> {
    if (req.threadAccess!.groupDissolved) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    const threadId = req.threadAccess!.threadId;
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DomainCommandType.LEAVE_GROUP,
      { deleteData: dto.deleteData ?? false },
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle('group.dissolve')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupTerminalActionDto>('groupId')
  @Post('group/dissolve')
  @ApiOperation({ summary: 'Dissolve a group (owner only)' })
  @ApiResultResponse(DomainCommandAcceptedDto)
  async dissolveGroup(
    @Request() req: FastifyRequest,
    @Body() dto: GroupTerminalActionDto,
  ): Promise<DomainCommandAcceptedDto> {
    // Kept outside RolesGuard so a retry after a lost success response stays idempotent even though
    // RolesGuard rejects other mutations once dissolved. Ownership still comes from the guarded row.
    if (req.threadAccess.participant.role !== GroupRole.OWNER) {
      throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'owner only');
    }
    const threadId = req.threadAccess!.threadId;
    const actorUserId = req.user.userId;
    const address = await this.groupService.resolveDisbandCommandScope(
      threadId,
      actorUserId,
    );
    const { commandId } = await this.domainCommands.enqueue({
      aggregate: { type: 'GROUP', address },
      commandType: DomainCommandType.DISBAND_GROUP,
      actorUserId,
      payload: {
        threadId,
        deleteForUserId: dto.deleteData ? actorUserId : null,
      },
    });
    return { commandId: commandId.toString(), status: 'PENDING' };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.kick')
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<KickGroupDto>('groupId')
  @Post('group/kick')
  @ApiOperation({ summary: 'Kick a member (owner/admin, must outrank target)' })
  @ApiResultResponse(DomainCommandAcceptedDto)
  async kickMember(
    @Request() req: FastifyRequest,
    @Body() dto: KickGroupDto,
  ): Promise<DomainCommandAcceptedDto> {
    const threadId = req.threadAccess!.threadId;
    const target = await this.groupService.resolveActiveMember(threadId, dto);
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DomainCommandType.KICK_GROUP_MEMBER,
      { targetUserId: target.userId },
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.transfer')
  @Roles(GroupRole.OWNER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<TransferGroupDto>('groupId')
  @Post('group/transfer')
  @ApiOperation({ summary: 'Transfer ownership to a member (owner only)' })
  @ApiResultResponse(DomainCommandAcceptedDto)
  async transferOwnership(
    @Request() req: FastifyRequest,
    @Body() dto: TransferGroupDto,
  ): Promise<DomainCommandAcceptedDto> {
    const threadId = req.threadAccess!.threadId;
    const target = await this.groupService.resolveActiveMember(threadId, dto);
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DomainCommandType.TRANSFER_GROUP_OWNERSHIP,
      { targetUserId: target.userId },
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.set-role')
  @Roles(GroupRole.OWNER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<SetRoleGroupDto>('groupId')
  @Post('group/set-role')
  @ApiOperation({ summary: "Set a member's role to ADMIN/MEMBER (owner only)" })
  @ApiResultResponse(DomainCommandAcceptedDto)
  async setRole(
    @Request() req: FastifyRequest,
    @Body() dto: SetRoleGroupDto,
  ): Promise<DomainCommandAcceptedDto> {
    const threadId = req.threadAccess!.threadId;
    const target = await this.groupService.resolveActiveMember(threadId, dto);
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DomainCommandType.SET_GROUP_MEMBER_ROLE,
      { targetUserId: target.userId, role: dto.role },
    );
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
