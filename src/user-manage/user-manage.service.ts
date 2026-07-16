import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { Prisma } from '../prisma/generated/client.js';
import { AuthService } from '../auth/auth.service.js';
import { UserService } from '../user/user.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
@Injectable()
export class UserManageService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private auth: AuthService,
    private userService: UserService,
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
      this.auth.listActiveSessions(id, null),
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

  /** Soft-delete + revoke every session token (invalidateAllSessions revokes all SessionToken rows + emits FORCE_LOGOUT). */
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

  /** Create a local user (admin-provisioned). Hashes the password and delegates to UserService.addUser —
   *  the single creation choke point that normalizes/validates the account grammar + enforces uniqueness.
   *  Returns the new {id, account}; throws ALREADY_EXISTS on a duplicate account. */
  async createUser(params: {
    account: string;
    name: string;
    password: string;
  }): Promise<{ id: number; account: string }> {
    const hashPwd = await this.auth.hashStr(params.password);
    const res = await this.userService.addUser({
      account: params.account,
      name: params.name,
      hashPwd,
    });
    // addUser returns {status:2} on a duplicate account (no data) — map to ALREADY_EXISTS. status 0
    // guarantees data is present; the guard also narrows it for the typechecker.
    if (res.status !== 0 || !res.data) {
      throw new BusinessException(BusinessCode.ALREADY_EXISTS, `account ${params.account} already exists`);
    }
    return res.data;
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
