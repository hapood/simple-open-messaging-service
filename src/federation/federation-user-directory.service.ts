import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import type { S2SAddress } from './federation-address.js';
import { loadFederationConfig } from './federation.config.js';

/** Resolves local and foreign federation identities without owning profile materialization. */
@Injectable()
export class FederationUserDirectoryService {
  private readonly config = loadFederationConfig();

  constructor(private readonly database: DatabaseService) {}

  async findLocalUserId(account: string): Promise<number | null> {
    const user = await this.database.db.query.account.findFirst({
      where: and(
        eq(tables.account.account, normalizeAccount(account)),
        eq(tables.account.domain, 'local'),
        eq(tables.account.namespaceId, 0),
      ),
      columns: { id: true, domain: true, availability: true },
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
    const user = await this.database.db.query.account.findFirst({
      where: eq(tables.account.id, userId),
      columns: { account: true, domain: true },
    });
    if (!user || user.domain !== 'local') {
      throw new Error(`user ${userId} is not a local user`);
    }
    return user.account;
  }
}
