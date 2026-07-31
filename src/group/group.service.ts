import { Injectable, OnModuleInit, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import {
  GroupRole,
  InviteKind,
  InviteStatus,
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
  async resolveGroupUsersByThreadIds(threadIds: number[]): Promise<
    Map<
      number,
      {
        id: number;
        name: string;
        avatar: string;
        bio: string;
        domain: string;
        profileRev: number;
        group: {
          ownerId: number;
          dissolvedAt: Date | null;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }
    >
  > {
    if (threadIds.length === 0) return new Map();
    const threads = await this.prisma.messageThread.findMany({
      where: { id: { in: threadIds } },
      select: {
        id: true,
        groupUser: {
          select: {
            id: true,
            name: true,
            avatar: true,
            bio: true,
            domain: true,
            profileRev: true,
            group: {
              select: {
                ownerId: true,
                dissolvedAt: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });
    const m = new Map<
      number,
      {
        id: number;
        name: string;
        avatar: string;
        bio: string;
        domain: string;
        profileRev: number;
        group: {
          ownerId: number;
          dissolvedAt: Date | null;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }
    >();
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
            data: {
              groupUserId: groupUser.id,
              ownerId: params.owner,
              rosterRev: 0,
            },
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
        await this.threadRevisionService.recordThreadAdd(
          params.owner,
          result.threadId,
        );
        return result;
      } catch (e) {
        if (!isP2002(e)) throw e; // regenerate a fresh ULID, never append a counter
      }
    }
    throw new Error(
      'group account collision after 3 attempts (probabilistically impossible)',
    );
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
    deleteData: boolean;
  }): Promise<{ remainingMemberIds: number[]; transitioned: boolean }> {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const hidden = params.deleteData
        ? await this.threadRevisionService.isThreadHiddenInTx(
            tx,
            params.userId,
            params.threadId,
          )
        : false;
      const shouldDelete = params.deleteData && !hidden;
      const current = await tx.threadParticipant.findUnique({
        where: {
          userId_threadId: {
            userId: params.userId,
            threadId: params.threadId,
          },
        },
        select: { leftAt: true, role: true },
      });
      if (!current)
        throw new BusinessException(BusinessCode.NOT_FOUND, 'member not found');
      if (current.leftAt === null && current.role === GroupRole.OWNER) {
        const active = await tx.threadParticipant.count({
          where: { threadId: params.threadId, leftAt: null },
        });
        if (active > 1) {
          throw new BusinessException(
            BusinessCode.GROUP_OWNER_MUST_TRANSFER,
            'transfer ownership before leaving',
          );
        }
      }
      const ended = await tx.threadParticipant.updateMany({
        where: {
          userId: params.userId,
          threadId: params.threadId,
          leftAt: null,
        },
        data: { leftAt: now },
      });
      if (shouldDelete) {
        await tx.threadParticipant.update({
          where: {
            userId_threadId: {
              userId: params.userId,
              threadId: params.threadId,
            },
          },
          data: { clearedAt: now, pinned: false, pinnedAt: null },
        });
      }
      if (ended.count > 0) {
        const thread = await tx.messageThread.findUnique({
          where: { id: params.threadId },
          select: { groupUserId: true },
        });
        if (thread?.groupUserId != null) {
          await tx.group.update({
            where: { groupUserId: thread.groupUserId },
            data: { rosterRev: { increment: 1 } },
          });
        }
      }
      const remaining = await tx.threadParticipant.findMany({
        where: { threadId: params.threadId, leftAt: null },
        select: { userId: true },
      });
      const revision = shouldDelete
        ? await this.threadRevisionService.recordThreadDeleteInTx(
            tx,
            params.userId,
            params.threadId,
          )
        : ended.count > 0 && !hidden
          ? await this.threadRevisionService.recordThreadAddInTx(
              tx,
              params.userId,
              params.threadId,
            )
          : null;
      return {
        transitioned: ended.count > 0,
        remainingMemberIds: remaining.map((row) => row.userId),
        revision,
      };
    });
    if (result.revision !== null) {
      this.threadRevisionService.notifyThreadRevision({
        userId: params.userId,
        revision: result.revision,
      });
    }
    return {
      transitioned: result.transitioned,
      remainingMemberIds: result.remainingMemberIds,
    };
  }

  /** Mark a group terminal while retaining participants and history visibility. Pending invites are
   * revoked in the same transaction, so an old card cannot join a dissolved group. */
  async dissolveGroup(params: {
    threadId: number;
    deleteForUserId?: number;
  }): Promise<{ transitioned: boolean }> {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const hidden =
        params.deleteForUserId === undefined
          ? false
          : await this.threadRevisionService.isThreadHiddenInTx(
              tx,
              params.deleteForUserId,
              params.threadId,
            );
      const shouldDelete = params.deleteForUserId !== undefined && !hidden;
      const thread = await tx.messageThread.findUnique({
        where: { id: params.threadId },
        select: { groupUserId: true },
      });
      if (thread?.groupUserId == null) {
        throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
      }
      const dissolved = await tx.group.updateMany({
        where: { groupUserId: thread.groupUserId, dissolvedAt: null },
        data: { dissolvedAt: now, rosterRev: { increment: 1 } },
      });
      if (dissolved.count > 0) {
        await tx.invite.updateMany({
          where: {
            kind: InviteKind.GROUP,
            threadId: params.threadId,
            status: InviteStatus.PENDING,
          },
          data: { status: InviteStatus.REVOKED },
        });
      }
      if (shouldDelete && params.deleteForUserId !== undefined) {
        await tx.threadParticipant.update({
          where: {
            userId_threadId: {
              userId: params.deleteForUserId,
              threadId: params.threadId,
            },
          },
          data: { clearedAt: now, pinned: false, pinnedAt: null },
        });
      }
      const revision =
        shouldDelete && params.deleteForUserId !== undefined
          ? await this.threadRevisionService.recordThreadDeleteInTx(
              tx,
              params.deleteForUserId,
              params.threadId,
            )
          : null;
      return { transitioned: dissolved.count > 0, revision };
    });
    if (result.revision !== null && params.deleteForUserId !== undefined) {
      this.threadRevisionService.notifyThreadRevision({
        userId: params.deleteForUserId,
        revision: result.revision,
      });
    }
    return { transitioned: result.transitioned };
  }

  /**
   * Kick a member (soft: sets leftAt). The operator must strictly outrank the target; the owner
   * cannot be kicked. Throws GROUP_TARGET_NOT_MEMBER / GROUP_FORBIDDEN on invariant violation.
   */
  async kickMember(params: {
    threadId: number;
    operatorUserId: number;
    targetUserId: number;
  }): Promise<{ transitioned: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const [operator, target] = await Promise.all([
        tx.threadParticipant.findUnique({
          where: {
            userId_threadId: {
              userId: params.operatorUserId,
              threadId: params.threadId,
            },
          },
        }),
        tx.threadParticipant.findUnique({
          where: {
            userId_threadId: {
              userId: params.targetUserId,
              threadId: params.threadId,
            },
          },
        }),
      ]);
      if (target === null) {
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          'target is not a member',
        );
      }
      if (target.leftAt !== null)
        return { transitioned: false, revision: null };
      if (
        operator === null ||
        operator.leftAt !== null ||
        operator.role === null ||
        target.role === GroupRole.OWNER ||
        !outranks(operator.role, target.role)
      ) {
        throw new BusinessException(
          BusinessCode.GROUP_FORBIDDEN,
          'you can only kick members below your role',
        );
      }
      const hidden = await this.threadRevisionService.isThreadHiddenInTx(
        tx,
        params.targetUserId,
        params.threadId,
      );
      const ended = await tx.threadParticipant.updateMany({
        where: { id: target.id, leftAt: null, role: target.role },
        data: { leftAt: new Date() },
      });
      if (ended.count === 0) return { transitioned: false, revision: null };
      const thread = await tx.messageThread.findUnique({
        where: { id: params.threadId },
        select: { groupUserId: true },
      });
      if (thread?.groupUserId != null) {
        await tx.group.update({
          where: { groupUserId: thread.groupUserId },
          data: { rosterRev: { increment: 1 } },
        });
      }
      const revision = hidden
        ? null
        : await this.threadRevisionService.recordThreadAddInTx(
            tx,
            params.targetUserId,
            params.threadId,
          );
      return { transitioned: true, revision };
    });
    if (result.revision !== null) {
      this.threadRevisionService.notifyThreadRevision({
        userId: params.targetUserId,
        revision: result.revision,
      });
    }
    return { transitioned: result.transitioned };
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
