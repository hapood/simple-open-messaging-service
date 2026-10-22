import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import type { S2SAddress } from './federation-address.js';
/** Resolves local and foreign federation identities without owning profile materialization. */
@Injectable()
export class FederationUserDirectoryService {
  constructor(private readonly database: DatabaseService) {}

  async findLocalUserId(account: string): Promise<number | null> {
    const user = await this.database.db.query.account.findFirst({
      where: and(
        eq(tables.account.account, normalizeAccount(account)),
        eq(tables.account.namespaceId, 0),
      ),
      columns: { id: true, availability: true },
    });
    return user?.availability === 'AVAILABLE' ? user.id : null;
  }

  async findLocalUserIdByAddress(address: S2SAddress): Promise<number | null> {
    const local = await this.database.db.query.identityNamespace.findFirst({
      where: and(
        eq(tables.identityNamespace.id, 0),
        eq(tables.identityNamespace.domain, address.domain),
      ),
      columns: { id: true },
    });
    return local ? this.findLocalUserId(address.account) : null;
  }

  async requireLocalAccount(userId: number): Promise<string> {
    const user = await this.database.db.query.account.findFirst({
      where: eq(tables.account.id, userId),
      columns: { account: true, namespaceId: true },
    });
    if (!user || user.namespaceId !== 0) {
      throw new Error(`user ${userId} is not a local user`);
    }
    return user.account;
  }
}
