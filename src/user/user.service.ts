import { Injectable, HttpStatus } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  account as accountTable,
  profileVersion,
  user,
} from '../database/schema.js';
import { isValidUserAccount, normalizeAccount } from '../common/account.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

@Injectable()
export class UserService {
  constructor(private readonly database: DatabaseService) {}

  // Sensitive columns are omitted at the query layer (never loaded → can't leak into responses),
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
    return this.database.db
      .select({ ...publicUserColumns, ...accountColumns })
      .from(user)
      .innerJoin(accountTable, eq(accountTable.id, user.id))
      .where(userLookupCondition(where))
      .limit(1)
      .then(([row]) => row ?? null);
  }

  /** Self-profile only: omits hashPwd. Client state is synchronized through the unified state revision;
   *  the friend-request seen cursor is device-local. */
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

  /** Create an immutable complete profile snapshot and advance only the local default pointer. */
  async updateProfile(
    userId: number,
    data: { name: string; bio: string; avatar?: string | null },
  ) {
    return this.database.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          defaultProfileRev: user.defaultProfileRev,
          avatar: user.avatar,
        })
        .from(user)
        .where(eq(user.id, userId))
        .for('update')
        .limit(1);
      if (!current) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'user not found',
          HttpStatus.NOT_FOUND,
        );
      }
      const nextRev = current.defaultProfileRev + 1;
      const avatar = data.avatar === undefined ? current.avatar : data.avatar ?? '';
      await tx.insert(profileVersion).values({
        userId,
        profileRev: nextRev,
        displayName: data.name,
        avatar,
        bio: data.bio,
      });
      const [row] = await tx
        .update(user)
        .set({
          name: data.name,
          bio: data.bio,
          avatar,
          defaultProfileRev: nextRev,
          updatedAt: new Date(),
        })
        .where(eq(user.id, userId))
        .returning(publicUserColumns);
      return row;
    });
  }

  queryUsers(params: {
    where?: {
      id?: { in: number[] };
      addresses?: Array<{ account: string; domain: string }>;
      availability?: 'AVAILABLE' | 'REMOVED';
    };
  }) {
    // Default-omit sensitive columns; callers that need them must use an explicit internal query.
    return this.database.db
      .select(publicUserColumns)
      .from(user)
      .where(
        and(
          params.where?.id ? inArray(user.id, params.where.id.in) : undefined,
          params.where?.addresses?.length
            ? or(
                ...params.where.addresses.map((address) =>
                  and(
                    eq(user.account, normalizeAccount(address.account)),
                    eq(user.domain, address.domain),
                  ),
                ),
              )
            : undefined,
          params.where?.availability === undefined
            ? undefined
            : eq(user.availability, params.where.availability),
        ),
      );
  }

  /** Local identity discovery: case-insensitive substring match on account OR name. Local, non-deleted
   *  users and groups only (domain='local') — federated stubs are not discoverable here. Returns { list, total }
   *  for pagination. The caller (POST /user/search) caps `take` as an abuse guardrail. */
  async searchUsers(
    q: string,
    opts: { skip?: number; take: number },
  ): Promise<{
    list: PublicUser[];
    total: number;
  }> {
    const where = and(
      eq(user.availability, 'AVAILABLE'),
      eq(user.domain, 'local'),
      eq(user.sourceDomain, 'local'),
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
          // Display name is now a required registration input (no longer defaulted to account).
          name: params.name,
          avatar: '',
          namespaceId: 0,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [
            user.account,
            user.domain,
            user.sourceDomain,
            user.namespaceId,
          ],
        })
        .returning({ id: user.id, account: user.account });
      if (!newUser) return { status: 2 };
      await tx.insert(accountTable).values({
        id: newUser.id,
        hashPwd: params.hashPwd ?? null,
      });
      await tx.insert(profileVersion).values({
        userId: newUser.id,
        profileRev: 0,
        displayName: params.name,
        avatar: '',
        bio: '',
      });
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
  sourceDomain?: string;
  availability?: 'AVAILABLE' | 'REMOVED';
};

const publicUserColumns = {
  id: user.id,
  account: user.account,
  name: user.name,
  avatar: user.avatar,
  bio: user.bio,
  domain: user.domain,
  sourceDomain: user.sourceDomain,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  availability: user.availability,
  defaultProfileRev: user.defaultProfileRev,
};

const accountColumns = {
  hashPwd: accountTable.hashPwd,
  mustChangePassword: accountTable.mustChangePassword,
  disabledAt: accountTable.disabledAt,
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
          eq(user.sourceDomain, where.sourceDomain ?? 'local'),
        )
      : undefined;
  if (!unique) throw new Error('user lookup requires id or account_domain');
  return and(
    unique,
    where.availability === undefined
      ? undefined
      : eq(user.availability, where.availability),
  );
}
