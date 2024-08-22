import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, ContentType, Prisma, Message, UserChatThread, ChatThreadType, Friend } from '@prisma/client';

@Injectable()
export class UserService implements OnModuleInit {
  constructor(private prisma: PrismaService) { }
  async onModuleInit() {
    if (!await this.findOne({ uniqName: "hapood" })) {
      console.log("add initial user happod.")
      this.createUser({
        uniqName: "hapood",
        password: "512512",
        isForeigner: false,
        domain: "qifa.io"
      })
    }
  }
  async createFriend(hostUserId: number, friendUserId: number) {
    const newData1 = {
      hostUserId: hostUserId,
      friendUserId: friendUserId
    }
    const newData2 = {
      hostUserId: friendUserId,
      friendUserId: hostUserId
    }
    await this.prisma.friend.createMany({ data: [newData1, newData2] })
    const threadData = await this.prisma.chatThread.create({
      data: {
        type: ChatThreadType.SINGLE_CHAT, info: {
          userId1: hostUserId,
          userId2: friendUserId
        }
      }
    })

    const res = await this.prisma.userChatThread.createMany({
      data: [{
        threadId: threadData.id, userId: hostUserId
      }, {
        threadId: threadData.id, userId: friendUserId
      }]
    });
    return true
  }

  async findOne(
    userWhereUniqueInput: any,
  ): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: userWhereUniqueInput,
    });
  }

  async findFriend(
    params: Prisma.FriendWhereInput,
  ): Promise<Friend | null> {
    return await this.prisma.friend.findFirst({
      where: params,
      include: {
        friendUser: true
      }
    });
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
  async getUserList(params: {
    skip?: number;
    take?: number;
    cursor?: Prisma.UserWhereUniqueInput;
    where?: Prisma.UserWhereInput;
    orderBy?: Prisma.UserOrderByWithRelationInput;
  }): Promise<User[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.user.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
    });
  }

  async createUser(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({
      data,
    });
  }

  async updateUser(params: {
    where: Prisma.UserWhereUniqueInput;
    data: Prisma.UserUpdateInput;
  }): Promise<User> {
    const { where, data } = params;
    return this.prisma.user.update({
      data,
      where,
    });
  }

  async deleteUser(where: Prisma.UserWhereUniqueInput): Promise<User> {
    return this.prisma.user.delete({
      where,
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

  async queryChatMessages(params: Prisma.MessageFindManyArgs): Promise<Message[]> {
    const res = await this.prisma.message.findMany(params);
    return res
  }

  async getFriendList(userId: number) {
    return this.prisma.friend.findMany({
      where: {
        hostUserId: userId
      }
    });
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
