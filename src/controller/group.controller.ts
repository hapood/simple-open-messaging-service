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
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { user } from '../database/schema.js';
import { ThreadAccessGuard } from '../thread-participant/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { RolesGuard } from '../group/roles.guard.js';
import { Roles } from '../group/roles.decorator.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import {
  ThreadRevisionService,
  type PendingThreadRevision,
} from '../thread-revision/thread-revision.service.js';
import {
  CreateGroupDto,
  InviteGroupDto,
  GroupIdDto,
  GroupTerminalActionDto,
  KickGroupDto,
  TransferGroupDto,
  SetRoleGroupDto,
  UpdateGroupDto,
} from '../dto/group.dto.js';
import {
  CreateGroupResponseDto,
  GroupResponseDto,
} from '../dto/response.dto.js';

@ApiTags('group')
@Controller()
export class GroupController {
  constructor(
    private readonly groupService: GroupService,
    private readonly participantService: ThreadParticipantService,
    private readonly inviteService: InviteService,
    private readonly federationService: FederationService,
    private readonly userService: UserService,
    private readonly database: DatabaseService,
    private readonly threadRevision: ThreadRevisionService,
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
    // groupId === threadId now (Group.id is gone; the wire keeps the `groupId` name for frontend compat).
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
    const groupUserRow = await this.database.db.query.user.findFirst({
      where: eq(user.id, group.groupUserId),
      columns: { account: true },
    });
    const groupAccount = groupUserRow?.account;
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
        const clientRevisions: PendingThreadRevision[] = [];
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
                clientRevisions,
              );
          },
        );
        await this.federationService.pushStateFeedDomains(statePeers.keys());
        clientRevisions.forEach((pending) =>
          this.threadRevision.notifyThreadRevision(pending),
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
    // Load the group's `!`-User for name/avatar to embed in the invite cards.
    const trd = await this.groupService.findGroupByThreadId(threadId);
    const gu = trd?.groupUser;
    const role = req.threadAccess!.participant.role;
    if (
      gu?.group?.membersCanInvite === false &&
      role !== GroupRole.OWNER &&
      role !== GroupRole.ADMIN
    ) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'only group managers may invite',
      );
    }
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
    // Membership is already enforced by ThreadAccessGuard. The response is a complete group snapshot:
    // identity metadata plus authoritative membership and role facts.
    const threadId = req.threadAccess!.threadId;
    const trd = await this.groupService.findGroupByThreadId(threadId);
    const gu = trd?.groupUser;
    if (!trd || !gu) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
    }
    const roster = await this.participantService.getRoster(threadId);
    return {
      id: threadId,
      account: gu.account,
      name: gu.name,
      ownerId: gu.group?.ownerId ?? 0,
      avatar: gu.avatar,
      profileRev: gu.profileRev,
      description: gu.bio,
      membersCanInvite: gu.group?.membersCanInvite ?? true,
      // groupUser.domain uses 'local' as the origin sentinel; expose '' for a local-origin group,
      // matching UserResponseDto.domain for a local peer.
      domain: !gu.domain || gu.domain === 'local' ? '' : gu.domain,
      threadId,
      createdAt: trd.createdAt,
      updatedAt: gu.group?.updatedAt ?? trd.updatedAt,
      members: roster.map((member) => ({
        userId: member.userId,
        account: member.user.account,
        domain:
          !member.user.domain || member.user.domain === 'local'
            ? ''
            : member.user.domain,
        profileSourceDomain:
          !gu.domain || gu.domain === 'local' ? '' : gu.domain,
        role: member.role,
        joinedAt: member.joinedAt,
        isOwner: member.role === GroupRole.OWNER,
      })),
    };
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
    await this.groupService.kickMember({
      threadId,
      operatorUserId: req.user.userId,
      targetUserId: dto.userId,
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
    await this.groupService.transferOwnership({
      threadId,
      fromUserId: req.user.userId,
      toUserId: dto.toUserId,
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
    await this.groupService.setRole({
      threadId,
      targetUserId: dto.userId,
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
      membersCanInvite: dto.membersCanInvite,
    });
  }
}
