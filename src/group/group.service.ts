import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import {
  GroupRole,
  MessageThreadType,
  Prisma,
} from '../prisma/generated/client.js';
import jsonwebtoken from 'jsonwebtoken';
import { requireEnv } from '../common/env.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

const secret = requireEnv('GROUP_INVITE_SECRET');

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
 * Membership is no longer stored ad-hoc here — ThreadParticipant is the single source of truth.
 * createNewGroup/joinGroup write ThreadParticipant rows (OWNER for the creator, MEMBER for joiners);
 * roster lookups and SSE fan-out go through ThreadParticipantService. Initial members at creation
 * are INVITED (a GROUP_INVITE in their P2P thread), not directly added — they join via group/join.
 *
 * Authorization is split: GroupAccessGuard + RolesGuard decide the OPERATOR's membership and role
 * (throwing BusinessException → HTTP 200 + domain code). The methods below then validate the
 * TARGET-specific invariants (target is an active member, role-hierarchy for kick, no
 * self-transfer, etc.) and mutate. Controllers emit SSE after a successful return.
 */
@Injectable()
export class GroupService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {}

  findUniqeGroup(params: Prisma.GroupWhereUniqueInput) {
    return this.prisma.group.findUnique({ where: params });
  }

  queryGroups(params: Prisma.GroupFindManyArgs) {
    return this.prisma.group.findMany(params);
  }

  generateInviteToken(params: {
    toUserId: number;
    expiryDate: number;
    groupId: number;
  }) {
    return jsonwebtoken.sign(
      {
        sub: params.toUserId,
        exp: Math.floor(params.expiryDate / 1000),
        gid: params.groupId,
      },
      secret,
    );
  }

  /**
   * 校验邀请 token：验签 + 过期检查。
   * - status 0：有效，返回 payload
   * - status 1：签名无效 / 格式错误
   * - status 2：已过期
   */
  decodeInviteToken(
    token: string,
  ):
    | { status: 0; data: { sub: number; exp: number; gid: number } }
    | { status: 1; message: string }
    | { status: 2; message: string } {
    try {
      const payload = jsonwebtoken.verify(token, secret) as unknown as {
        sub: number;
        exp: number;
        gid: number;
      };
      return { status: 0, data: payload };
    } catch (e) {
      return e.name === 'TokenExpiredError'
        ? { status: 2, message: 'invite expired' }
        : { status: 1, message: 'invalid invite' };
    }
  }

  /**
   * Create a group shell: GROUP thread + Group metadata + the owner as an OWNER participant. No
   * other members are added here — the controller writes GROUP_INVITE messages into each invited
   * friend's P2P thread (via writeInvites); they become members only on group/join. Returns the
   * group; the controller fans out GROUP_MEMBER_JOINED as invitees accept.
   */
  async createNewGroup(params: {
    name: string;
    description?: string;
    avatar?: string;
    owner: number;
  }) {
    return this.prisma.$transaction(async (prisma) => {
      const trdData = await prisma.messageThread.create({
        data: { type: MessageThreadType.GROUP },
      });
      const grpData = await prisma.group.create({
        data: {
          name: params.name,
          description: params.description ?? '',
          avatar: params.avatar ?? '',
          ownerId: params.owner,
          threadId: trdData.id,
        },
      });
      await prisma.threadParticipant.create({
        data: {
          userId: params.owner,
          threadId: grpData.threadId,
          role: GroupRole.OWNER,
        },
      });
      return grpData;
    });
  }

  /**
   * Join a group by adding the user as a MEMBER participant on the group's thread.
   * - 'ok': newly joined.
   * - 'already-member': the row pre-existed (re-activates it if the user had previously left).
   * Idempotent by construction — never throws P2002 on duplicate join.
   */
  async joinGroup(params: {
    groupId: number;
    userId: number;
  }): Promise<{ status: 'ok' | 'already-member' }> {
    return this.prisma.$transaction(async (prisma) => {
      const group = await prisma.group.findUnique({
        where: { id: params.groupId },
      });
      const existing = await prisma.threadParticipant.findUnique({
        where: {
          userId_threadId: { userId: params.userId, threadId: group.threadId },
        },
      });
      if (existing !== null) {
        // Re-activate a previously-left member; otherwise this is an idempotent re-join.
        if (existing.leftAt !== null) {
          await prisma.threadParticipant.update({
            where: { id: existing.id },
            data: { leftAt: null, role: GroupRole.MEMBER },
          });
        }
        return { status: 'already-member' };
      }
      await prisma.threadParticipant.create({
        data: {
          userId: params.userId,
          threadId: group.threadId,
          role: GroupRole.MEMBER,
        },
      });
      return { status: 'ok' };
    });
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
  }

  /**
   * Transfer ownership to an active member: demote the caller to MEMBER, promote the target to
   * OWNER, and move the denormalized Group.ownerId pointer — all in one transaction so the group
   * is never ownerless. The controller emits GROUP_ROLE_CHANGED for both affected users.
   */
  async transferOwnership(params: {
    groupId: number;
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
      await tx.group.update({
        where: { id: params.groupId },
        data: { ownerId: params.toUserId },
      });
    });
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
  }

  /** Update a group's name / description / avatar (only provided fields are written). */
  async updateGroup(params: {
    groupId: number;
    name?: string;
    description?: string;
    avatar?: string;
  }) {
    const data: Prisma.GroupUpdateInput = {};
    if (params.name !== undefined) data.name = params.name;
    if (params.description !== undefined) data.description = params.description;
    if (params.avatar !== undefined) data.avatar = params.avatar;
    return this.prisma.group.update({
      where: { id: params.groupId },
      data,
    });
  }
}
