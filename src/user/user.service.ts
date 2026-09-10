import { Injectable, HttpStatus } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { account as accountTable, profileTable } from '../database/schema.js';
import { isValidUserAccount, normalizeAccount } from '../common/account.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

const selectedProfile = and(
  eq(profileTable.account, accountTable.account),
  eq(profileTable.domain, 'local'),
  eq(profileTable.namespaceId, 0),
  eq(profileTable.profileRev, accountTable.defaultProfileRev),
);

const publicUserColumns = {
  id: accountTable.id,
  account: accountTable.account,
  name: sql<string>`COALESCE(${profileTable.displayName}, ${accountTable.account})`,
  avatar: sql<string>`COALESCE(${profileTable.avatar}, '')`,
  bio: sql<string>`COALESCE(${profileTable.bio}, '')`,
  domain: sql<'local'>`'local'::text`,
  namespaceId: sql<number>`0::integer`,
  createdAt: accountTable.createdAt,
  updatedAt: accountTable.updatedAt,
  availability: accountTable.availability,
  defaultProfileRev: accountTable.defaultProfileRev,
};

@Injectable()
export class UserService {
  constructor(private readonly database: DatabaseService) {}

  findUniqueUser(where: UserLookup) {
    return this.database.db
      .select(publicUserColumns)
      .from(accountTable)
      .leftJoin(profileTable, selectedProfile)
      .where(userLookupCondition(where))
      .limit(1)
      .then(([row]) => row ?? null);
  }

  /** Password hashes are selected only by the authentication path. */
  findUniqueUserForAuth(where: UserLookup) {
    return this.database.db
      .select({
        ...publicUserColumns,
        hashPwd: accountTable.hashPwd,
        mustChangePassword: accountTable.mustChangePassword,
        disabledAt: accountTable.disabledAt,
      })
      .from(accountTable)
      .leftJoin(profileTable, selectedProfile)
      .where(userLookupCondition(where))
      .limit(1)
      .then(([row]) => row ?? null);
  }

  findSelfProfile(userId: number) {
    return this.findUniqueUser({ id: userId });
  }

  async updateProfile(
    userId: number,
    data: { name: string; bio: string; avatar?: string | null },
  ) {
    return this.database.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          account: accountTable.account,
          defaultProfileRev: accountTable.defaultProfileRev,
        })
        .from(accountTable)
        .where(eq(accountTable.id, userId))
        .for('no key update')
        .limit(1);
      if (!current)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'user not found',
          HttpStatus.NOT_FOUND,
        );
      const previous = await tx.query.profileTable.findFirst({
        where: and(
          eq(profileTable.account, current.account),
          eq(profileTable.domain, 'local'),
          eq(profileTable.namespaceId, 0),
          eq(profileTable.profileRev, current.defaultProfileRev),
        ),
      });
      const nextRev = current.defaultProfileRev + 1;
      await tx.insert(profileTable).values({
        account: current.account,
        domain: 'local',
        namespaceId: 0,
        profileRev: nextRev,
        displayName: data.name,
        bio: data.bio,
        avatar:
          data.avatar === undefined
            ? (previous?.avatar ?? '')
            : (data.avatar ?? ''),
      });
      await tx
        .update(accountTable)
        .set({ defaultProfileRev: nextRev, updatedAt: new Date() })
        .where(eq(accountTable.id, userId));
      const [row] = await tx
        .select(publicUserColumns)
        .from(accountTable)
        .leftJoin(profileTable, selectedProfile)
        .where(eq(accountTable.id, userId));
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
    const addresses = params.where?.addresses?.filter(
      (address) => address.domain === 'local',
    );
    return this.database.db
      .select(publicUserColumns)
      .from(accountTable)
      .leftJoin(profileTable, selectedProfile)
      .where(
        and(
          params.where?.id
            ? inArray(accountTable.id, params.where.id.in)
            : undefined,
          params.where?.addresses !== undefined
            ? addresses?.length
              ? inArray(
                  accountTable.account,
                  addresses.map((address) => normalizeAccount(address.account)),
                )
              : sql`false`
            : undefined,
          params.where?.availability === undefined
            ? undefined
            : eq(accountTable.availability, params.where.availability),
        ),
      );
  }

  async searchUsers(
    q: string,
    opts: { skip?: number; take: number },
  ): Promise<{ list: PublicUser[]; total: number }> {
    const where = and(
      eq(accountTable.kind, 'USER'),
      eq(accountTable.availability, 'AVAILABLE'),
      or(
        ilike(accountTable.account, `%${q}%`),
        ilike(profileTable.displayName, `%${q}%`),
      ),
    );
    const [list, total] = await Promise.all([
      this.database.db
        .select(publicUserColumns)
        .from(accountTable)
        .leftJoin(profileTable, selectedProfile)
        .where(where)
        .orderBy(desc(accountTable.createdAt))
        .offset(opts.skip ?? 0)
        .limit(opts.take),
      this.database.db
        .select({ value: count() })
        .from(accountTable)
        .leftJoin(profileTable, selectedProfile)
        .where(where)
        .then(([row]) => row.value),
    ]);
    return { list, total };
  }

  addUser(params: { account: string; name: string; hashPwd?: string | null }) {
    const address = normalizeAccount(params.account);
    if (!isValidUserAccount(address))
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        `invalid account [${params.account}]`,
        HttpStatus.BAD_REQUEST,
      );
    return this.database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(accountTable)
        .values({
          account: address,
          defaultProfileRev: 1,
          hashPwd: params.hashPwd ?? null,
        })
        .onConflictDoNothing({ target: accountTable.account })
        .returning({ id: accountTable.id, account: accountTable.account });
      if (!created) return { status: 2 };
      await tx.insert(profileTable).values({
        account: address,
        domain: 'local',
        namespaceId: 0,
        profileRev: 1,
        displayName: params.name,
        avatar: '',
        bio: '',
      });
      return { status: 0, data: created };
    });
  }
}

export type UserLookup = (
  | { id: number; account_domain?: never; namespaceId?: never }
  | {
      id?: never;
      account_domain: { account: string; domain: string };
      namespaceId: number;
    }
) & { availability?: 'AVAILABLE' | 'REMOVED' };

export type PublicUser = NonNullable<
  Awaited<ReturnType<UserService['findUniqueUser']>>
>;

function userLookupCondition(where: UserLookup) {
  if (where.account_domain && !Number.isInteger(where.namespaceId))
    throw new Error('address lookup requires an explicit namespaceId');
  const unique =
    where.id !== undefined
      ? eq(accountTable.id, where.id)
      : where.account_domain
        ? where.account_domain.domain === 'local' && where.namespaceId === 0
          ? eq(
              accountTable.account,
              normalizeAccount(where.account_domain.account),
            )
          : sql`false`
        : undefined;
  if (!unique) throw new Error('user lookup requires id or account_domain');
  return and(
    unique,
    where.availability === undefined
      ? undefined
      : eq(accountTable.availability, where.availability),
  );
}
