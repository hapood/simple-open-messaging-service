import { Injectable, OnModuleInit, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { User, Prisma } from '../prisma/generated/client.js';
import { isValidUserAccount, normalizeAccount } from '../common/account.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

@Injectable()
export class UserService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {}

  // Sensitive columns are omitted at the Prisma layer (never loaded → can't leak into responses),
  // so there are no per-site `delete` lines. hashPwd + hasUrFriendReq are omitted by default; the
  // two opt-in reads below re-include exactly one of them where a legitimate internal consumer needs it.
  findUniqueUser(userWhereUniqueInput: Prisma.UserWhereUniqueInput) {
    return this.prisma.user.findUnique({
      where: userWhereUniqueInput,
      omit: { hashPwd: true, hasUrFriendReq: true, threadRevision: true },
    });
  }

  /** Login path only: keeps hashPwd (argon2.verify needs it), omits the self-only badge. Auth-only. */
  findUniqueUserForAuth(userWhereUniqueInput: Prisma.UserWhereUniqueInput) {
    return this.prisma.user.findUnique({
      where: userWhereUniqueInput,
      omit: { hasUrFriendReq: true },
    });
  }

  /** Self-profile only: keeps the hasUrFriendReq badge, omits hashPwd. */
  findSelfProfile(userId: number) {
    return this.prisma.user.findUnique({ where: { id: userId }, omit: { hashPwd: true } });
  }

  updateUser(params: {
    where: Prisma.UserWhereUniqueInput;
    data: Prisma.UserUpdateInput;
  }): Promise<User> {
    const { where, data } = params;
    return this.prisma.user.update({ data, where });
  }

  /** Update the current user's avatar (inline User.avatar). */
  updateAvatar(userId: number, avatar: string) {
    return this.prisma.user.update({ where: { id: userId }, data: { avatar, profileRev: { increment: 1 } } });
  }

  /** Update the current user's display name / bio (inline User columns). */
  updateProfile(userId: number, data: { name?: string; bio?: string }) {
    const update: Prisma.UserUpdateInput = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.bio !== undefined) update.bio = data.bio;
    update.profileRev = { increment: 1 }; // identity change bumps the profile revision
    return this.prisma.user.update({ where: { id: userId }, data: update, omit: { hashPwd: true } });
  }

  queryUsers(params: Prisma.UserFindManyArgs) {
    // Default-omit sensitive columns. Callers needing an explicit `select` must hit prisma directly
    // (select + omit are mutually exclusive in Prisma); all current callers pass only `where`.
    return this.prisma.user.findMany({
      ...params,
      omit: { hashPwd: true, hasUrFriendReq: true, threadRevision: true, ...(params.omit ?? {}) },
    });
  }

  /** Local user discovery: case-insensitive substring match on account OR name. Local, non-deleted
   *  users only (isForeigner:false) — federated stubs are not discoverable here. Returns { list, total }
   *  for pagination. The caller (POST /user/search) caps `take` as an abuse guardrail. */
  async searchUsers(
    q: string,
    opts: { skip?: number; take: number },
  ): Promise<{
    list: Prisma.UserGetPayload<{ omit: { hashPwd: true; hasUrFriendReq: true } }>[];
    total: number;
  }> {
    const where: Prisma.UserWhereInput = {
      isDeleted: false,
      isForeigner: false,
      isGroup: false,
      OR: [
        { account: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ],
    };
    const [list, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: opts.skip,
        take: opts.take,
        orderBy: { createdAt: 'desc' },
        omit: { hashPwd: true, hasUrFriendReq: true },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { list, total };
  }

  addUser(params: { account: string; name: string; hashPwd?: string | null }) {
    const account = normalizeAccount(params.account); // case-insensitive
    // Defense-in-depth at the single creation choke point: RegisterDto's @Matches guards the HTTP path,
    // but addUser is also reachable from internal/admin/test callers — enforce the USER grammar here so an
    // illegal account can never reach the DB regardless of caller. (A `!`-group account is rejected too —
    // addUser is for persons; groups are minted via mintGroupAccount at their own create sites.)
    if (!isValidUserAccount(account)) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        `invalid account [${params.account}]`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.prisma.$transaction(async (prisma) => {
      const user = await prisma.user.findUnique({
        where: { account_domain: { account, domain: 'local' } },
      });
      if (user !== null) {
        return { status: 2 };
      }
      const newUser = await prisma.user.create({
        data: {
          account,
          isForeigner: false,
          hashPwd: params.hashPwd ?? null, // null for OTP/QR-only accounts (no password)
          // Display name is now a required registration input (no longer defaulted to account).
          name: params.name,
          avatar: '',
        },
      });
      return {
        status: 0,
        data: { id: newUser.id, account: newUser.account },
      };
    });
  }
}
