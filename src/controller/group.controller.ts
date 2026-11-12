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
import { decideMemberGroupRound } from './member-group-round-decision.js';
import { GroupRole } from '../database/enums.js';
import { ThrottleGuard, Throttle } from '../rate-limit/throttle.guard.js';
import {
  ApiEnvelope,
  ApiResultResponse,
  businessEnvelope,
} from '../common/api-result.js';
import {
  GroupRosterRoleOutcome,
  GroupRosterRoleService,
} from '../group/roster-role/group-roster-role.service.js';
import { isBusinessRejection } from '../common/business-command-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { RelationshipRequestService } from '../relationship/request/relationship-request.service.js';
import { RequestDecisionDto } from '../dto/relationship-request.dto.js';
import { GroupService } from '../group/group.service.js';
import { normalizeAccount } from '../common/account.js';
import { ThreadAccessGuard } from '../account-thread-state/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { RolesGuard } from '../group/roles.guard.js';
import { Roles } from '../group/roles.decorator.js';
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
  HandleGroupJoinRequestDto,
  ReadGroupJoinRequestsDto,
  SetGroupAnnouncementDto,
  ReadGroupAnnouncementDto,
} from '../dto/group.dto.js';
import { CreateGroupResponseDto } from '../dto/response.dto.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { DurableTaskAcceptedDto } from '../dto/durable-task.dto.js';
import {
  GroupAuthoredMembershipIntentService,
  type GroupAuthoredMembershipIntentResult,
} from '../group/membership-intent/authored/group-authored-membership-intent.service.js';
import {
  MemberAuthoredGroupMembershipIntentService,
  type MemberAuthoredGroupMembershipIntentResult,
} from '../group/membership-intent/authored/member-authored-group-membership-intent.service.js';

