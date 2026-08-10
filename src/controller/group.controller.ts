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
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { ContentType, GroupRole } from '../database/enums.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResultResponse } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { GroupService } from '../group/group.service.js';
import { InviteService } from '../invite/invite.service.js';
import { FederationService } from '../federation/federation.service.js';
import { UserService } from '../user/user.service.js';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { user } from '../database/schema.js';
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
  GroupTerminalActionDto,
  GroupMembersBatchDto,
  KickGroupDto,
  TransferGroupDto,
  SetRoleGroupDto,
  UpdateGroupDto,
} from '../dto/group.dto.js';
import {
  CreateGroupResponseDto,
  GroupResponseDto,
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
    private readonly messageFanoutService: MessageFanoutService,
    private readonly groupService: GroupService,
    private readonly participantService: ThreadParticipantService,
    private readonly inviteService: InviteService,
    private readonly sseService: SseService,
    private readonly federationService: FederationService,
    private readonly userService: UserService,
    private readonly database: DatabaseService,
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
    const members =
      await this.participantService.getActiveParticipantUserIds(threadId);
    const ids = new Set<number>([
      ...members.map((m) => m.userId),
      ...extraUserIds,
    ]);
    const data = { groupId: threadId, threadId, ...payload };
    ids.forEach((uid) => this.sseService.onGroupEvent(uid, eventName, data));
  }

  @UseGuards(ThrottleGuard)
  @Throttle(10, 60)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/create')
  @ApiOperation({
    summary:
      'Create a group and invite the given friends (Invite row + card per friend)',
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
    // Invite every selected friend into their P2P thread with the creator — they become members
    // only on group/join. Non-friends / write failures come back in `skipped`; the create itself
    // still succeeds for the owner and the rest.
    const { invited, skipped } = await this.writeInvites(
      owner,
      {
        threadId: grp.threadId,
        groupUserId: grp.id,
        name: grp.name,
        avatar: grp.avatar,
        profileRev: 0,
      },
      dto.inviteUserIds ?? [],
    );
    // groupId === threadId now (Group.id is gone; the wire keeps the `groupId` name for frontend compat).
    return { threadId: grp.threadId, groupId: grp.threadId, invited, skipped };
  }

  /**
   * Invite friends into a group — LOCAL and FEDERATED now share ONE card shape, addressed by the group's
   * `!account` (no internal ids). The card is ALWAYS written into the inviter's P2P thread with the
   * target: for a LOCAL friend that thread is shared (the target sees it directly); for a FEDERATED friend
   * it is the inviter's P2P MIRROR, and the card flows to the invitee via the Step-2 P2P message pull
   * (Phase B). The invitee resolves their pending invite by the `group` account (/invite/detail). The
   * federated branch ALSO sends the cross-server invite (sendInvite GROUP) so the peer creates the mirror
   * + the incoming Invite BEFORE the card arrives (the card's /invite/detail must find a row). Re-invites
   * overwrite the Invite in place (stable id). A target is SKIPPED (not fatal) on a write/send failure.
   */
  private async writeInvites(
    inviter: number,
    group: {
      threadId: number;
      groupUserId: number;
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
    // The group's `!account` — the federated-stable identity on the card (== fedGroupAccount once the
    // first federated invite mints it; for a purely-local group it is just the groupUser account). Both
    // resolve the invite cross-server via the @@unique-backed (toUser, thread) lookup.
    const [inviterRow, groupUserRow] = await Promise.all([
      this.database.db.query.user.findFirst({
        where: eq(user.id, inviter),
        columns: { account: true },
      }),
      this.database.db.query.user.findFirst({
        where: eq(user.id, group.groupUserId),
        columns: { account: true, domain: true },
      }),
    ]);
    const inviterAccount = inviterRow?.account;
    const groupAccount = groupUserRow?.account;
    if (!inviterAccount || !groupAccount) {
      // Should not happen (inviter + group exist) — fail every target loudly rather than silent skip.
      return {
        invited,
        skipped: deduped.map((userId) => ({
          userId,
          reason: 'inviter or group missing',
        })),
      };
    }
    // groupUser.domain: 'local' = we are the origin; <peer> = a federated mirror. The card carries the
    // group's home domain so it renders on BOTH the inviter's + invitee's side without a fetch
    // (/invite/detail is invitee-only — it 404s for the inviter's own copy of the card). The avatar path is
    // same-origin for a local group; a federated viewer's row falls back to a letter avatar and the dialog
    // resolves the authoritative localized avatar via /invite/detail(group).
    const groupIsLocal =
      !groupUserRow?.domain || groupUserRow.domain === 'local';
    const groupDomain = groupIsLocal
      ? this.federationService.ourDomain
      : (groupUserRow!.domain as string);
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
        await this.inviteService.createGroupInvite(
          inviter,
          group.threadId,
          userId,
          '',
          undefined,
          async (tx) => {
            statePeers =
              await this.federationService.writeGroupInviteIntentInTx(
                tx,
                group.threadId,
                userId,
              );
          },
        );
        await this.federationService.pushStateFeedDomains(statePeers.keys());
        // Card identity = accounts only (`from` = inviter account, `group` = the `!account`); the invitee
        // resolves + accepts by `group` (/invite/detail + /invite/accept take a group account). The display
        // fields are carried inline so the row renders instantly on both sides with no per-row fetch and no
        // internal ids on the card.
        const inviteMsg = await this.messageService.writeMsgToThread(
          inviter,
          p2pThreadId,
          JSON.stringify({
            type: 'GROUP_INVITE',
            from: inviterAccount,
            group: groupAccount,
            groupName: group.name,
            groupAvatar: group.avatar || undefined,
            groupDomain,
            groupIsLocal,
          }),
          ContentType.INVITE,
        );
        // Deliver the card LIVE, exactly like a normal send: dispatch fans NEW_MESSAGE to every active
        // participant of the P2P thread (LOCAL → the invitee sees the card the instant it is written; no
        // more "only on next list refresh"), and its federation leg
        // marks the inviter's mirror dirty so the invitee's server promptly pulls the card via the Step-2
        // P2P path → storePulledMessage → NEW_MESSAGE (FEDERATED). Without this the invitee had no live
        // discovery path. Fire-and-forget: the card is already committed; a fan-out failure degrades to
        // the existing chat-open pull backstop, never a lost invite.
        void this.messageFanoutService.dispatch(inviteMsg);
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
    summary:
      'Invite friends to an existing group (Invite row + card per friend)',
  })
  async inviteUsers(
    @Request() req: FastifyRequest,
    @Body() dto: InviteGroupDto,
  ) {
    const threadId = req.threadAccess!.threadId;
    const inviter = req.user.userId;
    // Load the group's `!`-User for name/avatar to embed in the invite cards.
    const trd = await this.groupService.findGroupByThreadId(threadId);
    const gu = trd?.groupUser;
    const { invited, skipped } = await this.writeInvites(
      inviter,
      {
        threadId,
        groupUserId: gu?.id ?? 0,
        name: gu?.name ?? '',
        avatar: gu?.avatar ?? '',
        profileRev: gu?.profileRev ?? 0,
      },
      dto.userIds,
    );
    return { invited, skipped };
  }

  @UseGuards(ThreadAccessGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ResourceId<GroupIdDto>('groupId')
  @Post('group/info')
  @ApiOperation({ summary: 'Group info (members only)' })
  @ApiResultResponse(GroupResponseDto)
  async getGroupInfo(@Request() req: FastifyRequest) {
    // Membership already enforced by ThreadAccessGuard. Build GroupResponseDto from the `!`-User
    // (identity) + the Group row (ownerId + updatedAt). The roster is NOT loaded here — it has its own
    // /group/members endpoint; group info carries only identity + owner + revision timestamps.
    const threadId = req.threadAccess!.threadId;
    const trd = await this.groupService.findGroupByThreadId(threadId);
    const gu = trd?.groupUser;
    if (!trd || !gu) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
    }
    return {
      id: threadId,
      account: gu.account,
      name: gu.name,
      ownerId: gu.group?.ownerId ?? 0,
      avatar: gu.avatar,
      profileRev: gu.profileRev,
      description: gu.bio,
      // groupUser.domain uses 'local' as the origin sentinel; expose '' for a local-origin group so the
      // client federated-badge self-hides (parity with UserResponseDto.domain for a local peer).
      domain: !gu.domain || gu.domain === 'local' ? '' : gu.domain,
      threadId,
      createdAt: trd.createdAt,
      updatedAt: gu.group?.updatedAt ?? trd.updatedAt,
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('group/members')
  @ApiOperation({
    summary:
      'Batch fetch group rosters (members only; caller membership filtered)',
  })
  async getMembers(
    @Request() req: FastifyRequest,
    @Body() dto: GroupMembersBatchDto,
  ) {
    const me = req.user.userId;
    const rows = await this.participantService.getRosters(dto.threadIds);
    // Group by threadId; keep only threads where the caller is an active member (roster contains me).
    const byThread = new Map<number, Array<(typeof rows)[number]>>();
    for (const r of rows) {
      const arr = byThread.get(r.threadId);
      if (arr) arr.push(r);
      else byThread.set(r.threadId, [r]);
    }
    return [...byThread.entries()]
      .filter(([, members]) => members.some((m) => m.userId === me))
      .map(([threadId, members]) => {
        const mapped = members.map((r) => ({
          userId: r.userId,
          account: r.user.account,
          name: r.user.name,
          avatar: r.user.avatar,
          // Pass through verbatim — a local member's User.domain is already '' (not the 'local' sentinel),
          // so the badge self-hides for locals and shows the peer domain for federated stubs.
          isForeigner: r.user.isForeigner,
          domain: r.user.domain,
          role: r.role,
          joinedAt: r.joinedAt,
          isOwner: r.role === GroupRole.OWNER,
        }));
        // Owner first, then admins, then members; within a role, by join time.
        mapped.sort(
          (a, b) =>
            ROLE_DISPLAY_RANK[a.role as GroupRole] -
              ROLE_DISPLAY_RANK[b.role as GroupRole] ||
            a.joinedAt.getTime() - b.joinedAt.getTime(),
        );
        return { threadId, members: serializeBody(mapped) };
      });
  }

  @UseGuards(ThrottleGuard)
  @Throttle(20, 60)
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

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle(20, 60)
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
    const result = await this.groupService.leaveGroup({
      userId: req.user.userId,
      threadId,
      role: participant.role,
      deleteData: dto.deleteData ?? false,
    });
    // Fans to all still-active members (= remaining after the soft-leave); the leaver is excluded.
    if (result.transitioned) {
      await this.fanoutGroup(threadId, GROUP_SSE.GROUP_ROSTER_UPDATED, {});
    }
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @Throttle(10, 60)
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
    const result = await this.groupService.dissolveGroup({
      threadId,
      deleteForUserId: dto.deleteData ? req.user.userId : undefined,
    });
    if (result.transitioned) {
      await this.fanoutGroup(threadId, GROUP_SSE.GROUP_UPDATED, {
        dissolved: true,
      });
    }
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle(20, 60)
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
    const result = await this.groupService.kickMember({
      threadId,
      operatorUserId: req.user.userId,
      targetUserId: dto.userId,
    });
    if (result.transitioned) {
      await this.fanoutGroup(
        threadId,
        GROUP_SSE.GROUP_ROSTER_UPDATED,
        {},
        [dto.userId], // the kicked user may no longer be "active" after the soft-leave
      );
    }
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle(20, 60)
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
    await this.groupService.transferOwnership({
      threadId,
      fromUserId: req.user.userId,
      toUserId: dto.toUserId,
    });
    // Signal-only: members pull the fresh roster (GroupService.transferOwnership bumped rosterRev +
    // flipped ownerId). The former two GROUP_ROLE_CHANGED events collapse into one roster-refresh signal.
    await this.fanoutGroup(threadId, GROUP_SSE.GROUP_ROSTER_UPDATED, {});
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle(20, 60)
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
    await this.groupService.setRole({
      threadId,
      targetUserId: dto.userId,
      role: dto.role,
      operatorUserId: req.user.userId,
    });
    await this.fanoutGroup(threadId, GROUP_SSE.GROUP_ROSTER_UPDATED, {});
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard, RolesGuard)
  @Throttle(20, 60)
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
    // updated is the `!`-User row; description lives in User.bio. Signal-only: the client receives
    // { threadId } and HTTP-pulls /group/info to refresh (GroupService.updateGroup bumped profileRev).
    await this.fanoutGroup(threadId, GROUP_SSE.GROUP_UPDATED, {});
  }
}
