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
import { MessageService } from '../message/message.service.js';
import { ContentType, GroupRole } from '../prisma/generated/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResult, ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import dayjs from 'dayjs';
import { GroupService } from '../group/group.service.js';
import { GroupAccessGuard } from '../group/group-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { RolesGuard } from '../group/roles.guard.js';
import { Roles } from '../group/roles.decorator.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { FriendshipService } from '../friendship/friendship.service.js';
import { SseService, GROUP_SSE } from '../gateway/sse.service.js';
import {
  CreateGroupDto,
  InviteGroupDto,
  JoinGroupDto,
  GroupIdDto,
  KickGroupDto,
  TransferGroupDto,
  SetRoleGroupDto,
  UpdateGroupDto,
} from '../dto/group.dto.js';
import {
  CreateGroupResponseDto,
  GroupResponseDto,
  GroupMemberDto,
} from '../dto/response.dto.js';

/** Privilege rank for roster display ordering: OWNER, then ADMIN, then MEMBER. */
const ROLE_DISPLAY_RANK: Record<GroupRole, number> = {
  [GroupRole.OWNER]: 0,
  [GroupRole.ADMIN]: 1,
  [GroupRole.MEMBER]: 2,
};

@ApiTags('group')
@Controller()
export class GroupController {
  constructor(
    private readonly messageService: MessageService,
    private readonly groupService: GroupService,
    private readonly participantService: ThreadParticipantService,
    private readonly friendshipService: FriendshipService,
    private readonly sseService: SseService,
  ) {}

  /**
   * Fan a group-lifecycle event to every active member of the thread, plus any extra users (e.g.
   * a kicked member who just ceased to be active). Each payload carries groupId+threadId so the
   * client can route it without a follow-up lookup.
   */
  private async fanoutGroup(
    threadId: number,
    groupId: number,
    eventName: (typeof GROUP_SSE)[keyof typeof GROUP_SSE],
    payload: Record<string, unknown>,
    extraUserIds: number[] = [],
  ) {
    const members = await this.participantService.getActiveParticipantUserIds(threadId);
    const ids = new Set<number>([
      ...members.map((m) => m.userId),
      ...extraUserIds,
    ]);
    const data = { groupId, threadId, ...payload };
    ids.forEach((uid) => this.sseService.onGroupEvent(uid, eventName, data));
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard)
  @Throttle(10, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/create')
  @ApiOperation({ summary: 'Create a group and invite the given friends (invite token per friend)' })
  @ApiResultResponse(CreateGroupResponseDto)
  async createNewGroup(
    @Request() req,
    @Body() dto: CreateGroupDto,
  ): Promise<ApiResult> {
    const owner = req.user.userId;
    const grp = await this.groupService.createNewGroup({
      name: dto.name,
      avatar: dto.avatar,
      owner,
    });
    // Invite every selected friend into their P2P thread with the creator — they become members
    // only on group/join. Non-friends / write failures come back in `skipped`; the create itself
    // still succeeds for the owner and the rest.
    const { invited, skipped } = await this.writeInvites(
      owner,
      grp,
      dto.inviteUserIds ?? [],
    );
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { threadId: grp.threadId, groupId: grp.id, invited, skipped },
    };
  }

  /**
   * Write one GROUP_INVITE message into each target's P2P thread with the inviter, minting a 3-day
   * invite token per user. Shared by group/create (inviter = the new owner) and group/invite. A
   * target is SKIPPED (not fatal) if they are not a friend, have no P2P thread, or the write throws.
   * Returns the split so each caller can surface it.
   */
  private async writeInvites(
    inviter: number,
    group: { id: number; name: string; avatar: string },
    userIds: number[],
  ): Promise<{ invited: number[]; skipped: { userId: number; reason: string }[] }> {
    // One token expiry window shared across the batch — every invite from this action expires
    // together (3 days, as before).
    const expiryDate = dayjs().add(3, 'day').valueOf();
    // Dedup defensively (the DTO layer already coerced types); order preserved.
    const deduped = Array.from(new Set(userIds));
    const invited: number[] = [];
    const skipped: { userId: number; reason: string }[] = [];
    for (const userId of deduped) {
      // Require friendship + an established P2P thread to carry the invite message.
      const { friendship, isFriend } = await this.friendshipService.getFriendship(inviter, userId);
      if (!isFriend || !friendship?.threadId) {
        skipped.push({ userId, reason: 'not a friend or no conversation' });
        continue;
      }
      try {
        await this.messageService.writeMsgToThread(
          inviter,
          friendship.threadId,
          JSON.stringify({
            type: 'GROUP_INVITE',
            fromUserId: inviter,
            // groupId + groupAvatar let the invitee's card render group identity and offer an
            // "Open group" follow-through after joining (groupName already carried the name).
            groupId: group.id,
            groupName: group.name,
            groupAvatar: group.avatar,
            expiryDate,
            token: this.groupService.generateInviteToken({
              toUserId: userId,
              groupId: group.id,
              expiryDate,
            }),
          }),
          ContentType.INVITE,
        );
        invited.push(userId);
      } catch (e) {
        skipped.push({
          userId,
          reason: `invite write failed: ${(e as Error)?.message ?? String(e)}`,
        });
      }
    }
    return { invited, skipped };
  }

