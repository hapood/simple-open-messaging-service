import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { BruteForceService } from '../auth/brute-force.service.js';
import { DatabaseService } from '../database/database.service.js';
import { account } from '../database/schema.js';

/** Enrich restriction observations with exact local-person identities, never IP ownership guesses. */
@Injectable()
export class LoginRestrictionService {
  constructor(
    private readonly bruteForce: BruteForceService,
    private readonly database: DatabaseService,
  ) {}

  async list() {
    const bans = this.bruteForce.listBans();
    const names = [
      ...new Set(
        bans.filter((ban) => ban.type !== 'ip').map((ban) => ban.value),
      ),
    ];
    const people = names.length
      ? await this.database.db
          .select({ id: account.id, account: account.account })
          .from(account)
          .where(
            and(
              eq(account.namespaceId, 0),
              eq(account.kind, 'USER'),
              inArray(account.account, names),
            ),
          )
      : [];
    const ids = new Map(people.map((person) => [person.account, person.id]));
    return bans.map((ban) => ({
      ...ban,
      userId: ban.type === 'ip' ? null : (ids.get(ban.value) ?? null),
    }));
  }
}
