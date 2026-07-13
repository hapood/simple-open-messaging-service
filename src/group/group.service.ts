import { Injectable, OnModuleInit, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import {
  GroupRole,
  MessageThreadType,
  Prisma,
} from '../prisma/generated/client.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { mintGroupAccount, isP2002 } from '../common/account.js';
import { ThreadRevisionService } from '../thread-revision/thread-revision.service.js';

/** Privilege rank — LOWER is more privileged (OWNER outranks ADMIN outranks MEMBER). */
function roleRank(role: GroupRole | null): number {
  switch (role) {
    case GroupRole.OWNER:
      return 0;
    case GroupRole.ADMIN:
      return 1;
    default:
      return 2; // MEMBER (group participants always have a non-null role)
  }
}

/** Strict outrank: the operator may act on the target iff their rank is strictly lower. */
function outranks(operator: GroupRole, target: GroupRole | null): boolean {
  return roleRank(operator) < roleRank(target);
}

/**
 * Group lifecycle: creation, invite-token mint/verify, joining, and the membership/role mutations
 * (leave/kick/transfer/set-role/update).
 *
 * A group IS a `!`-sigil User row (account="!"+ULID, isGroup=true) carrying name/avatar/bio; the Group
 * table is abolished. The group↔thread link is MessageThread.groupUserId, and
 * the owner is derived from ThreadParticipant.role=OWNER (no ownerId column). All group-management
 * operations now key on threadId (the stable handle, also used for messaging); the wire still calls it
 * `groupId` for frontend compatibility, but the value IS the threadId.
 *
 * Membership is stored on ThreadParticipant (single source of truth). createNewGroup/joinGroup write
 * ThreadParticipant rows (OWNER for the creator, MEMBER for joiners). Authorization is split:
 * ThreadAccessGuard + RolesGuard decide the OPERATOR's membership and role (throwing BusinessException →
 * HTTP 200 + domain code); the methods below validate TARGET-specific invariants and mutate.
 */
@Injectable()
export class GroupService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private readonly threadRevisionService: ThreadRevisionService,
  ) {}

  async onModuleInit() {}

  /** Load a GROUP thread + its `!`-User (name/avatar/bio) by threadId. Returns null if missing. The read
   *  path replacing the old queryGroups/findUniqeGroup (which hit the Group table). */
  findGroupByThreadId(threadId: number) {
    return this.prisma.messageThread.findUnique({
      where: { id: threadId },
      include: { groupUser: { include: { group: true } } },
    });
  }

  /** Bump Group.rosterRev — the roster revision a federated mirror compares (against its remoteRosterRev)
   *  on chat-open to decide whether to re-pull the roster. Call after any roster mutation (join/leave/
   *  kick/role/transfer) so a roster change is detectable by the lazy meta-pull, independent of identity
   *  (identity has its own User.profileRev, bumped by updateGroup/updateProfile/updateAvatar). */
  async bumpRosterRev(threadId: number): Promise<void> {
    const trd = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      select: { groupUserId: true },
    });
    if (trd?.groupUserId != null) {
      await this.prisma.group.update({
        where: { groupUserId: trd.groupUserId },
        data: { rosterRev: { increment: 1 } },
      });
    }
  }

  /** Batch-load the `!`-User (name/avatar/bio) for each of the given GROUP threads, keyed by threadId.
   *  Replaces the old queryGroups hydration that hit the Group table. Threads with no groupUser (P2P,
   *  or malformed) are omitted. Returns Map<threadId, {id,name,avatar,bio}>. */
  async resolveGroupUsersByThreadIds(
    threadIds: number[],
  ): Promise<Map<number, { id: number; name: string; avatar: string; bio: string; domain: string; group: { ownerId: number; createdAt: Date; updatedAt: Date } | null }>> {
    if (threadIds.length === 0) return new Map();
    const threads = await this.prisma.messageThread.findMany({
      where: { id: { in: threadIds } },
      select: {
        id: true,
        groupUser: {
          select: { id: true, name: true, avatar: true, bio: true, domain: true, group: { select: { ownerId: true, createdAt: true, updatedAt: true } } },
        },
      },
    });
    const m = new Map<number, { id: number; name: string; avatar: string; bio: string; domain: string; group: { ownerId: number; createdAt: Date; updatedAt: Date } | null }>();
    for (const t of threads) {
      if (t.groupUser) m.set(t.id, t.groupUser);
    }
    return m;
  }


  /**
   * Create a group: mint the `!`-User identity (name/avatar/bio) + the GROUP thread linked via
   * groupUserId + the owner as an OWNER participant. No other members here — the controller writes
   * GROUP_INVITE messages into each invited friend's P2P thread; they join via group/join. Wrapped in a
   * regenerate-on-P2002 loop: a same-ms ULID collision at the
   * account-domain unique index is probabilistically impossible, but the loop is a real safety net.
   */
  async createNewGroup(params: {
    name: string;
    description?: string;
    avatar?: string;
    owner: number;
  }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const account = mintGroupAccount();
      try {
        const result = await this.prisma.$transaction(async (prisma) => {
          const groupUser = await prisma.user.create({
            data: {
              account,
              domain: 'local',
              isForeigner: false,
              isGroup: true,
              hashPwd: '', // empty — !-group-users never log in (validateUser rejects isGroup before verify)
              name: params.name,
              avatar: params.avatar ?? '',
              bio: params.description ?? '',
            },
          });
          const thread = await prisma.messageThread.create({
            data: { type: MessageThreadType.GROUP, groupUserId: groupUser.id },
          });
          await prisma.threadParticipant.create({
            data: {
              userId: params.owner,
              threadId: thread.id,
              role: GroupRole.OWNER,
            },
          });
          // Group-exclusive state: owner + roster revision (origin group: remoteRosterRev null).
          await prisma.group.create({
            data: { groupUserId: groupUser.id, ownerId: params.owner, rosterRev: 0 },
          });
          return {
            id: groupUser.id,
            threadId: thread.id,
            name: groupUser.name,
            avatar: groupUser.avatar,
            bio: groupUser.bio,
          };
        });
        // Record the thread add for the owner AFTER the tx commits (bump threadRevision + push signal).
        await this.threadRevisionService.recordThreadAdd(params.owner, result.threadId);
        return result;
      } catch (e) {
        if (!isP2002(e)) throw e; // regenerate a fresh ULID, never append a counter
      }
    }
    throw new Error('group account collision after 3 attempts (probabilistically impossible)');
  }

  /**
   * Leave a group (soft: sets leftAt). The owner may NOT leave while other active members remain —
   * they must transfer ownership first (GROUP_OWNER_MUST_TRANSFER). A sole-member owner may leave
   * (the group is then abandoned). Returns the remaining active member ids so the controller can
   * fan out GROUP_MEMBER_LEFT.
   */
  async leaveGroup(params: {
    userId: number;
    threadId: number;
    role: GroupRole | null;
  }): Promise<{ remainingMemberIds: number[] }> {
    if (params.role === GroupRole.OWNER) {
      const active = await this.prisma.threadParticipant.findMany({
        where: { threadId: params.threadId, leftAt: null },
        select: { userId: true },
      });
      if (active.length > 1) {
        throw new BusinessException(
          BusinessCode.GROUP_OWNER_MUST_TRANSFER,
          'transfer ownership before leaving',
        );
      }
    }
    await this.prisma.threadParticipant.update({
      where: {
        userId_threadId: { userId: params.userId, threadId: params.threadId },
      },
      data: { leftAt: new Date() },
    });
    const remaining = await this.prisma.threadParticipant.findMany({
      where: { threadId: params.threadId, leftAt: null },
      select: { userId: true },
    });
    await this.bumpRosterRev(params.threadId);
    // Record the thread delete for the leaver (bump threadRevision + push signal).
    await this.threadRevisionService.recordThreadDelete(params.userId, params.threadId);
    return { remainingMemberIds: remaining.map((r) => r.userId) };
  }

  /**
   * Kick a member (soft: sets leftAt). The operator must strictly outrank the target; the owner
   * cannot be kicked. Throws GROUP_TARGET_NOT_MEMBER / GROUP_FORBIDDEN on invariant violation.
   */
  async kickMember(params: {
    threadId: number;
    operatorRole: GroupRole;
    targetUserId: number;
  }): Promise<void> {
    const target = await this.prisma.threadParticipant.findUnique({
      where: {
        userId_threadId: {
          userId: params.targetUserId,
          threadId: params.threadId,
        },
      },
    });
    if (target === null || target.leftAt !== null) {
      throw new BusinessException(
        BusinessCode.GROUP_TARGET_NOT_MEMBER,
        'target is not an active member',
      );
    }
    if (target.role === GroupRole.OWNER) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'cannot kick the owner',
      );
    }
    if (!outranks(params.operatorRole, target.role)) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'you can only kick members below your role',
      );
    }
    await this.prisma.threadParticipant.update({
      where: { id: target.id },
      data: { leftAt: new Date() },
    });
    await this.bumpRosterRev(params.threadId);
    // Record the thread delete for the kicked member (bump threadRevision + push signal).
    await this.threadRevisionService.recordThreadDelete(params.targetUserId, params.threadId);
  }

  /**
   * Transfer ownership to an active member: demote the caller to MEMBER, promote the target to
   * OWNER — all in one transaction so the group is never ownerless. The owner is now derived from
   * ThreadParticipant.role=OWNER (the old Group.ownerId denormalized pointer is gone), so the
   * role-swaps alone are sufficient. The controller emits GROUP_ROLE_CHANGED for both users.
   */
  async transferOwnership(params: {
    threadId: number;
    fromUserId: number;
    toUserId: number;
  }): Promise<void> {
    if (params.toUserId === params.fromUserId) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'cannot transfer ownership to yourself',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const target = await tx.threadParticipant.findUnique({
        where: {
          userId_threadId: {
            userId: params.toUserId,
            threadId: params.threadId,
          },
        },
        include: { user: { select: { isForeigner: true } } },
      });
      if (target === null || target.leftAt !== null) {
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          'target is not an active member',
        );
      }
      // Ownership can't cross servers — the owner must stay on the origin (the roster authority).
      if (target.user.isForeigner) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'cannot transfer ownership to a member on another server',
        );
      }
      if (target.role === GroupRole.OWNER) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'target is already the owner',
        );
      }
      await tx.threadParticipant.update({
        where: {
          userId_threadId: {
            userId: params.fromUserId,
            threadId: params.threadId,
          },
        },
        data: { role: GroupRole.MEMBER },
      });
      await tx.threadParticipant.update({
        where: { id: target.id },
        data: { role: GroupRole.OWNER },
      });
    });
    // Transfer bumps rosterRev AND flips the denormalized ownerId (mirrors the OWNER participant).
    const trd = await this.prisma.messageThread.findUnique({
      where: { id: params.threadId },
      select: { groupUserId: true },
    });
    if (trd?.groupUserId != null) {
      await this.prisma.group.update({
        where: { groupUserId: trd.groupUserId },
        data: { ownerId: params.toUserId, rosterRev: { increment: 1 } },
      });
    }
  }

  /**
   * Set a member's role to ADMIN or MEMBER. OWNER-only (enforced by @Roles); ownership changes go
   * through transferOwnership, so role=OWNER is rejected here, as is touching the current owner.
   */
  async setRole(params: {
    threadId: number;
    targetUserId: number;
    role: GroupRole;
    operatorUserId: number;
  }): Promise<void> {
    if (params.role === GroupRole.OWNER) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'use transfer to change ownership',
      );
    }
    if (params.targetUserId === params.operatorUserId) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        'cannot change your own role',
      );
    }
    const target = await this.prisma.threadParticipant.findUnique({
      where: {
        userId_threadId: {
          userId: params.targetUserId,
          threadId: params.threadId,
        },
      },
    });
    if (target === null || target.leftAt !== null) {
      throw new BusinessException(
        BusinessCode.GROUP_TARGET_NOT_MEMBER,
        'target is not an active member',
      );
    }
    if (target.role === GroupRole.OWNER) {
      throw new BusinessException(
        BusinessCode.GROUP_FORBIDDEN,
        "cannot change the owner's role",
      );
    }
    await this.prisma.threadParticipant.update({
      where: { id: target.id },
      data: { role: params.role },
    });
    await this.bumpRosterRev(params.threadId);
  }

  /** Update a group's name / description / avatar on the `!`-User row (only provided fields are written).
   *  description maps to User.bio. */
  async updateGroup(params: {
    threadId: number;
    name?: string;
    description?: string;
    avatar?: string;
  }) {
    const trd = await this.prisma.messageThread.findUnique({
      where: { id: params.threadId },
      select: { groupUserId: true },
    });
    if (!trd || !trd.groupUserId) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'group thread not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const data: Prisma.UserUpdateInput = {};
    if (params.name !== undefined) data.name = params.name;
    if (params.description !== undefined) data.bio = params.description;
    if (params.avatar !== undefined) data.avatar = params.avatar;
    data.profileRev = { increment: 1 }; // identity change bumps the profile revision
    return this.prisma.user.update({ where: { id: trd.groupUserId }, data });
  }
}
