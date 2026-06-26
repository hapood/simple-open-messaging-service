import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  Prisma,
  MessageThreadType,
  UserMessageThreadStatus,
} from '../prisma/generated/client';
import * as jsonwebtoken from 'jsonwebtoken';
import { requireEnv } from '../common/env';

const secret = requireEnv('GROUP_INVITE_SECRET');

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

  findUniqeGroupMember(params: Prisma.GroupMemberFindUniqueArgs) {
    return this.prisma.groupMember.findUnique(params);
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
   * 原实现用 jsonwebtoken.decode（仅解 payload 不验签），任何人伪造 token 即可入群。
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

  async createNewGroup(params: { groupName: string; owner: number }) {
    return this.prisma.$transaction(async (prisma) => {
      const trdData = await prisma.messageThread.create({
        data: {
          type: MessageThreadType.GROUP,
        },
      });
      const grpData = await prisma.group.create({
        data: {
          name: params.groupName,
          avatar: '',
          ownerId: params.owner,
          threadId: trdData.id,
        },
      });
      await prisma.userMessageThread.create({
        data: {
          userId: params.owner,
          status: UserMessageThreadStatus.APPROVED,
          toObjType: MessageThreadType.GROUP,
          toObjId: grpData.id,
          reqMessage: '',
          threadId: grpData.threadId,
        },
      });
      await prisma.groupMember.create({
        data: {
          groupId: grpData.id,
          userId: params.owner,
        },
      });
      return grpData;
    });
  }

  async joinGroup(params: { groupId: number; userId: number }) {
    await this.prisma.$transaction(async (prisma) => {
      const group = await prisma.group.findUnique({
        where: {
          id: params.groupId,
        },
      });
      await prisma.groupMember.create({
        data: {
          groupId: group.id,
          userId: params.userId,
        },
      });
      await prisma.userMessageThread.create({
        data: {
          userId: params.userId,
          status: UserMessageThreadStatus.APPROVED,
          toObjType: MessageThreadType.GROUP,
          toObjId: group.id,
          reqMessage: '',
          threadId: group.threadId,
        },
      });
    });
  }

  async getAllGroupUserIds(groupId: number) {
    return this.prisma.groupMember.findMany({
      where: {
        groupId,
      },
      select: {
        userId: true,
      },
    });
  }
}
