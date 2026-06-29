import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  User,
  Prisma,
  MessageThreadType,
  UserMessageThreadStatus,
} from '../prisma/generated/client';

@Injectable()
export class UserService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {}

  findUniqueUser(
    userWhereUniqueInput: Prisma.UserWhereUniqueInput,
    hasExtra = true,
  ) {
    return this.prisma.user.findUnique({
      where: userWhereUniqueInput,
      include: {
        userExtra: hasExtra,
      },
    });
  }

  updateUser(params: {
    where: Prisma.UserWhereUniqueInput;
    data: Prisma.UserUpdateInput;
  }): Promise<User> {
    const { where, data } = params;
    return this.prisma.user.update({
      data,
      where,
    });
  }

  updateUserExtra(params: {
    where: Prisma.UserWhereUniqueInput;
    data: Prisma.UserUpdateInput;
  }): Promise<User> {
    const { where, data } = params;
    return this.prisma.user.update({
      data,
      where,
    });
  }

  /** 更新当前用户头像（嵌套更新 UserExtra.avatar）。 */
  updateAvatar(userId: number, avatar: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { userExtra: { update: { avatar } } },
    });
  }

  queryUserThread(params: Prisma.UserMessageThreadFindManyArgs) {
    return this.prisma.userMessageThread.findMany(params);
  }

  queryUsers(params: Prisma.UserFindManyArgs) {
    return this.prisma.user.findMany(params);
  }

  addUser(params: { uniqName: string; hashPwd: string }) {
    return this.prisma.$transaction(async (prisma) => {
      const user = await prisma.user.findUnique({
        where: { uniqName: params.uniqName, domain: null },
      });
      if (user !== null) {
        return {
          status: 2,
        };
      }
      const newUserData: Prisma.UserCreateInput = {
        uniqName: params.uniqName,
        isForeigner: false,
        hashPwd: params.hashPwd,
        userExtra: {
          create: {
            name: params.uniqName,
            avatar: '',
          },
        },
        userNotiBox: {
          create: {},
        },
      };
      const newUser = await prisma.user.create({
        data: newUserData,
      });
      return {
        status: 0,
        data: {
          id: newUser.id,
          uniqName: newUser.uniqName,
        },
      };
    });
  }
}
