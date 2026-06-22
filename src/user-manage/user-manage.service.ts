import { Injectable, OnModuleInit, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  User,
  Prisma,
  MessageThreadType,
  UserMessageThreadStatus,
} from '@prisma/client';
import { AuthService } from 'src/auth/auth.service';
@Injectable()
export class UserManageService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private auth: AuthService,
  ) {}

  async onModuleInit() {}

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
}
