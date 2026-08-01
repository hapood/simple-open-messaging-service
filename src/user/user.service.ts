import { Injectable, OnModuleInit, HttpStatus } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { user } from '../database/schema.js';
import { isValidUserAccount, normalizeAccount } from '../common/account.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

@Injectable()
export class UserService implements OnModuleInit {
  constructor(private readonly database: DatabaseService) {}

  async onModuleInit() {}

  // Sensitive columns are omitted at the Prisma layer (never loaded → can't leak into responses),
  // so there are no per-site `delete` lines. hashPwd is omitted by default; the opt-in read below
  // re-includes it where a legitimate internal consumer (the login path) needs it.
  findUniqueUser(where: UserLookup) {
    return this.database.db
      .select(publicUserColumns)
      .from(user)
      .where(userLookupCondition(where))
      .limit(1)
      .then(([row]) => row ?? null);
  }

  /** Login path only: keeps hashPwd (argon2.verify needs it). Auth-only. */
  findUniqueUserForAuth(where: UserLookup) {
    return this.database.db.query.user
      .findFirst({
        where: userLookupCondition(where),
      })
      .then((row) => row ?? null);
  }

  /** Self-profile only: omits hashPwd. (threadRevision rides the SSE HELLO handshake; the friend-request
   *  badge is derived client-side from the HELLO/push-carried friendReqRev = MAX(createdAt) over incoming
   *  FRIEND invites — no denormalized badge column.) */
  findSelfProfile(userId: number) {
    return this.findUniqueUser({ id: userId });
  }

  updateUser(params: {
    where: UserLookup;
    data: Partial<typeof user.$inferInsert>;
  }) {
    const { where, data } = params;
    return this.database.db
      .update(user)
      .set({ ...data, updatedAt: new Date() })
      .where(userLookupCondition(where))
      .returning()
      .then(([row]) => row);
  }

  /** Update the current user's avatar (inline User.avatar). */
  updateAvatar(userId: number, avatar: string) {
    return this.database.db
      .update(user)
      .set({
        avatar,
        profileRev: sql`${user.profileRev} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId))
      .returning()
      .then(([row]) => row);
  }

  /** Update the current user's display name / bio (inline User columns). */
  updateProfile(userId: number, data: { name?: string; bio?: string }) {
    const update: Partial<typeof user.$inferInsert> = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.bio !== undefined) update.bio = data.bio;
    return this.database.db
      .update(user)
      .set({
        ...update,
        profileRev: sql`${user.profileRev} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId))
      .returning(publicUserColumns)
      .then(([row]) => row);
  }

  queryUsers(params: {
    where?: { id?: { in: number[] }; isDeleted?: boolean };
  }) {
    // Default-omit sensitive columns. Callers needing an explicit `select` must hit prisma directly
    // (select + omit are mutually exclusive in Prisma); all current callers pass only `where`.
    return this.database.db
      .select(publicUserColumns)
      .from(user)
      .where(
        and(
          params.where?.id ? inArray(user.id, params.where.id.in) : undefined,
          params.where?.isDeleted === undefined
            ? undefined
            : eq(user.isDeleted, params.where.isDeleted),
        ),
      );
  }

  /** Local user discovery: case-insensitive substring match on account OR name. Local, non-deleted
   *  users only (isForeigner:false) — federated stubs are not discoverable here. Returns { list, total }
   *  for pagination. The caller (POST /user/search) caps `take` as an abuse guardrail. */
  async searchUsers(
    q: string,
    opts: { skip?: number; take: number },
  ): Promise<{
    list: PublicUser[];
    total: number;
  }> {
    const where = and(
      eq(user.isDeleted, false),
      eq(user.isForeigner, false),
      eq(user.isGroup, false),
      or(ilike(user.account, `%${q}%`), ilike(user.name, `%${q}%`)),
    );
    const [list, total] = await Promise.all([
      this.database.db
        .select(publicUserColumns)
        .from(user)
        .where(where)
        .orderBy(desc(user.createdAt))
        .offset(opts.skip ?? 0)
        .limit(opts.take),
      this.database.db
        .select({ value: count() })
        .from(user)
        .where(where)
        .then(([row]) => row.value),
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
    return this.database.db.transaction(async (tx) => {
      const [newUser] = await tx
        .insert(user)
        .values({
          account,
          isForeigner: false,
          hashPwd: params.hashPwd ?? null, // null for OTP/QR-only accounts (no password)
          // Display name is now a required registration input (no longer defaulted to account).
          name: params.name,
          avatar: '',
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: [user.account, user.domain] })
        .returning({ id: user.id, account: user.account });
      if (!newUser) return { status: 2 };
      return {
        status: 0,
        data: { id: newUser.id, account: newUser.account },
      };
    });
  }
}

export type UserLookup = {
  id?: number;
  account_domain?: { account: string; domain: string };
  isDeleted?: boolean;
};

const publicUserColumns = {
  id: user.id,
  account: user.account,
  name: user.name,
  avatar: user.avatar,
  bio: user.bio,
  isForeigner: user.isForeigner,
  isGroup: user.isGroup,
  domain: user.domain,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  isDeleted: user.isDeleted,
  profileRev: user.profileRev,
  remoteProfileRev: user.remoteProfileRev,
  mustChangePassword: user.mustChangePassword,
};

export type PublicUser = Pick<
  typeof user.$inferSelect,
  keyof typeof publicUserColumns
>;

function userLookupCondition(where: UserLookup) {
  const unique = where.id
    ? eq(user.id, where.id)
    : where.account_domain
      ? and(
          eq(user.account, where.account_domain.account),
          eq(user.domain, where.account_domain.domain),
        )
      : undefined;
  if (!unique) throw new Error('user lookup requires id or account_domain');
  return and(
    unique,
    where.isDeleted === undefined
      ? undefined
      : eq(user.isDeleted, where.isDeleted),
  );
}
