import { Injectable, OnModuleInit, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, Prisma, ChatThreadType, Friend } from '@prisma/client';
import { AuthService } from 'src/auth/auth.service';
@Injectable()
export class UserService implements OnModuleInit {
  constructor(private prisma: PrismaService, private auth: AuthService) { }

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

    await this.prisma.$transaction(async (prisma) => {
      prisma.friend.createMany({ data: [newData1, newData2] })
      const threadData = await this.prisma.chatThread.create({
        data: {
          type: ChatThreadType.SINGLE_CHAT, info: {
            userId1: hostUserId,
            userId2: friendUserId
          }
        }
      })
      prisma.userChatThread.createMany({
        data: [{
          threadId: threadData.id, userId: hostUserId
        }, {
          threadId: threadData.id, userId: friendUserId
        }]
      })
    })

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

  async createUser(data: Prisma.UserCreateInput) {
    return await this.prisma.$transaction(async (prisma) => {
      const user = await prisma.user.findFirst({
        where: { uniqName: data.uniqName },
      });
      if (user !== undefined) {
        new ConflictException(`User ${data.uniqName} already exists`);
      }
      data.password = await this.auth.hashStr(data.password)
      const newUser = await prisma.user.create({
        data,
      });
      return {
        id: newUser.id,
        uniqName: newUser.uniqName
      }
    })
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

  async getFriendList(userId: number) {
    return this.prisma.friend.findMany({
      where: {
        hostUserId: userId
      }
    });
  }

}
