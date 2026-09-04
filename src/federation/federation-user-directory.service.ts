import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { upsertSourceUserInTx } from '../user/source-user.js';
import type { S2SAddress } from './federation-address.js';
import { loadFederationConfig } from './federation.config.js';

/** Resolves local and foreign federation identities without owning profile materialization. */
@Injectable()
export class FederationUserDirectoryService {
  private readonly config = loadFederationConfig();

  constructor(private readonly database: DatabaseService) {}

  async findLocalUserId(account: string): Promise<number | null> {
    const user = await this.database.db.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizeAccount(account)),
        eq(tables.user.domain, 'local'),
        eq(tables.user.namespaceId, 0),
      ),
    });
    return user?.domain === 'local' && user.availability === 'AVAILABLE'
      ? user.id
      : null;
  }

  async findLocalUserIdByAddress(address: S2SAddress): Promise<number | null> {
    if (address.domain !== this.config.domain) return null;
    return this.findLocalUserId(address.account);
  }

  async requireLocalAccount(userId: number): Promise<string> {
    const user = await this.database.db.query.user.findFirst({
      where: eq(tables.user.id, userId),
      columns: { account: true, domain: true },
    });
    if (!user || user.domain !== 'local') {
      throw new Error(`user ${userId} is not a local user`);
    }
    return user.account;
  }

  async ensureForeignUser(
    account: string,
    domain: string,
    namespaceId: number,
  ): Promise<number> {
    return this.database.db.transaction((tx) =>
      this.ensureForeignUserInTransaction(tx, account, domain, namespaceId),
    );
  }

  async ensureForeignUserInTransaction(
    tx: DatabaseTransaction,
    account: string,
    domain: string,
    namespaceId: number,
  ): Promise<number> {
    const normalizedAccount = normalizeAccount(account);
    const existing = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.account, normalizedAccount),
        eq(tables.user.domain, domain),
        eq(tables.user.namespaceId, namespaceId),
      ),
      columns: { id: true },
    });
    if (existing) return existing.id;
    return upsertSourceUserInTx(tx, {
      account: normalizedAccount,
      domain,
      namespaceId,
      name: normalizedAccount,
      profileRev: 0,
    });
  }
}