  @UseGuards(JwtAuthGuard, GroupAccessGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<InviteGroupDto>('groupId')
  @Post('group/invite')
  @ApiOperation({ summary: 'Invite friends to the group (invite token written to each P2P thread)' })
  async inviteUsers(
    @Request() req,
    @Body() dto: InviteGroupDto,
  ): Promise<ApiResult> {
    const group = req.groupAccess!.group;
    const inviter = req.user.userId;
    // Inviter membership is enforced by GroupAccessGuard; writeInvites handles friendship/P2P-thread
    // checks and per-user skip-on-failure, returning the {invited, skipped} split.
    const { invited, skipped } = await this.writeInvites(inviter, group, dto.userIds);
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { invited, skipped },
    };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/join')
  @ApiOperation({ summary: 'Join a group by invite token' })
  async joinGroup(
    @Request() req,
    @Body() dto: JoinGroupDto,
  ): Promise<ApiResult> {
    const res = this.groupService.decodeInviteToken(dto.token);
    switch (res.status) {
      case 0: {
        // Invite-token identity check: the caller must be the token's intended recipient.
        if (res.data.sub !== req.user.userId) {
          return {
            code: BusinessCode.GROUP_INVALID_TOKEN,
            message: 'invite is not for you',
          };
        }
        const r = await this.groupService.joinGroup({
          groupId: res.data.gid,
          userId: req.user.userId,
        });
        // Resolve the group once — its threadId is needed both to fan out the join event and to tell
        // the just-joined client which thread to open (returned in the response data).
        const group = await this.groupService.findUniqeGroup({ id: res.data.gid });
        if (r.status === 'ok' && group) {
          await this.fanoutGroup(
            group.threadId,
            group.id,
            GROUP_SSE.GROUP_MEMBER_JOINED,
            { userId: req.user.userId, role: GroupRole.MEMBER },
          );
        }
        return {
          code: BusinessCode.OK,
          message: r.status === 'ok' ? 'successful' : 'already a member',
          data: { threadId: group?.threadId },
        };
      }
      case 2:
        return {
          code: BusinessCode.GROUP_INVALID_TOKEN,
          message: 'invite expired',
        };
      default:
        return {
          code: BusinessCode.GROUP_INVALID_TOKEN,
          message: 'invalid invite',
        };
    }
  }

  @UseGuards(JwtAuthGuard, GroupAccessGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/info')
  @ApiOperation({ summary: 'Group info (members only)' })
  @ApiResultResponse(GroupResponseDto)
  async getGroupInfo(@Request() req): Promise<ApiResult> {
    // Membership already enforced by GroupAccessGuard; group is attached.
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: req.groupAccess!.group,
    };
  }

  @UseGuards(JwtAuthGuard, GroupAccessGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/members')
  @ApiOperation({ summary: 'Group roster with roles (members only)' })
  @ApiResultResponse(GroupMemberDto, true)
  async getMembers(@Request() req, @Body() _dto: GroupIdDto): Promise<ApiResult> {
    const { group } = req.groupAccess!;
    const rows = await this.participantService.getRoster(group.threadId);
    const data = rows.map((r) => ({
      userId: r.userId,
      uniqName: r.user.uniqName,
      name: r.user.userExtra.name,
      avatar: r.user.userExtra.avatar,
      role: r.role,
      joinedAt: r.joinedAt,
      isOwner: group.ownerId === r.userId,
    }));
    // Owner first, then admins, then members; within a role, by join time.
    data.sort(
      (a, b) =>
        ROLE_DISPLAY_RANK[a.role as GroupRole] -
          ROLE_DISPLAY_RANK[b.role as GroupRole] ||
        a.joinedAt.getTime() - b.joinedAt.getTime(),
    );
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: serializeBody(data),
    };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, GroupAccessGuard)
  @Throttle(20, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/leave')
  @ApiOperation({ summary: 'Leave a group (owner must transfer first)' })
  async leaveGroup(@Request() req, @Body() _dto: GroupIdDto): Promise<ApiResult> {
    const { group, participant } = req.groupAccess!;
    const { remainingMemberIds } = await this.groupService.leaveGroup({
      userId: req.user.userId,
      threadId: group.threadId,
      role: participant.role,
    });
    remainingMemberIds.forEach((uid) =>
      this.sseService.onGroupEvent(uid, GROUP_SSE.GROUP_MEMBER_LEFT, {
        groupId: group.id,
        threadId: group.threadId,
        userId: req.user.userId,
      }),
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, GroupAccessGuard, RolesGuard)
  @Throttle(20, 60)
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<KickGroupDto>('groupId')
  @Post('group/kick')
  @ApiOperation({ summary: 'Kick a member (owner/admin, must outrank target)' })
  async kickMember(
    @Request() req,
    @Body() dto: KickGroupDto,
  ): Promise<ApiResult> {
    const { group, participant } = req.groupAccess!;
    await this.groupService.kickMember({
      threadId: group.threadId,
      operatorRole: participant.role as GroupRole,
      targetUserId: dto.userId,
    });
    await this.fanoutGroup(
      group.threadId,
      group.id,
      GROUP_SSE.GROUP_MEMBER_KICKED,
      { userId: dto.userId, byUserId: req.user.userId },
      [dto.userId], // the kicked user may no longer be "active" after the soft-leave
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, GroupAccessGuard, RolesGuard)
  @Throttle(20, 60)
  @Roles(GroupRole.OWNER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<TransferGroupDto>('groupId')
  @Post('group/transfer')
  @ApiOperation({ summary: 'Transfer ownership to a member (owner only)' })
  async transferOwnership(
    @Request() req,
    @Body() dto: TransferGroupDto,
  ): Promise<ApiResult> {
    const { group } = req.groupAccess!;
    await this.groupService.transferOwnership({
      groupId: group.id,
      threadId: group.threadId,
      fromUserId: req.user.userId,
      toUserId: dto.toUserId,
    });
    // Two role changes: old owner → MEMBER, new owner → OWNER.
    await this.fanoutGroup(group.threadId, group.id, GROUP_SSE.GROUP_ROLE_CHANGED, {
      userId: req.user.userId,
      role: GroupRole.MEMBER,
      byUserId: req.user.userId,
    });
    await this.fanoutGroup(group.threadId, group.id, GROUP_SSE.GROUP_ROLE_CHANGED, {
      userId: dto.toUserId,
      role: GroupRole.OWNER,
      byUserId: req.user.userId,
    });
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, GroupAccessGuard, RolesGuard)
  @Throttle(20, 60)
  @Roles(GroupRole.OWNER)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<SetRoleGroupDto>('groupId')
  @Post('group/set-role')
  @ApiOperation({ summary: "Set a member's role to ADMIN/MEMBER (owner only)" })
  async setRole(
    @Request() req,
    @Body() dto: SetRoleGroupDto,
  ): Promise<ApiResult> {
    const { group } = req.groupAccess!;
    await this.groupService.setRole({
      threadId: group.threadId,
      targetUserId: dto.userId,
      role: dto.role,
      operatorUserId: req.user.userId,
    });
    await this.fanoutGroup(group.threadId, group.id, GROUP_SSE.GROUP_ROLE_CHANGED, {
      userId: dto.userId,
      role: dto.role,
      byUserId: req.user.userId,
    });
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, GroupAccessGuard, RolesGuard)
  @Throttle(20, 60)
  @Roles(GroupRole.OWNER, GroupRole.ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<UpdateGroupDto>('groupId')
  @Post('group/update')
  @ApiOperation({ summary: 'Update group name/avatar (admin+)' })
  async updateGroup(
    @Request() req,
    @Body() dto: UpdateGroupDto,
  ): Promise<ApiResult> {
    const { group } = req.groupAccess!;
    const updated = await this.groupService.updateGroup({
      groupId: group.id,
      name: dto.name,
      avatar: dto.avatar,
    });
    await this.fanoutGroup(group.threadId, group.id, GROUP_SSE.GROUP_UPDATED, {
      name: updated.name,
      avatar: updated.avatar,
    });
    return { code: BusinessCode.OK, message: 'successful' };
  }
}
