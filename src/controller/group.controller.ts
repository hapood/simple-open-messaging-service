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
import { normalizeAccount } from '../common/account.js';
import { ThreadAccessGuard } from '../account-thread-state/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { RolesGuard } from '../group/roles.guard.js';
import { Roles } from '../group/roles.decorator.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import {
  CreateGroupDto,
  InviteGroupDto,
  GroupInviteAddressDto,
  GroupIdDto,
  KickGroupDto,
  TransferGroupDto,
  SetRoleGroupDto,
  UpdateGroupDto,
  QueryGroupJoinRequestsDto,
  QueryGroupInviteCandidatesDto,
  HandleGroupJoinRequestDto,
  ReadGroupJoinRequestsDto,
} from '../dto/group.dto.js';
import { CreateGroupResponseDto } from '../dto/response.dto.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskAcceptedDto } from '../dto/durable-task.dto.js';

@ApiTags('group')
@Controller()
export class GroupController {
  constructor(
    private readonly groupService: GroupService,
    private readonly participantService: AccountThreadStateService,
    private readonly federationService: FederationService,
    private readonly durableTasks: DurableTaskQueueService,
  ) {}

  private async enqueueGroupCommand(
    threadId: number,
    actorUserId: number,
    taskType: string,
    payload: Record<string, unknown>,
  ): Promise<DurableTaskAcceptedDto> {
    const address = await this.groupService.resolveGroupCommandScope(threadId);
    const { taskId } = await this.durableTasks.enqueueTask({
      scope: { type: 'GROUP', address },
      taskType,
      actorUserId,
      payload: { threadId, ...payload },
    });
    return { taskId: taskId.toString(), status: 'PENDING' };
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
   * Validate each target and durably enqueue one group-scoped invitation task.
   */
  private async writeInvites(
    inviter: number,
    group: {
      threadId: number;
      account: string;
      domain: string;
    },
    users: GroupInviteAddressDto[],
  ): Promise<{
    invited: GroupInviteAddressDto[];
    tasks: Array<{
      account: string;
      domain: string;
      taskId: string;
      status: 'PENDING';
    }>;
    skipped: (GroupInviteAddressDto & { reason: string })[];
  }> {
    const deduped = [
      ...new Map(
        users.map((user) => {
          const domain = user.domain.trim().toLowerCase();
          const address = {
            account: normalizeAccount(user.account),
            domain:
              domain === this.federationService.ourDomain ? 'local' : domain,
          };
          return [JSON.stringify(address), address];
        }),
      ).values(),
    ];
    const invited: GroupInviteAddressDto[] = [];
    const tasks: Array<{
      account: string;
      domain: string;
      taskId: string;
      status: 'PENDING';
    }> = [];
    const skipped: (GroupInviteAddressDto & { reason: string })[] = [];
    const groupAccount = group.account;
    if (!groupAccount) {
      // Should not happen (inviter + group exist) — fail every target loudly rather than silent skip.
      return {
        invited,
        tasks,
        skipped: deduped.map((address) => ({
          ...address,
          reason: 'inviter or group missing',
        })),
      };
    }
    for (const address of deduped) {
      const friend = await this.participantService.findP2PFriendByAddress(
        inviter,
        address,
      );
      if (!friend) {
        skipped.push({ ...address, reason: 'not a friend or no conversation' });
        continue;
      }
      try {
        const { taskId } = await this.durableTasks.enqueueTask({
          scope: {
            type: 'GROUP',
            address: { account: group.account, domain: group.domain },
          },
          taskType: DurableTaskType.INVITE_GROUP_MEMBER,
          actorUserId: inviter,
          payload: {
            threadId: group.threadId,
            targetUserId: {
              account: friend.account,
              domain: friend.domain,
              namespaceId: friend.namespaceId,
            },
          },
        });
        invited.push(address);
        tasks.push({
          ...address,
          taskId: taskId.toString(),
          status: 'PENDING',
        });
      } catch (e) {
        skipped.push({
          ...address,
          reason: `invite failed: ${(e as Error)?.message ?? String(e)}`,
        });
      }
    }
    return { invited, tasks, skipped };
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
      dto.users,
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
      dto.afterThreadId,
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
  @ApiResultResponse(DurableTaskAcceptedDto)
  async acceptJoinRequest(
    @Request() req: FastifyRequest,
    @Body() dto: HandleGroupJoinRequestDto,
  ): Promise<DurableTaskAcceptedDto> {
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
      DurableTaskType.ACCEPT_GROUP_JOIN_REQUEST,
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
  @ApiResultResponse(DurableTaskAcceptedDto)
  async rejectJoinRequest(
    @Request() req: FastifyRequest,
    @Body() dto: HandleGroupJoinRequestDto,
  ): Promise<DurableTaskAcceptedDto> {
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
      DurableTaskType.REJECT_GROUP_JOIN_REQUEST,
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
  @ApiResultResponse(DurableTaskAcceptedDto)
  async revokeInvitation(
    @Request() req: FastifyRequest,
    @Body() dto: HandleGroupJoinRequestDto,
  ): Promise<DurableTaskAcceptedDto> {
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
      DurableTaskType.REVOKE_GROUP_INVITATION,
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
  @ApiResultResponse(DurableTaskAcceptedDto)
  async joinRequestedGroup(
    @Request() req: FastifyRequest,
    @Body() dto: GroupIdDto,
  ): Promise<DurableTaskAcceptedDto> {
    const actorUserId = req.user.userId;
    const address =
      await this.federationService.resolveAcceptGroupRequestCommandScope(
        dto.groupId,
        actorUserId,
      );
    const { taskId } = await this.durableTasks.enqueueTask({
      scope: { type: 'GROUP', address },
      taskType: DurableTaskType.ACCEPT_GROUP_INVITATION,
      actorUserId,
      payload: { threadId: dto.groupId },
    });
    return { taskId: taskId.toString(), status: 'PENDING' };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle('group.leave')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/leave')
  @ApiOperation({ summary: 'Leave a group (owner must transfer first)' })
  @ApiResultResponse(DurableTaskAcceptedDto)
  async leaveGroup(
    @Request() req: FastifyRequest,
    @Body() dto: GroupIdDto,
  ): Promise<DurableTaskAcceptedDto> {
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
      DurableTaskType.LEAVE_GROUP,
      {},
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle('group.dissolve')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/dissolve')
  @ApiOperation({ summary: 'Dissolve a group (owner only)' })
  @ApiResultResponse(DurableTaskAcceptedDto)
  async dissolveGroup(
    @Request() req: FastifyRequest,
    @Body() dto: GroupIdDto,
  ): Promise<DurableTaskAcceptedDto> {
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
    const { taskId } = await this.durableTasks.enqueueTask({
      scope: { type: 'GROUP', address },
      taskType: DurableTaskType.DISBAND_GROUP,
      actorUserId,
      payload: { threadId },
    });
    return { taskId: taskId.toString(), status: 'PENDING' };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.kick')
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<KickGroupDto>('groupId')
  @Post('group/kick')
  @ApiOperation({ summary: 'Kick a member (owner/admin, must outrank target)' })
  @ApiResultResponse(DurableTaskAcceptedDto)
  async kickMember(
    @Request() req: FastifyRequest,
    @Body() dto: KickGroupDto,
  ): Promise<DurableTaskAcceptedDto> {
    const threadId = req.threadAccess!.threadId;
    const target = await this.groupService.resolveActiveMember(threadId, dto);
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DurableTaskType.KICK_GROUP_MEMBER,
      { targetUserId: target },
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
  @ApiResultResponse(DurableTaskAcceptedDto)
  async transferOwnership(
    @Request() req: FastifyRequest,
    @Body() dto: TransferGroupDto,
  ): Promise<DurableTaskAcceptedDto> {
    const threadId = req.threadAccess!.threadId;
    const target = await this.groupService.resolveActiveMember(threadId, dto);
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DurableTaskType.TRANSFER_GROUP_OWNERSHIP,
      { targetUserId: target },
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
  @ApiResultResponse(DurableTaskAcceptedDto)
  async setRole(
    @Request() req: FastifyRequest,
    @Body() dto: SetRoleGroupDto,
  ): Promise<DurableTaskAcceptedDto> {
    const threadId = req.threadAccess!.threadId;
    const target = await this.groupService.resolveActiveMember(threadId, dto);
    return this.enqueueGroupCommand(
      threadId,
      req.user.userId,
      DurableTaskType.SET_GROUP_MEMBER_ROLE,
      { targetUserId: target, role: dto.role },
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
      operatorUserId: req.user.userId,
      name: dto.name,
      description: dto.description,
      avatar: dto.avatar,
    });
  }
}
