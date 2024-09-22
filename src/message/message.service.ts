import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, ContentType, Prisma, Message, UserMessageThread } from '@prisma/client';
import { StandardResponse } from 'src/model';
@Injectable()
export class MessageService implements OnModuleInit {
  constructor(private prisma: PrismaService) { }

  async onModuleInit() {
  }

  findUniqueUserMessageThread(
    params: Prisma.UserMessageThreadWhereUniqueInput,
  ) {
    return this.prisma.userMessageThread.findUnique({
      where: params,
      include: {
        threadItem: true
      }
    });
  }

  async sendMessageToThread(userId: number, threadId: number, content: string, type: ContentType): Promise<StandardResponse> {
    return await this.prisma.$transaction(async (prisma) => {
      const userMsgTr = prisma.userMessageThread.findUnique({
        where: {
          userId_threadId: {
            userId,
            threadId
          }
        }
      })
      if (userMsgTr !== null) {
        const newData = {
          content,
          contentType: type,
          threadId,
          creator: userId
        }
        const data = await prisma.message.create({ data: newData });
        return {
          status: 0,
          message: 'successful',
          data: {
            id: data.id,
            createdAt: data.createdAt
          }
        }
      } else {
        return {
          status: 1,
          message: 'failed'
        }
      }
    })
  }

  queryMessages(userId: number, threadId: number, params: Prisma.MessageFindManyArgs):
    Promise<StandardResponse> {
    return this.prisma.$transaction(async (prisma) => {
      const userMsgTr = prisma.userMessageThread.findUnique({
        where: {
          userId_threadId: {
            userId,
            threadId
          }
        }
      })
      if (userMsgTr !== null) {
        const res = await this.prisma.message.findMany({
          ...params,
          where: {
            threadId: threadId,
          }
        });
        return {
          status: 0,
          message: 'failed',
          data: res
        }
      } else {
        return {
          status: 1,
          message: 'failed'
        }
      }
    })
  }
}