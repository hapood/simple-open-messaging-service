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
import { GroupService } from '../group/group.service.js';
import { InviteService } from '../invite/invite.service.js';
import { FederationService } from '../federation/federation.service.js';
import { ThreadAccessGuard } from '../thread-participant/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { RolesGuard } from '../group/roles.guard.js';
import { Roles } from '../group/roles.decorator.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { SseService, GROUP_SSE } from '../gateway/sse.service.js';
import {
  CreateGroupDto,
  InviteGroupDto,
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
    private readonly inviteService: InviteService,
    private readonly sseService: SseService,
    private readonly federationService: FederationService,
  ) {}

  /**
   * Fan a group-lifecycle event to every active member of the thread, plus any extra users (e.g.
   * a kicked member who just ceased to be active). The payload carries groupId+threadId (BOTH equal
   * the threadId now that groups are `!`-User threads and Group.id is gone) so the client can route
   * it without a follow-up lookup.
   */
  private async fanoutGroup(
    threadId: number,
    eventName: (typeof GROUP_SSE)[keyof typeof GROUP_SSE],
    payload: Record<string, unknown>,
    extraUserIds: number[] = [],
  ) {
    const members = await this.participantService.getActiveParticipantUserIds(threadId);
    const ids = new Set<number>([
      ...members.map((m) => m.userId),
      ...extraUserIds,
    ]);
    const data = { groupId: threadId, threadId, ...payload };
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
      description: dto.description,
      avatar: dto.avatar,
      owner,
    });
    // Invite every selected friend into their P2P thread with the creator — they become members
    // only on group/join. Non-friends / write failures come back in `skipped`; the create itself
    // still succeeds for the owner and the rest.
    const { invited, skipped } = await this.writeInvites(
      owner,
      { threadId: grp.threadId, name: grp.name, avatar: grp.avatar, domain: this.federationService.ourDomain, isLocal: true },
      dto.inviteUserIds ?? [],
    );
    // groupId === threadId now (Group.id is gone; the wire keeps the `groupId` name for frontend compat).
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { threadId: grp.threadId, groupId: grp.threadId, invited, skipped },
    };
  }

  /**
   * Write one GROUP_INVITE card message into each target's P2P thread, minting an Invite row
   * (kind=GROUP, 7-day expiry) per friend and embedding its id. Shared by group/create (inviter = the
   * new owner) and group/invite. A target is SKIPPED (not fatal) if they are not a friend, have no P2P
   * thread, or the write throws. Returns the split so each caller can surface it.
   *
   * The card renders instantly from the message (inviter + group name/avatar + invite id); validity
   * (pending / expired / already-joined) is fetched on click via /invite/detail, and joining goes
   * through /invite/accept — no JWT token anymore. The Invite id stays stable across re-invites
   * (createGroupInvite overwrites in place), so a previously-delivered card still resolves.
   */
  private async writeInvites(
    inviter: number,
    group: { threadId: number; name: string; avatar: string; domain: string; isLocal: boolean },
    userIds: number[],
  ): Promise<{ invited: number[]; skipped: { userId: number; reason: string }[] }> {
    // Dedup defensively (the DTO layer already coerced types); order preserved.
    const deduped = Array.from(new Set(userIds));
    const invited: number[] = [];
    const skipped: { userId: number; reason: string }[] = [];
    for (const userId of deduped) {
      // Require an established P2P thread (i.e. an active friendship) to carry the invite card.
      const p2pThreadId = await this.participantService.findP2PThreadBetween(inviter, userId);
      if (p2pThreadId === null) {
        skipped.push({ userId, reason: 'not a friend or no conversation' });
        continue;
      }
      try {
        // Mint the Invite row (id stable across re-invites), then embed its id in the card message.
        const inviteId = await this.inviteService.createGroupInvite(inviter, group.threadId, userId);
        await this.messageService.writeMsgToThread(
          inviter,
          p2pThreadId,
          JSON.stringify({
            type: 'GROUP_INVITE',
            fromUserId: inviter,
            // groupId + groupAvatar let the invitee's card render group identity and offer an
            // "Open group" follow-through after joining (groupName already carried the name).
            groupId: group.threadId,
            groupName: group.name,
            groupAvatar: group.avatar,
            // The group's home domain — needed for federation (a cross-server join routes to the
            // origin server). For a local group this is our domain; a federated mirror carries the
            // peer domain (the !-User.domain, never the "local" sentinel). groupIsLocal lets the card
            // render a "Local server" label vs a globe+domain badge without the client knowing its own domain.
            groupDomain: group.domain,
            groupIsLocal: group.isLocal,
            inviteId,
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

  @UseGuards(JwtAuthGuard, ThreadAccessGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<InviteGroupDto>('groupId')
  @Post('group/invite')
  @ApiOperation({ summary: 'Invite friends to the group (invite token written to each P2P thread)' })
  async inviteUsers(
    @Request() req,
    @Body() dto: InviteGroupDto,
  ): Promise<ApiResult> {
    const threadId = req.threadAccess!.threadId;
    const inviter = req.user.userId;
    // Load the group's `!`-User for name/avatar to embed in the invite cards.
    const trd = await this.groupService.findGroupByThreadId(threadId);
    const gu = trd?.groupUser;
    // The group's home: local (our domain) vs a federated mirror (the peer domain on the !-User).
    const isLocal = !gu?.domain || gu.domain === 'local';
    const domain = isLocal ? this.federationService.ourDomain : (gu?.domain ?? this.federationService.ourDomain);
    const { invited, skipped } = await this.writeInvites(
      inviter,
      { threadId, name: gu?.name ?? '', avatar: gu?.avatar ?? '', domain, isLocal },
      dto.userIds,
    );
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: { invited, skipped },
    };
  }

  @UseGuards(JwtAuthGuard, ThreadAccessGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/info')
  @ApiOperation({ summary: 'Group info (members only)' })
  @ApiResultResponse(GroupResponseDto)
  async getGroupInfo(@Request() req): Promise<ApiResult> {
    // Membership already enforced by ThreadAccessGuard. Build GroupResponseDto from the `!`-User +
    // the owner (derived from the OWNER participant; Group.ownerId is gone).
    const threadId = req.threadAccess!.threadId;
    const trd = await this.groupService.findGroupByThreadId(threadId);
    const gu = trd?.groupUser;
    if (!trd || !gu) {
      return { code: BusinessCode.NOT_FOUND, message: 'group not found' };
    }
    const roster = await this.participantService.getRoster(threadId);
    const owner = roster.find((r) => r.role === GroupRole.OWNER);
    return {
      code: BusinessCode.OK,
      message: 'successful',
      data: {
        id: threadId,
        name: gu.name,
        ownerId: owner?.userId ?? 0,
        avatar: gu.avatar,
        description: gu.bio,
        threadId,
        createdAt: trd.createdAt.getTime(),
        updatedAt: trd.updatedAt.getTime(),
      },
    };
  }

  @UseGuards(JwtAuthGuard, ThreadAccessGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/members')
  @ApiOperation({ summary: 'Group roster with roles (members only)' })
  @ApiResultResponse(GroupMemberDto, true)
  async getMembers(@Request() req, @Body() _dto: GroupIdDto): Promise<ApiResult> {
    const threadId = req.threadAccess!.threadId;
    const rows = await this.participantService.getRoster(threadId);
    const data = rows.map((r) => ({
      userId: r.userId,
      account: r.user.account,
      name: r.user.name,
      avatar: r.user.avatar,
      role: r.role,
      joinedAt: r.joinedAt,
      isOwner: r.role === GroupRole.OWNER,
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

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard)
  @Throttle(20, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/leave')
  @ApiOperation({ summary: 'Leave a group (owner must transfer first)' })
  async leaveGroup(@Request() req, @Body() _dto: GroupIdDto): Promise<ApiResult> {
    const threadId = req.threadAccess!.threadId;
    const { participant } = req.threadAccess!;
    await this.groupService.leaveGroup({
      userId: req.user.userId,
      threadId,
      role: participant.role,
    });
    // Fans to all still-active members (= remaining after the soft-leave); the leaver is excluded.
    await this.fanoutGroup(threadId, GROUP_SSE.GROUP_MEMBER_LEFT, {
      userId: req.user.userId,
    });
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard, RolesGuard)
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
    const threadId = req.threadAccess!.threadId;
    const { participant } = req.threadAccess!;
    await this.groupService.kickMember({
      threadId,
      operatorRole: participant.role as GroupRole,
      targetUserId: dto.userId,
    });
    await this.fanoutGroup(
      threadId,
      GROUP_SSE.GROUP_MEMBER_KICKED,
      { userId: dto.userId, byUserId: req.user.userId },
      [dto.userId], // the kicked user may no longer be "active" after the soft-leave
    );
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard, RolesGuard)
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
    const threadId = req.threadAccess!.threadId;
    await this.groupService.transferOwnership({
      threadId,
      fromUserId: req.user.userId,
      toUserId: dto.toUserId,
    });
    // Two role changes: old owner → MEMBER, new owner → OWNER.
    await this.fanoutGroup(threadId, GROUP_SSE.GROUP_ROLE_CHANGED, {
      userId: req.user.userId,
      role: GroupRole.MEMBER,
      byUserId: req.user.userId,
    });
    await this.fanoutGroup(threadId, GROUP_SSE.GROUP_ROLE_CHANGED, {
      userId: dto.toUserId,
      role: GroupRole.OWNER,
      byUserId: req.user.userId,
    });
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard, RolesGuard)
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
    const threadId = req.threadAccess!.threadId;
    await this.groupService.setRole({
      threadId,
      targetUserId: dto.userId,
      role: dto.role,
      operatorUserId: req.user.userId,
    });
    await this.fanoutGroup(threadId, GROUP_SSE.GROUP_ROLE_CHANGED, {
      userId: dto.userId,
      role: dto.role,
      byUserId: req.user.userId,
    });
    return { code: BusinessCode.OK, message: 'successful' };
  }

  @UseGuards(JwtAuthGuard, ThrottleGuard, ThreadAccessGuard, RolesGuard)
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
    const threadId = req.threadAccess!.threadId;
    const updated = await this.groupService.updateGroup({
      threadId,
      name: dto.name,
      description: dto.description,
      avatar: dto.avatar,
    });
    // updated is the `!`-User row; description lives in User.bio.
    await this.fanoutGroup(threadId, GROUP_SSE.GROUP_UPDATED, {
      name: updated.name,
      description: updated.bio,
      avatar: updated.avatar,
    });
    return { code: BusinessCode.OK, message: 'successful' };
  }
}
