import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { QuotaService } from '../src/quota/quota.service.js';
import { UserQuotaService } from '../src/quota/user-quota.service.js';

// Policy reads inside a source transaction must not acquire a second pool connection.
describe('quota policy resolution in source transactions', () => {
  const database = new DatabaseService();
  database.pool.options.max = 1;
  database.pool.options.connectionTimeoutMillis = 1000;
  const rollback = new Error('source rollback');
  beforeAll(() => database.onModuleInit());
  afterAll(() => database.onApplicationShutdown());
  it.each(['messages', 'files', 'requests', 'signals'] as const)(
    'loads local %s policy through the supplied transaction',
    async (category) => {
      const users = new UserQuotaService(database);
      await expect(
        database.db.transaction(async (tx) => {
          const { rows } = await tx.execute<{ id: number }>(
            sql`INSERT INTO "Account" (account) VALUES ('quota-tx-user') RETURNING id`,
          );
          await tx.execute(
            sql`INSERT INTO "UserQuotaPolicy" (account, "dailyMsgLimit", "dailyFileLimit", "dailyRequestLimit", "dailySignalLimit") VALUES ('quota-tx-user', 2, 2, 2, 2)`,
          );
          await users.tick(rows[0].id, category, tx, 2);
          await expect(users.tick(rows[0].id, category, tx)).rejects.toThrow();
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
  );
  it('loads namespace policy through the supplied transaction', async () => {
    const peers = new QuotaService(database);
    await expect(
      database.db.transaction(async (tx) => {
        const { rows } = await tx.execute<{ id: number }>(
          sql`INSERT INTO "IdentityNamespace" (domain, "signingKeyCreatedAt", "rootPublicKey", "identityPinnedAt") VALUES ('quota-tx.test', 1700000000000, ${Buffer.alloc(32, 94).toString('base64')}, NOW()) RETURNING id`,
        );
        await tx.execute(
          sql`INSERT INTO "FederationQuotaPolicy" (nsid, "dailyFileLimit", "dailyFileBytesLimit") VALUES (${rows[0].id}, 1, 10)`,
        );
        await peers.claimFile(rows[0].id, 1, 10n, tx);
        await expect(peers.claimFile(rows[0].id, 1, 1n, tx)).rejects.toThrow();
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
