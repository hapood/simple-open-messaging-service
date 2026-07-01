import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import {
  GroupRole,
  MessageThreadType,
  Prisma,
} from '../prisma/generated/client.js';
import jsonwebtoken from 'jsonwebtoken';
import { requireEnv } from '../common/env.js';

const secret = requireEnv('GROUP_INVITE_SECRET');

/**
 * Group lifecycle: creation, invite-token mint/verify, and joining.
 *
 * Membership is no longer stored here — ThreadParticipant is the single source of truth. createNewGroup
 * and joinGroup write ThreadParticipant rows (role OWNER for the creator, MEMBER for joiners); roster
 * lookups and SSE fan-out go through ThreadParticipantService elsewhere.
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

  /** Create a group: GROUP thread + Group metadata + the owner as an OWNER participant. */
  async createNewGroup(params: { groupName: string; owner: number }) {
    return this.prisma.$transaction(async (prisma) => {
      const trdData = await prisma.messageThread.create({
        data: { type: MessageThreadType.GROUP },
      });
      const grpData = await prisma.group.create({
        data: {
          name: params.groupName,
          avatar: '',
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
}
