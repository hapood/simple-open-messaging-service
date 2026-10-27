import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { FederationPeerLifecycle } from '../src/federation/federation-peer-lifecycle.js';
import { BusinessCode } from '../src/common/business-code.js';

describe('remote-only federation listing', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let lifecycle: FederationPeerLifecycle;
  let peerId: number;
  const domain = 'remote-list-regression.test';
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    lifecycle = new FederationPeerLifecycle(database, {} as never, {} as never);
    const inserted = await database.pool.query<{ id: number }>(
      'INSERT INTO "IdentityNamespace" (domain, "signingKeyCreatedAt", "rootPublicKey", "identityPinnedAt") VALUES ($1, 1700000000000, $2, NOW()) RETURNING id',
      [domain, Buffer.alloc(32, 23).toString('base64')],
    );
    peerId = inserted.rows[0].id;
  });
  afterAll(async () => {
    if (peerId) {
      await database.pool.query('DELETE FROM "FederationFeedState" WHERE "namespaceId" = $1', [peerId]);
      await database.pool.query(
        'DELETE FROM "IdentityNamespace" WHERE id = $1',
        [peerId],
      );
    }
    await mod?.close();
  });
  it('excludes namespace zero even when explicitly filtered', async () => {
    expect(await lifecycle.list({ skip: 0, take: 20, namespaceId: 0 })).toEqual(
      { list: [], total: 0 },
    );
    const local = await database.pool.query<{ domain: string }>(
      'SELECT domain FROM "IdentityNamespace" WHERE id = 0',
    );
    expect(local.rows).toHaveLength(1);
    await expect(lifecycle.detail(local.rows[0].domain)).rejects.toMatchObject({
      bizCode: BusinessCode.NOT_FOUND,
    });
  });
  it('keeps total and offset consistent for remote filtered rows', async () => {
    const first = await lifecycle.list({
      skip: 0,
      take: 1,
      search: domain,
      status: 'unrecognized',
    });
    expect(first.total).toBe(1);
    expect(first.list.map((peer) => peer.id)).toEqual([peerId]);
    expect(await lifecycle.list({ skip: 1, take: 1, search: domain })).toEqual({
      total: 1,
      list: [],
    });
  });
});
