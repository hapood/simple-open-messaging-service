import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, Prisma, MessageThreadType, UserMessageThreadStatus } from '@prisma/client';
import jsonwebtoken from 'jsonwebtoken'

const secret = '1b14c2677bacd5b82701b2f599281dc93befcf34ba988e5bbe73b855ad4cbe18'

@Injectable()
export class GroupService implements OnModuleInit {
  constructor(private prisma: PrismaService) { }

  async onModuleInit() {
  }

  findUniqGroup(params: Prisma.GroupWhereUniqueInput) {
    return this.prisma.group.findUnique({ where: params })
  }

  queryGroups(params: Prisma.GroupFindManyArgs) {
    return this.prisma.group.findMany(params)
  }

  findUniqGroupMember(params: Prisma.GroupMemberFindUniqueArgs) {
    return this.prisma.groupMember.findUnique(params)
  }

  generateInviteToken(params: {
    toUserId: number,
    expiryDate: number,
    threadId: number
  }) {
    return jsonwebtoken.sign({
      sub: params.toUserId,
      exp: Math.floor(params.expiryDate / 1000),
      tid: params.threadId
    }, secret)
  }

  decodeInviteDate(params: {
    token
  }) {
    const payload: any = jsonwebtoken.decode(params.token)
    if (payload === null) {
      return {
        status: 1
      }
    } else if (new Date().getTime() > payload.exp * 1000) {
      return {
        status: 2
      }
    } else {
      return {
        status: 0,
        data: payload as { sub: number, exp: number, tid: number }
      }
    }
  }

  async createNewGroup(params: { groupName: string, owner: number }) {
    return this.prisma.$transaction(async (prisma) => {
      const data = await prisma.messageThread.create({
        data: {
          type: MessageThreadType.GROUP,
          groupItem: {
            create: {
              name: params.groupName,
              avatar: '',
              ownerId: params.owner
            }
          }
        }
      })
      await prisma.userMessageThread.create({
        data: {
          userId: params.owner,
          status: UserMessageThreadStatus.APPROVED,
          toObjType: MessageThreadType.GROUP,
          toObjId: data.groupId,
          reqMessage: '',
          threadId: data.id
        }
      })
      await prisma.groupMember.create({
        data: {
          groupId: data.groupId,
          userId: params.owner
        }
      })
      return data
    })
  }

  async joinGroup(params: { threadId: number, userId: number }) {
    await this.prisma.$transaction(async (prisma) => {
      const group = await prisma.group.findUnique({
        where: {
          id: params.threadId
        }
      })
      await prisma.groupMember.create({
        data: {
          groupId: group.id,
          userId: params.userId
        }
      })
      await prisma.userMessageThread.create({
        data: {
          userId: params.userId,
          status: UserMessageThreadStatus.APPROVED,
          toObjType: MessageThreadType.GROUP,
          toObjId: group.id,
          reqMessage: '',
          threadId: params.threadId
        }
      })
    })
  }

  async getAllGroupUserIds(groupId: number) {
    return this.prisma.groupMember.findMany({
      where: {
        groupId
      },
      select: {
        userId: true
      }
    })
  }
}