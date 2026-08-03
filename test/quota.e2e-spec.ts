import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../src/database/database.service.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { QuotaModule } from '../src/quota/quota.module.js';
import { QuotaService } from '../src/quota/quota.service.js';
import { UserQuotaService } from '../src/quota/user-quota.service.js';
import { BusinessCode } from '../src/common/business-code.js';

const PEER = 'quota-peer.local';

describe('Federated peer QuotaService (DB-backed)', () => {
  let quota: QuotaService;
  let database: DatabaseService;
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule, QuotaModule],
    }).compile();
    quota = mod.get(QuotaService);
    database = mod.get(DatabaseService);
    await database.pool.query(
      'INSERT INTO "FederatedPeer" (domain, "trustLevel") VALUES ($1, $2) ON CONFLICT (domain) DO NOTHING',
      [PEER, 'trusted'],
    );
  });

  beforeEach(async () => {
    await database.pool.query('DELETE FROM "QuotaDailyUsage"');
    await database.pool.query(
      'UPDATE "FederatedPeer" SET "dailyMsgLimit" = NULL, "dailyImageLimit" = NULL, "dailyLargeFileLimit" = NULL, "dailyRequestLimit" = NULL, "maxImageBytes" = NULL, "maxLargeFileBytes" = NULL WHERE domain = $1',
      [PEER],
    );
  });

  afterAll(async () => {
    await database.pool.query('DELETE FROM "FederatedPeer" WHERE domain = $1', [
      PEER,
    ]);
    await database.pool.query('DELETE FROM "QuotaDailyUsage"');
    await mod.close();
  });

  it('increments atomically and rolls the rejected over-limit increment back', async () => {
    await quota.setLimits(PEER, { dailyMsgLimit: 2 });
    await quota.tick(PEER, 'messages');
    await quota.tick(PEER, 'messages');
    await expect(quota.tick(PEER, 'messages')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
    });
    expect((await quota.usageToday(PEER)).messages.count).toBe(2);
  });

  it('peek rejects at the limit without consuming another unit', async () => {
    await quota.setLimits(PEER, { dailyRequestLimit: 1 });
    await quota.tick(PEER, 'requests');
    await expect(quota.peek(PEER, 'requests')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
    });
    expect((await quota.usageToday(PEER)).requests.count).toBe(1);
  });

  it('treats a zero limit as a disabled capability, not an exhausted budget', async () => {
    await quota.setLimits(PEER, { dailyRequestLimit: 0 });
    await expect(quota.peek(PEER, 'requests')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_CAPABILITY_DISABLED,
      status: 403,
      data: { category: 'requests' },
    });
    await expect(quota.tick(PEER, 'requests')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_CAPABILITY_DISABLED,
    });
    expect((await quota.usageToday(PEER)).requests.count).toBe(0);
  });

  it('enforces the peer media byte cap', async () => {
    await quota.setLimits(PEER, { maxImageBytes: 100 });
    await expect(
      quota.assertUnderCap(PEER, 'images', 101),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
    });
    await expect(
      quota.assertUnderCap(PEER, 'images', 100),
    ).resolves.toBeUndefined();
  });

  it('treats a zero media cap as a disabled capability', async () => {
    await quota.setLimits(PEER, { maxImageBytes: 0 });
    await expect(quota.assertUnderCap(PEER, 'images', 1)).rejects.toMatchObject(
      {
        bizCode: BusinessCode.FEDERATION_CAPABILITY_DISABLED,
        status: 403,
        data: { category: 'images' },
      },
    );
  });

  it('falls back to the global peer default when an override is null', async () => {
    await quota.setLimits(PEER, { dailyMsgLimit: null });
    expect((await quota.usageToday(PEER)).messages.limit).toBeGreaterThan(0);
  });

  it('lists only federated peer quota nodes with today usage', async () => {
    await quota.tick(PEER, 'messages');
    const nodes = await quota.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ domain: PEER, trustLevel: 'trusted' });
    expect(nodes[0].usage?.messages.count).toBe(1);
    expect(nodes[0].effectiveCaps.images).toBeGreaterThan(0);
    expect(nodes[0].effectiveCaps.largeFiles).toBeGreaterThan(0);
  });
});

describe('Local-account UserQuotaService (DB-backed)', () => {
  let quota: UserQuotaService;
  let database: DatabaseService;
  let mod: TestingModule;
  let localUserId: number;
  let foreignUserId: number;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule, QuotaModule],
    }).compile();
    quota = mod.get(UserQuotaService);
    database = mod.get(DatabaseService);
    const local = await database.pool.query<{ id: number }>(
      'INSERT INTO "User" (account, name, "isForeigner", domain, "updatedAt") VALUES ($1, $2, false, $3, NOW()) RETURNING id',
      ['quota-local', 'Quota Local', 'local'],
    );
    localUserId = local.rows[0].id;
    const foreign = await database.pool.query<{ id: number }>(
      'INSERT INTO "User" (account, name, "isForeigner", domain, "updatedAt") VALUES ($1, $2, true, $3, NOW()) RETURNING id',
      ['quota-foreign', 'Quota Foreign', 'peer.local'],
    );
    foreignUserId = foreign.rows[0].id;
  });

  beforeEach(async () => {
    await database.pool.query('DELETE FROM "UserQuotaDailyUsage"');
    await database.pool.query('DELETE FROM "UserQuotaPolicy"');
  });

  afterAll(async () => {
    await database.pool.query('DELETE FROM "User" WHERE id = ANY($1)', [
      [localUserId, foreignUserId],
    ]);
    await mod.close();
  });

  it('stores per-user overrides and rolls back a rejected atomic tick', async () => {
    await quota.setPolicy(localUserId, { dailyMsgLimit: 1 });
    await database.db.transaction((tx) =>
      quota.tick(localUserId, 'messages', tx),
    );
    await expect(
      database.db.transaction((tx) => quota.tick(localUserId, 'messages', tx)),
    ).rejects.toMatchObject({ bizCode: BusinessCode.QUOTA_EXCEEDED });
    expect((await quota.getState(localUserId)).usage.messages).toMatchObject({
      count: 1,
      limit: 1,
    });
  });

  it('enforces the effective per-user media byte cap', async () => {
    await quota.setPolicy(localUserId, { maxImageBytes: 4 });
    await expect(
      quota.assertWithinByteCap(localUserId, 'images', 5),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.QUOTA_EXCEEDED,
      data: { category: 'images', limit: 4, actual: 5 },
    });
    await expect(
      quota.assertWithinByteCap(localUserId, 'images', 4),
    ).resolves.toBeUndefined();
  });

  it('does not expose personal quota for a federated user stub', async () => {
    await expect(quota.getState(foreignUserId)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
  });
});
