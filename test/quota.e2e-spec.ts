import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { QuotaService } from '../src/quota/quota.service.js';
import { UserQuotaService } from '../src/quota/user-quota.service.js';

/** Policy survives runtime replacement; usage intentionally does not. */
describe('symmetric durable quota policies', () => {
  const database = new DatabaseService();
  let peers: QuotaService;
  let users: UserQuotaService;
  let nsid: number;
  let userId: number;
  beforeAll(async () => {
    await database.onModuleInit();
    nsid = (
      await database.pool.query(
        'INSERT INTO "IdentityNamespace" (domain, "signingKeyCreatedAt", "rootPublicKey", "identityPinnedAt") VALUES ($1, 1700000000000, $2, NOW()) RETURNING id',
        ['quota-policy.test', Buffer.alloc(32, 93).toString('base64')],
      )
    ).rows[0].id;
    userId = (
      await database.pool.query(
        'INSERT INTO "Account" (account) VALUES ($1) RETURNING id',
        ['quota-policy-user'],
      )
    ).rows[0].id;
  });
  beforeEach(async () => {
    peers = new QuotaService(database);
    users = new UserQuotaService(database);
    await peers.setLimits(nsid, {});
    await users.setPolicy(userId, {});
  });
  afterAll(async () => {
    await database.pool.query('DELETE FROM "Account" WHERE id = $1', [userId]);
    await database.pool.query(
      'DELETE FROM "FederationFeedState" WHERE "namespaceId" = $1',
      [nsid],
    );
    await database.pool.query('DELETE FROM "IdentityNamespace" WHERE id = $1', [
      nsid,
    ]);
    await database.onApplicationShutdown();
  });
  it('persists single-file overrides and enforces nullable safe-integer constraints', async () => {
    for (const value of [0n, 2n * 1024n ** 3n, null]) {
      await peers.setLimits(nsid, { maxFileBytes: value });
      await users.setPolicy(userId, { maxFileBytes: value });
      expect(await new QuotaService(database).fileSizeLimit(nsid)).toBe(
        Number(value ?? 1024n ** 3n),
      );
      expect(await new UserQuotaService(database).fileSizeLimit(userId)).toBe(
        Number(value ?? 1024n ** 3n),
      );
    }
    for (const [table, key, id] of [
      ['FederationQuotaPolicy', 'nsid', nsid],
      ['UserQuotaPolicy', 'account', 'quota-policy-user'],
    ] as const) {
      for (const value of ['-1', '9007199254740992']) {
        await expect(
          database.pool.query(
            `UPDATE "${table}" SET "maxFileBytes" = $1 WHERE "${key}" = $2`,
            [value, id],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
    }
  });

  it('stores symmetric daily and single-file overrides under namespace and account keys', async () => {
    const policy = {
      maxFileBytes: 1024n ** 3n,
      dailyMsgLimit: 2,
      dailyRequestLimit: 3,
      dailySignalLimit: 401,
      dailyFileLimit: 4,
      dailyFileBytesLimit: 100n,
    };
    await peers.setLimits(nsid, policy);
    await users.setPolicy(userId, policy);
    expect(
      (
        await database.pool.query(
          'SELECT * FROM "FederationQuotaPolicy" WHERE nsid = $1',
          [nsid],
        )
      ).rows[0],
    ).toMatchObject({ nsid, dailySignalLimit: 401 });
    expect(
      (
        await database.pool.query(
          'SELECT * FROM "UserQuotaPolicy" WHERE account = $1',
          ['quota-policy-user'],
        )
      ).rows[0],
    ).toMatchObject({ account: 'quota-policy-user', dailySignalLimit: 401 });
    expect(await peers.getOverrides(nsid)).toEqual(
      await users.getOverrides(userId),
    );
  });
  it('keeps configured limits but resets usage and temporary grants on restart', async () => {
    await peers.setLimits(nsid, { dailyRequestLimit: 1 });
    await peers.tick(nsid, 'requests');
    await peers.addQuota(nsid, { addRequest: 5 });
    expect((await peers.usageToday(nsid)).requests).toMatchObject({
      count: 1,
      limit: 6,
    });
    const restarted = new QuotaService(database);
    expect((await restarted.usageToday(nsid)).requests).toEqual({
      count: 0,
      limit: 1,
      remaining: 1,
    });
  });
  it('uses strict synchronous memory admission across concurrent callers', async () => {
    await users.setPolicy(userId, { dailySignalLimit: 400 });
    const result = await Promise.allSettled([
      users.tickStandalone(userId, 'signals', 400),
      users.tickStandalone(userId, 'signals', 400),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await users.getState(userId)).usage.signals.count).toBe(400);
  });
  it('changes a limit without clearing usage and permits null inheritance', async () => {
    await users.setPolicy(userId, { dailyRequestLimit: 1 });
    await users.tickStandalone(userId, 'requests');
    await users.setPolicy(userId, { dailyRequestLimit: 3 });
    expect((await users.getState(userId)).usage.requests).toEqual({
      count: 1,
      limit: 3,
      remaining: 2,
    });
    await users.setPolicy(userId, { dailyRequestLimit: null });
    expect((await users.getState(userId)).usage.requests.limit).toBe(50);
  });
  it('contains no persisted usage or grant tables', async () => {
    const tables = await database.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '%Quota%'",
    );
    expect(tables.rows.map((r) => r.tablename).sort()).toEqual([
      'FederationQuotaPolicy',
      'UserQuotaPolicy',
    ]);
  });
});
