import { Injectable, HttpStatus } from '@nestjs/common';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { account as accountTable, profileTable } from '../database/schema.js';
import { isValidUserAccount, normalizeAccount } from '../common/account.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

const selectedProfile = and(
  eq(profileTable.account, accountTable.account),
  eq(profileTable.publisherNamespaceId, 0),
  eq(profileTable.profileNamespaceId, 0),
  eq(profileTable.profileRev, accountTable.defaultProfileRev),
);

const publicUserColumns = {
  id: accountTable.id,
  account: accountTable.account,
  name: sql<string>`COALESCE(${profileTable.displayName}, ${accountTable.account})`,
  avatar: sql<string>`COALESCE(${profileTable.avatar}, '')`,
  bio: sql<string>`COALESCE(${profileTable.bio}, '')`,
  namespaceId: accountTable.namespaceId,
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

  findUniqueUserByNamespaceAddress(
    address: { account: string; namespaceId: number },
    availability: 'AVAILABLE' | 'REMOVED' = 'AVAILABLE',
  ) {
    return this.database.db
      .select(publicUserColumns)
      .from(accountTable)
      .leftJoin(profileTable, selectedProfile)
      .where(
        and(
          eq(accountTable.account, normalizeAccount(address.account)),
          eq(accountTable.namespaceId, address.namespaceId),
          eq(accountTable.availability, availability),
        ),
      )
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

  /** Profile responses require the exact stored snapshot, not account display fallbacks. */
  findSelfProfile(userId: number) {
    return this.database.db
      .select({
        ...publicUserColumns,
        name: profileTable.displayName,
        avatar: profileTable.avatar,
        bio: profileTable.bio,
      })
      .from(accountTable)
      .innerJoin(profileTable, selectedProfile)
      .where(eq(accountTable.id, userId))
      .limit(1)
      .then(([row]) => row ?? null);
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
          eq(profileTable.publisherNamespaceId, 0),
          eq(profileTable.profileNamespaceId, 0),
          eq(profileTable.profileRev, current.defaultProfileRev),
        ),
      });
      const nextRev = current.defaultProfileRev + 1;
      await tx.insert(profileTable).values({
        account: current.account,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
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
          namespaceId: 0,
          defaultProfileRev: 1,
          hashPwd: params.hashPwd ?? null,
        })
        .onConflictDoNothing({ target: accountTable.account })
        .returning({ id: accountTable.id, account: accountTable.account });
      if (!created) return { status: 2 };
      await tx.insert(profileTable).values({
        account: address,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
        displayName: params.name,
        avatar: '',
        bio: '',
      });
      return { status: 0, data: created };
    });
  }
}

/** Account-name lookups are local-only; namespace-address lookups use the explicit address method. */
export type UserLookup = (
  | { id: number; account?: never }
  | { id?: never; account: string }
) & { availability?: 'AVAILABLE' | 'REMOVED' };

export type PublicUser = NonNullable<
  Awaited<ReturnType<UserService['findUniqueUser']>>
>;

function userLookupCondition(where: UserLookup) {
  const unique =
    where.id !== undefined
      ? eq(accountTable.id, where.id)
      : where.account !== undefined
        ? and(
            eq(accountTable.account, normalizeAccount(where.account)),
            // Local-user lookup: account rows are local identities (namespace 0).
            eq(accountTable.namespaceId, 0),
          )
        : undefined;
  if (!unique) throw new Error('user lookup requires id or account');
  return and(
    unique,
    where.availability === undefined
      ? undefined
      : eq(accountTable.availability, where.availability),
  );
}
