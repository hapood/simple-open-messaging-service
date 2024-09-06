import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, ContentType, Prisma, Message, UserChatThread } from '@prisma/client';
import { AuthService } from 'src/auth/auth.service';
@Injectable()
export class MessageService implements OnModuleInit {
  constructor(private prisma: PrismaService, private auth: AuthService) { }

  async onModuleInit() {
  }

  async findUserThread(
    params: Prisma.UserChatThreadWhereInput,
  ): Promise<UserChatThread | null> {
    return await this.prisma.userChatThread.findFirst({
      where: params,
      include: {
        threadItem: true
      }
    });
  }
  async sendMessageToThread(userId: number, threadId: number, content: string, type: ContentType) {
    const userChat = await this.prisma.userChatThread.findFirst({
      where: {
        userId, threadId
      }
    });
    if (userChat) {
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

  async getChatThreadList(userId: number): Promise<UserChatThread[]> {
    return await this.prisma.userChatThread.findMany({
      where: {
        userId: userId
      },
      include: {
        threadItem: true
      }
    });
  }
}