@ApiTags('group')
@Controller()
export class GroupController {
  constructor(
    private readonly requests: RelationshipRequestService,
    private readonly groupService: GroupService,
    private readonly durableTasks: DurableTaskQueueService,
    private readonly rosterRoles: GroupRosterRoleService,
    private readonly groupIntents: GroupAuthoredMembershipIntentService,
    private readonly memberIntents: MemberAuthoredGroupMembershipIntentService,
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

  /** Execute one manager-authored invitation transaction per deduplicated target. */
  private async writeInvites(
    inviter: number,
    threadId: number,
    users: GroupInviteAddressDto[],
  ): Promise<{
    invited: Array<Pick<GroupInviteAddressDto, 'account' | 'namespaceId'>>;
    skipped: Array<
      Pick<GroupInviteAddressDto, 'account' | 'namespaceId'> & {
        reason: string;
        code: BusinessCode;
        message: string;
      }
    >;
  }> {
    const deduped = [
      ...new Map(
        users.map((user) => {
          const address = {
            account: normalizeAccount(user.account),
            namespaceId: user.namespaceId,
          };
          return [
            JSON.stringify(address),
            { ...address, snapshot: user.snapshot },
          ];
        }),
      ).values(),
    ];
    const invited: Array<
      Pick<GroupInviteAddressDto, 'account' | 'namespaceId'>
    > = [];
    const skipped: Array<
      Pick<GroupInviteAddressDto, 'account' | 'namespaceId'> & {
        reason: string;
        code: BusinessCode;
        message: string;
      }
    > = [];
    for (const { snapshot, ...address } of deduped) {
      const result = await this.groupIntents.execute({
        threadId,
        managerUserId: inviter,
        decision: 'REQUESTED',
        snapshot,
        target: address,
      });
      if (isBusinessRejection(result)) {
        skipped.push({
          ...address,
          reason: result.reason,
          code: result.code,
          message: result.message,
        });
      } else {
        invited.push(address);
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
    summary: 'Invite users to an existing group',
  })
  async inviteUsers(
    @Request() req: FastifyRequest,
    @Body() dto: InviteGroupDto,
  ) {
    const threadId = req.threadAccess!.threadId;
    const inviter = req.user.userId;
    return this.writeInvites(inviter, threadId, dto.users);
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
    return this.requests.queryGroup(
      req.user.userId,
      dto.groupId,
      'APPLICATION',
      dto,
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
    return this.requests.queryGroup(
      req.user.userId,
      dto.groupId,
      'INVITATION',
      dto,
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
      dto.joinRequestReadFeedId,
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
  ) {
    return this.managerGroupRoundDecision(
      req.user.userId,
      dto,
      'APPLICATION',
      'ACCEPT',
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
  ) {
    return this.managerGroupRoundDecision(
      req.user.userId,
      dto,
      'APPLICATION',
      'REJECT',
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
  ) {
    return this.managerGroupRoundDecision(
      req.user.userId,
      dto,
      'INVITATION',
      'WITHDRAW',
    );
  }

  @UseGuards(ThrottleGuard)
  @Throttle('group.join-request')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/join-request')
  @ApiOperation({
    summary: 'Accept an exact received group invitation round',
  })
  async joinRequestedGroup(
    @Request() req: FastifyRequest,
    @Body() dto: RequestDecisionDto,
  ) {
    return this.memberGroupRoundDecision(
      req.user.userId,
      dto.requestId,
      'ACCEPT',
    );
  }

  @UseGuards(ThrottleGuard)
  @Throttle('group.join-request')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/invitation/decline')
  @ApiOperation({
    summary: 'Decline an exact received group invitation round',
  })
  async declineGroupInvitation(
    @Request() req: FastifyRequest,
    @Body() dto: RequestDecisionDto,
  ) {
    return this.memberGroupRoundDecision(
      req.user.userId,
      dto.requestId,
      'REJECT',
    );
  }

  @UseGuards(ThrottleGuard)
  @Throttle('group.join-request')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/join-request/withdraw')
  @ApiOperation({
    summary: "Withdraw the member's own pending group application round",
  })
  async withdrawGroupApplication(
    @Request() req: FastifyRequest,
    @Body() dto: RequestDecisionDto,
  ) {
    return this.memberGroupRoundDecision(
      req.user.userId,
      dto.requestId,
      'WITHDRAW',
    );
  }

  /** Shared member-side round decision: the round locates the group;
   * admission revalidates the exact round under the membership state
   * machine's locks via the requestDecision gate. APPLIED and the idempotent
   * NO_OP both satisfy the round. */
  private async memberGroupRoundDecision(
    userId: number,
    requestId: string,
    decision: 'ACCEPT' | 'REJECT' | 'WITHDRAW',
  ) {
    return decideMemberGroupRound(
      { requests: this.requests, memberIntents: this.memberIntents },
      userId,
      requestId,
      decision,
    );
  }

  /** Shared manager-side round decision: the round resolves the addressed
   * member for the known group thread, then the authored membership state
   * machine settles it (activation, system message, fan-out, meta facts)
   * with the exact-round gate under its locks. */
  private async managerGroupRoundDecision(
    managerUserId: number,
    dto: HandleGroupJoinRequestDto,
    scope: 'APPLICATION' | 'INVITATION',
    decision: 'ACCEPT' | 'REJECT' | 'WITHDRAW',
  ) {
    const resolution = await this.requests.resolveManagerGroupRound(
      managerUserId,
      dto.groupId,
      dto.requestId,
      scope,
    );
    if (resolution.status === 'STALE_REQUEST') return resolution;
    const outcome = await this.groupIntents.execute(
      {
        threadId: dto.groupId,
        managerUserId,
        decision: decision === 'ACCEPT' ? 'ACCEPTED' : 'REVOKED',
        target: resolution.member,
        scope,
      },
      {
        requestDecision: {
          requestId: BigInt(dto.requestId),
          decision,
        },
      },
    );
    if (outcome.status === 'STALE_REQUEST' || outcome.status === 'EXPIRED')
      return outcome;
    if (isBusinessRejection(outcome))
      return businessEnvelope(outcome.code, outcome.message, {
        status: outcome.status,
        reason: outcome.reason,
      });
    return { status: 'OK', threadId: dto.groupId };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle('group.update')
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<SetGroupAnnouncementDto>('groupId')
  @Post('group/announcement/set')
  @ApiOperation({ summary: 'Publish or clear the origin group announcement' })
  async setAnnouncement(
    @Request() req: FastifyRequest,
    @Body() dto: SetGroupAnnouncementDto,
  ) {
    return this.groupService.setAnnouncement({
      threadId: req.threadAccess!.threadId,
      operatorUserId: req.user.userId,
      text: dto.text,
    });
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle('thread.mark-read')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<ReadGroupAnnouncementDto>('groupId')
  @Post('group/announcement/read')
  @ApiOperation({
    summary: 'Acknowledge a displayed group announcement coordinate',
  })
  async markAnnouncementRead(
    @Request() req: FastifyRequest,
    @Body() dto: ReadGroupAnnouncementDto,
  ) {
    return this.groupService.markAnnouncementRead({
      threadId: req.threadAccess!.threadId,
      accountId: req.user.userId,
      feedId: dto.announcementFeedId,
    });
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle('group.leave')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/leave')
  @ApiOperation({ summary: 'Leave a group (owner must transfer first)' })
  async leaveGroup(@Request() req: FastifyRequest, @Body() _dto: GroupIdDto) {
    void _dto;
    return this.memberIntentResult(
      await this.memberIntents.execute({
        threadId: req.threadAccess!.threadId,
        memberUserId: req.user.userId,
        decision: 'REVOKED',
      }),
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
    @Body() _dto: GroupIdDto,
  ): Promise<DurableTaskAcceptedDto> {
    void _dto;
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
  async kickMember(
    @Request() req: FastifyRequest,
    @Body() dto: KickGroupDto,
  ): Promise<GroupAuthoredMembershipIntentResult | ApiEnvelope> {
    return this.groupIntentResult(
      await this.groupIntents.execute({
        threadId: req.threadAccess!.threadId,
        managerUserId: req.user.userId,
        decision: 'REVOKED',
        scope: 'MEMBER',
        target: this.managerTarget(dto),
      }),
    );
  }

  private managerTarget(dto: { account: string; namespaceId: number }) {
    return {
      account: normalizeAccount(dto.account.trim()),
      namespaceId: dto.namespaceId,
    };
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
  ): Promise<GroupRosterRoleOutcome | ApiEnvelope> {
    return this.rosterRoleResult(
      await this.rosterRoles.execute({
        threadId: req.threadAccess!.threadId,
        operatorUserId: req.user.userId,
        kind: 'TRANSFER_OWNERSHIP',
        target: this.rosterRoleTarget(dto),
      }),
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
  async setRole(
    @Request() req: FastifyRequest,
    @Body() dto: SetRoleGroupDto,
  ): Promise<GroupRosterRoleOutcome | ApiEnvelope> {
    return this.rosterRoleResult(
      await this.rosterRoles.execute({
        threadId: req.threadAccess!.threadId,
        operatorUserId: req.user.userId,
        kind: 'SET_ROLE',
        target: this.rosterRoleTarget(dto),
        role: dto.role,
      }),
    );
  }

  /** Wire-level target identity; the business re-resolves and authorizes it
   * under its locks. */
  private rosterRoleTarget(dto: TransferGroupDto | SetRoleGroupDto) {
    return {
      account: normalizeAccount(dto.account),
      namespaceId: dto.namespaceId,
    };
  }

  /** Synchronous roster-role result: refusals stay envelope data at HTTP 200,
   * so clients keep branching on the stable top-level business code. */
  private rosterRoleResult(outcome: GroupRosterRoleOutcome) {
    if (isBusinessRejection(outcome))
      return businessEnvelope(outcome.code, outcome.message, {
        status: outcome.status,
        reason: outcome.reason,
      });
    return outcome;
  }

  private memberIntentResult(
    outcome: MemberAuthoredGroupMembershipIntentResult,
  ) {
    if (isBusinessRejection(outcome))
      return businessEnvelope(outcome.code, outcome.message, {
        status: outcome.status,
        reason: outcome.reason,
      });
    return outcome;
  }

  private groupIntentResult(outcome: GroupAuthoredMembershipIntentResult) {
    if (isBusinessRejection(outcome))
      return businessEnvelope(outcome.code, outcome.message, {
        status: outcome.status,
        reason: outcome.reason,
      });
    return outcome;
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
