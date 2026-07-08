import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { Prisma } from '../prisma/generated/client.js';
import { AuthService } from '../auth/auth.service.js';
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
  }): Promise<Prisma.UserGetPayload<{ omit: { hashPwd: true; hasUrFriendReq: true } }>[]> {
    const { skip, take, cursor, where, orderBy } = params;
    return this.prisma.user.findMany({
      skip,
      take,
      cursor,
      where,
      orderBy,
      omit: { hashPwd: true, hasUrFriendReq: true },
    });
  }
}
