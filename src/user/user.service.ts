import { Injectable, OnModuleInit, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, Prisma, MessageThreadType, UserMessageThreadStatus } from '@prisma/client';
import { AuthService } from 'src/auth/auth.service';
@Injectable()
export class UserService implements OnModuleInit {
  constructor(private prisma: PrismaService, private auth: AuthService) { }

  async onModuleInit() {
  }

  async makeFriendRequest(hostUserId: number, friendUserId: number) {
    await this.prisma.$transaction(async (prisma) => {
      prisma.userMessageThread.findUnique({
        where:{
          id
        }
      })
      prisma.userMessageThread.createMany({
        data: [{
          threadId: null, userId: hostUserId, toObjId: friendUserId,
          toObjType: MessageThreadType.P2P_MESSAGE, status: UserMessageThreadStatus.PENDING
        }, {
          threadId: null, userId: friendUserId, toObjId: hostUserId,
          toObjType: MessageThreadType.P2P_MESSAGE, status: UserMessageThreadStatus.PENDING
        }]
      })
    })

    return true
  }

  async acceptFriendRequest(hostUserId: number, friendUserId: number) {
    await this.prisma.$transaction(async (prisma) => {
      const threadData = await this.prisma.messageThread.create({
        data: {
          type: MessageThreadType.P2P_MESSAGE, info: {
            userId1: hostUserId,
            userId2: friendUserId
          }
        }
      })
      prisma.userMessageThread.updateMany({
        data: [{
          threadId: threadData.id, userId: hostUserId, status: UserMessageThreadStatus.APPROVED
        }, {
          threadId: threadData.id, userId: friendUserId, status: UserMessageThreadStatus.APPROVED
        }]
      })
    })

    return true
  }

  async findOne(
    userWhereUniqueInput: any,
  ): Promise<User | null> {
    return this.prisma.user.findUniqueOrThrow({
      where: userWhereUniqueInput,
    });
  }

  async findFriend(
    params: Prisma.FriendWhereInput,
  ): Promise<Friend | null> {
    return await this.prisma.friend.findUniqueOrThrow({
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
      const user = await prisma.user.findUnique({
        where: { uniqName: data.uniqName, domain: null },
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

  async updateUserExtra(params: {
    where: Prisma.UserWhereUniqueInput;
    data: Prisma.UserUpdateInput;
  }): Promise<User> {
    const { where, data } = params;
    return this.prisma.user.update({
      data,
      where,
    });
  }

  async queryFriendThread(userId: number) {
    return this.prisma.friend.findMany({
      where: {
        hostUserId: userId
      }
    });
  }

  async queryGroupThread(userId: number) {
    return this.prisma.friend.findMany({
      where: {
        hostUserId: userId
      }
    });
  }

}
