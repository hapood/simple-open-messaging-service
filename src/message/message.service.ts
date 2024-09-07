import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, ContentType, Prisma, Message, UserMessageThread } from '@prisma/client';
import { AuthService } from 'src/auth/auth.service';
@Injectable()
export class MessageService implements OnModuleInit {
  constructor(private prisma: PrismaService, private auth: AuthService) { }

  async onModuleInit() {
  }

  async findUserThread(
    params: Prisma.UserMessageThreadWhereInput,
  ): Promise<UserMessageThread | null> {
    return await this.prisma.UserMessageThread.findFirst({
      where: params,
      include: {
        threadItem: true
      }
    });
  }
  async sendMessageToThread(userId: number, threadId: number, content: string, type: ContentType) {
    const userMsg = await this.prisma.UserMessageThread.findFirst({
      where: {
        userId, threadId
      }
    });
    if (userMsg) {
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
  }

  async queryMessages(params: Prisma.MessageFindManyArgs): Promise<Message[]> {
    const res = await this.prisma.message.findMany(params);
    return res
  }

  async getMsgThreadList(userId: number): Promise<UserMessageThread[]> {
    return await this.prisma.UserMessageThread.findMany({
      where: {
        userId: userId
      },
      include: {
        threadItem: true
      }
    });
  }
}