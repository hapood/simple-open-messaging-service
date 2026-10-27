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
  let namespaceId: number;
  let database: DatabaseService;
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule, QuotaModule],
    }).compile();
    quota = mod.get(QuotaService);
    database = mod.get(DatabaseService);
    const created = await database.pool.query<{ id: number }>(
      'INSERT INTO "IdentityNamespace" (domain, "signingKeyCreatedAt", "rootPublicKey", "identityPinnedAt", active, "trustLevel") VALUES ($1, 1700000000000, $2, NOW(), true, $3) RETURNING id',
      [PEER, Buffer.alloc(32, 1).toString('base64'), 'available'],
    );
    namespaceId = created.rows[0].id;
  });

  beforeEach(async () => {
    await database.pool.query('DELETE FROM "QuotaDailyUsage"');
    await database.pool.query('DELETE FROM "QuotaFileByteUsage"');
    await database.pool.query(
      'UPDATE "IdentityNamespace" SET "dailyMsgLimit" = NULL, "dailyRequestLimit" = NULL, "dailyFileLimit" = NULL, "dailyFileBytesLimit" = NULL WHERE id = $1',
      [namespaceId],
    );
  });

  afterAll(async () => {
    await database.pool.query('DELETE FROM "FederationFeedState" WHERE "namespaceId" = $1', [namespaceId]);
    await database.pool.query('DELETE FROM "IdentityNamespace" WHERE id = $1', [
      namespaceId,
    ]);
    await database.pool.query('DELETE FROM "QuotaDailyUsage"');
    await database.pool.query('DELETE FROM "QuotaFileByteUsage"');
    await mod.close();
  });

  it('increments atomically and rolls the rejected over-limit increment back', async () => {
    await quota.setLimits(namespaceId, { dailyMsgLimit: 2 });
    await quota.tick(namespaceId, 'messages');
    await quota.tick(namespaceId, 'messages');
    await expect(quota.tick(namespaceId, 'messages')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
    });
    expect((await quota.usageToday(namespaceId)).messages.count).toBe(2);
  });

  it('peek rejects at the limit without consuming another unit', async () => {
    await quota.setLimits(namespaceId, { dailyRequestLimit: 1 });
    await quota.tick(namespaceId, 'requests');
    await expect(quota.peek(namespaceId, 'requests')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
    });
    expect((await quota.usageToday(namespaceId)).requests.count).toBe(1);
  });

  it('treats a zero limit as a disabled capability, not an exhausted budget', async () => {
    await quota.setLimits(namespaceId, { dailyRequestLimit: 0 });
    await expect(quota.peek(namespaceId, 'requests')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_CAPABILITY_DISABLED,
      status: 200,
      data: { category: 'requests' },
    });
    await expect(quota.tick(namespaceId, 'requests')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_CAPABILITY_DISABLED,
    });
    expect((await quota.usageToday(namespaceId)).requests.count).toBe(0);
  });

  it('enforces the consolidated peer file-byte cap', async () => {
    await quota.setLimits(namespaceId, { dailyFileBytesLimit: 100n });
    await expect(
      quota.preCheckFile(namespaceId, 0, 101n),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
    });
    await expect(
      quota.preCheckFile(namespaceId, 0, 100n),
    ).resolves.toBeUndefined();
  });

  it('treats a zero media cap as a disabled capability', async () => {
    await quota.setLimits(namespaceId, { dailyFileLimit: 0 });
    await expect(quota.peek(namespaceId, 'files')).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_CAPABILITY_DISABLED,
      status: 200,
      data: { category: 'files' },
    });
  });

  it('falls back to the global peer default when an override is null', async () => {
    await quota.setLimits(namespaceId, { dailyMsgLimit: null });
    expect(
      (await quota.usageToday(namespaceId)).messages.limit,
    ).toBeGreaterThan(0);
  });

  it('lists only peers with active namespaces and shows their usage', async () => {
    await quota.tick(namespaceId, 'messages');
    const nodes = await quota.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      domain: PEER,
      namespaceId,
      trustLevel: 'available',
    });
    expect(nodes[0].usage.messages.count).toBe(1);
    expect(nodes[0].usage.files.limit).toBeGreaterThan(0);

    await database.pool.query(
      'UPDATE "IdentityNamespace" SET active = false WHERE id = $1',
      [namespaceId],
    );
    try {
      expect(await quota.listNodes()).toEqual([]);
      await expect(quota.activeNamespaceId(PEER)).rejects.toMatchObject({
        bizCode: BusinessCode.NOT_FOUND,
      });
    } finally {
      await database.pool.query(
        'UPDATE "IdentityNamespace" SET active = true WHERE id = $1',
        [namespaceId],
      );
    }
  });
});

describe('Local-account UserQuotaService (DB-backed)', () => {
  let quota: UserQuotaService;
  let database: DatabaseService;
  let mod: TestingModule;
  let localUserId: number;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule, QuotaModule],
    }).compile();
    quota = mod.get(UserQuotaService);
    database = mod.get(DatabaseService);
    const local = await database.pool.query<{ id: number }>(
      'INSERT INTO "Account" (account, "updatedAt") VALUES ($1, NOW()) RETURNING id',
      ['quota-local'],
    );
    localUserId = local.rows[0].id;
  });

  beforeEach(async () => {
    await database.pool.query('DELETE FROM "UserQuotaDailyUsage"');
    await database.pool.query('DELETE FROM "UserQuotaFileByteUsage"');
    await database.pool.query('DELETE FROM "UserQuotaPolicy"');
  });

  afterAll(async () => {
    await database.pool.query('DELETE FROM "Account" WHERE id = $1', [
      localUserId,
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
    await quota.setPolicy(localUserId, { dailyFileBytesLimit: 4n });
    await expect(quota.preCheckFile(localUserId, 0, 5n)).rejects.toMatchObject({
      bizCode: BusinessCode.QUOTA_EXCEEDED,
      data: { category: 'files' },
    });
    await expect(
      quota.preCheckFile(localUserId, 0, 4n),
    ).resolves.toBeUndefined();
  });
});
