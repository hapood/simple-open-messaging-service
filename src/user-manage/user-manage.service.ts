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

  /** 360° view of one user: profile + group memberships + active sessions + push devices.
   *  One round-trip via Promise.all. Returns null when the user does not exist. */
  async getUserDetail(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      omit: { hashPwd: true, hasUrFriendReq: true },
    });
    if (!user) return null;
    const [groups, sessions, pushTokens] = await Promise.all([
      this.prisma.threadParticipant.findMany({
        where: { userId: id, thread: { type: 'GROUP' } },
        select: {
          threadId: true,
          role: true,
          joinedAt: true,
          leftAt: true,
          thread: { select: { groupUser: { select: { account: true, name: true } } } },
        },
        orderBy: { joinedAt: 'desc' },
      }),
      this.auth.listActiveSessions(id),
      this.prisma.pushToken.findMany({
        where: { userId: id },
        select: { id: true, platform: true, deviceId: true, lastSeenAt: true },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ]);
    return { user, groups, sessions, pushTokens };
  }

  // ── Admin user-management operations ────────────────────────────────────────
  // Moved here from AdminController so the controller stays a pure HTTP adapter. Each mutator runs
  // through the same path its single-user endpoint did: disable force-logs-out, reset-password
  // revokes all sessions, etc. Services take primitives/local option types (never admin DTOs) to keep
  // the user-manage layer free of an admin dependency; the controller translates the DTO.

  /** Paginated, searchable user list (non-group users only). Omits hashPwd + hasUrFriendReq. */
  async listUsers(opts: { skip?: number; take?: number; search?: string }) {
    const where = opts.search
      ? { isGroup: false, account: { contains: opts.search, mode: 'insensitive' as const } }
      : { isGroup: false };
    const [list, total] = await Promise.all([
      this.getUserList({
        where,
        skip: opts.skip ?? 0,
        take: opts.take ?? 20,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { list, total };
  }

  /** Soft-delete + revoke every session (refresh family + access tokenVersion bump). */
  async disableUser(id: number): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { isDeleted: true } });
    await this.auth.invalidateAllSessions(id, 'admin_disabled');
  }

  async enableUser(id: number): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { isDeleted: false } });
  }

  /** Force logout every device without changing the account (disable = soft-delete; this does not). */
  async forceLogout(id: number): Promise<void> {
    await this.auth.invalidateAllSessions(id, 'admin_force_logout');
  }

  /** Swap the password hash + revoke all sessions (caller has already validated the password rules). */
  async resetPassword(id: number, newPassword: string): Promise<void> {
    const hash = await this.auth.hashStr(newPassword);
    await this.prisma.user.update({ where: { id }, data: { hashPwd: hash } });
    await this.auth.invalidateAllSessions(id, 'admin_reset_password');
  }

  /** Apply one action to many users, each via its single-user path. Returns the count processed. */
  async batchUsers(
    ids: number[],
    action: 'disable' | 'enable' | 'force-logout',
  ): Promise<{ affected: number }> {
    for (const id of ids) {
      if (action === 'disable') await this.disableUser(id);
      else if (action === 'enable') await this.enableUser(id);
      else await this.forceLogout(id);
    }
    return { affected: ids.length };
  }

  /** Batch-resolve userId → account for the live-connections backfill (avoids N+1 in the controller). */
  async attachAccounts(userIds: number[]): Promise<Map<number, string>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, account: true },
    });
    return new Map(users.map((u) => [u.id, u.account]));
  }
}
