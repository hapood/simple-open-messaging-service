import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  Prisma,
  MessageThreadType,
  UserMessageThreadStatus,
} from '@prisma/client';
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

  decodeInviteDate(params: { token }) {
    const payload: any = jsonwebtoken.decode(params.token);
    if (payload === null) {
      return {
        status: 1,
      };
    } else if (new Date().getTime() > payload.exp * 1000) {
      return {
        status: 2,
      };
    } else {
      return {
        status: 0,
        data: payload as { sub: number; exp: number; gid: number },
      };
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
