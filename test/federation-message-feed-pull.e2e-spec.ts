import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { federatedPeer, federationPullCursor } from '../src/database/schema.js';
import {
  FederationMessageFeedPullService,
  type FederationMessageFeedPullCallbacks,
} from '../src/federation/federation-message-feed-pull.service.js';
import type { FederationMessageFeedPage } from '../src/federation/federation-message-feed.service.js';

describe('FederationMessageFeedPullService', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationMessageFeedPullService;
  const peerDomain = 'pull-peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [FederationMessageFeedPullService],
    }).compile();
    database = mod.get(DatabaseService);
    service = mod.get(FederationMessageFeedPullService);
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "FederatedPeer" CASCADE');
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      trustLevel: 'trusted',
    });
    await database.db.insert(federationPullCursor).values({ peerDomain });
  });

  afterAll(async () => {
    await mod.close();
  });

  const page = (
    scannedThrough: bigint,
    allocatedThrough: bigint,
    changeIds: bigint[] = [],
    hasMore = false,
  ): FederationMessageFeedPage => ({
    scannedThrough: scannedThrough.toString(),
    allocatedThrough: allocatedThrough.toString(),
    hasMore,
    messages: changeIds.map((changeId) => ({
      changeId: changeId.toString(),
      thread: { type: 'P2P', participants: [] },
      author: { account: 'alice', domain: peerDomain },
      seq: Number(changeId),
      originSeq: Number(changeId),
      contentType: 'PURE_TEXT',
      content: '{}',
      createdAt: 0,
      updatedAt: 0,
      isDeleted: false,
      clientMessageId: null,
      assets: [],
    })),
  });

  it('keeps pulling through a final empty acknowledgement page', async () => {
    const requested: bigint[] = [];
    const applied: string[][] = [];
    const callbacks: FederationMessageFeedPullCallbacks = {
      fetch: async (after) => {
        requested.push(after);
        if (after === 0n) return page(2n, 5n, [1n, 2n], true);
        if (after === 2n) return page(5n, 5n, [3n, 5n]);
        return page(5n, 5n);
      },
      apply: async (_tx, value) => {
        applied.push(value.messages.map((item) => item.changeId));
      },
    };

    await service.run(peerDomain, callbacks);

    expect(requested).toEqual([0n, 2n, 5n]);
    expect(applied).toEqual([['1', '2'], ['3', '5'], []]);
    const cursor = await database.db.query.federationPullCursor.findFirst({
      where: eq(federationPullCursor.peerDomain, peerDomain),
    });
    expect(cursor).toMatchObject({ remoteHwm: 5n });
  });

  it('observes a push arriving during the final request and continues', async () => {
    const requested: bigint[] = [];
    let pushed = false;
    let callbacks!: FederationMessageFeedPullCallbacks;
    callbacks = {
      fetch: async (after) => {
        requested.push(after);
        if (!pushed) {
          pushed = true;
          await service.advertise(peerDomain, 1n);
          void service.run(peerDomain, callbacks);
          return page(0n, 0n);
        }
        return after === 0n ? page(1n, 1n, [1n]) : page(1n, 1n);
      },
      apply: async () => undefined,
    };

    await service.run(peerDomain, callbacks);

    expect(requested).toEqual([0n, 0n, 1n]);
    const cursor = await database.db.query.federationPullCursor.findFirst({
      where: eq(federationPullCursor.peerDomain, peerDomain),
    });
    expect(cursor?.remoteHwm).toBe(1n);
  });

  it('rolls back remoteHwm when applying a page fails', async () => {
    await expect(
      service.run(peerDomain, {
        fetch: async () => page(1n, 1n, [1n]),
        apply: async () => {
          throw new Error('apply failed');
        },
      }),
    ).rejects.toThrow('apply failed');

    const cursor = await database.db.query.federationPullCursor.findFirst({
      where: eq(federationPullCursor.peerDomain, peerDomain),
    });
    expect(cursor?.remoteHwm).toBe(0n);
  });
});
