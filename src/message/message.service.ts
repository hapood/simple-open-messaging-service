import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, ContentType, Prisma, Message, UserMessageThreadStatus } from '@prisma/client';
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

  async writeMsgToThread(userId: number, threadId: number, content: string, type: ContentType) {
    const newData = {
      content,
      contentType: type,
      threadId,
      creator: userId
    }
    const data = await this.prisma.message.create({ data: newData });
    return {
      id: data.id,
      createdAt: data.createdAt
    }
  }

  async queryMessages(threadId: number, params: Prisma.MessageFindManyArgs) {
    const data = await this.prisma.message.findMany({
      ...params,
      where: {
        threadId: threadId,
      }
    });
    return data
  }
}