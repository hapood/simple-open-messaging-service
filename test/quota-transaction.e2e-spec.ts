import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { QuotaService } from '../src/quota/quota.service.js';
import { UserQuotaService } from '../src/quota/user-quota.service.js';

// The source transaction occupies the only connection. Escaping to the root
// pool must fail promptly instead of hanging the suite indefinitely.
describe('quota operations reuse the source transaction', () => {
  const database = new DatabaseService();
  database.pool.options.max = 1;
  database.pool.options.connectionTimeoutMillis = 1000;
  const users = new UserQuotaService(database);
  const peers = new QuotaService(database);
  const rollback = new Error('source rollback');

  beforeAll(() => database.onModuleInit());
  afterAll(() => database.onApplicationShutdown());

  it.each(['messages', 'files', 'bytes', 'precheck'] as const)(
    'reads uncommitted user policy and allowance for %s without acquiring another connection',
    async (operation) => {
      await expect(
        database.db.transaction(async (tx) => {
          const { rows } = await tx.execute<{ id: number }>(sql`
            INSERT INTO "Account" (account, "updatedAt")
            VALUES ('quota-transaction-user', NOW()) RETURNING id
          `);
          const userId = rows[0].id;
          await tx.execute(sql`
            INSERT INTO "UserQuotaPolicy"
              ("userId", "dailyMsgLimit", "dailyFileLimit", "dailyFileBytesLimit")
            VALUES (${userId}, 2, 2, 10)
          `);
          await tx.execute(sql`
            INSERT INTO "UserQuotaDailyAllowance"
              ("userId", date, "extraMsg", "extraFile", "extraFileBytes")
            VALUES (${userId}, CURRENT_DATE, 3, 3, 20)
          `);
          if (operation === 'bytes') {
            expect(await users.tickFileBytes(userId, 25n, tx)).toEqual({
              bytes: 25n,
              limit: 30,
              over: false,
            });
          } else if (operation === 'precheck') {
            await users.preCheckFile(userId, 4, 25n, tx);
          } else {
            expect(await users.tickLax(userId, operation, tx, 4)).toEqual({
              count: 4,
              limit: 5,
              over: false,
            });
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      const result = await database.pool.query(
        `SELECT id FROM "Account" WHERE account = 'quota-transaction-user'`,
      );
      expect(result.rows).toEqual([]);
    },
  );

  it.each(['messages', 'files', 'bytes', 'strict'] as const)(
    'reads uncommitted peer policy and allowance for %s without acquiring another connection',
    async (operation) => {
      const domain = 'quota-transaction.test';
      await expect(
        database.db.transaction(async (tx) => {
          const namespace = await tx.execute<{ id: number }>(sql`
            INSERT INTO "IdentityNamespace"
              (domain, "signingKeyCreatedAt", "rootPublicKey", "identityPinnedAt", "dailyMsgLimit", "dailyFileLimit", "dailyFileBytesLimit", "dailyRequestLimit")
            VALUES (${domain}, 1700000000000, ${Buffer.alloc(32, 1).toString('base64')}, NOW(), 2, 2, 10, 2) RETURNING id
          `);
          const namespaceId = namespace.rows[0].id;
          await tx.execute(sql`
            INSERT INTO "QuotaDailyAllowance"
              ("namespaceId", date, "extraMsg", "extraFile", "extraFileBytes")
            VALUES (${namespaceId}, CURRENT_DATE, 3, 3, 20)
          `);
          if (operation === 'bytes') {
            expect(await peers.tickFileBytes(namespaceId, 25n, tx)).toEqual({
              bytes: 25n,
              limit: 30,
              over: false,
            });
          } else if (operation === 'strict') {
            await peers.tick(namespaceId, 'requests', tx, 2);
            const usage = await tx.execute<{ count: number }>(sql`
              SELECT count FROM "QuotaDailyUsage" WHERE "namespaceId" = ${namespaceId}
            `);
            expect(usage.rows).toEqual([{ count: 2 }]);
          } else {
            expect(await peers.tickLax(namespaceId, operation, tx, 4)).toEqual({
              count: 4,
              limit: 5,
              over: false,
            });
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      const result = await database.pool.query(
        'SELECT count FROM "QuotaDailyUsage" WHERE "namespaceId" IN (SELECT id FROM "IdentityNamespace" WHERE domain = $1) UNION ALL SELECT "bytes" FROM "QuotaFileByteUsage" WHERE "namespaceId" IN (SELECT id FROM "IdentityNamespace" WHERE domain = $1)',
        [domain],
      );
      expect(result.rows).toEqual([]);
    },
  );
});
