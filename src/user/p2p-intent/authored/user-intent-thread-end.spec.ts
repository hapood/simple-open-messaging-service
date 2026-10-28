import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../../../database/database.service.js';
import { ClientStateFeedService } from '../../../client-state-feed/client-state-feed.service.js';
import { PeerStateFeedService } from '../../../federation/peer-state-feed.service.js';
import { FederationNamespaceService } from '../../../federation/federation-namespace.service.js';
import { FederationStateFeedPushService } from '../../../federation/federation-state-feed-push.service.js';
import { UserIntentService } from './user-intent.service.js';
import type { ActivePeerByThreadRow } from './user-intent-thread-end-sql.js';

const activePair: ActivePeerByThreadRow = {
  actorAccount: 'alice',
  endpointAAccount: 'alice',
  endpointANamespaceId: 0,
  endpointBAccount: 'bob',
  endpointBNamespaceId: 0,
  pairActive: true,
  authorizationEpoch: 7,
};

/** The locator and transaction delegation are tested here. Actual state changes
 * and the post-lock epoch fence still require PostgreSQL-backed coverage. */
async function fixture(row: ActivePeerByThreadRow | undefined) {
  const tx = { execute: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) };
  const module = await Test.createTestingModule({
    providers: [
      {
        provide: DatabaseService,
        useValue: {
          db: {
            transaction: async <T>(work: (value: typeof tx) => Promise<T>) =>
              work(tx),
          },
        },
      },
      {
        provide: ClientStateFeedService,
        useValue: { notifyFeedUpdates: vi.fn() },
      },
      { provide: PeerStateFeedService, useValue: {} },
      { provide: FederationNamespaceService, useValue: {} },
      {
        provide: FederationStateFeedPushService,
        useValue: { pushStateFeedNamespaces: vi.fn() },
      },
      {
        provide: UserIntentService,
        inject: [
          DatabaseService,
          ClientStateFeedService,
          PeerStateFeedService,
          FederationStateFeedPushService,
          FederationNamespaceService,
        ],
        useFactory: (
          database: DatabaseService,
          clientFeed: ClientStateFeedService,
          peerFeed: PeerStateFeedService,
          federation: FederationStateFeedPushService,
          namespaces: FederationNamespaceService,
        ) =>
          new UserIntentService(
            database,
            clientFeed,
            peerFeed,
            federation,
            namespaces,
            {} as never,
            { tick: vi.fn().mockResolvedValue(undefined) } as never,
          ),
      },
    ],
  }).compile();
  const service = module.get(UserIntentService);
  const executeInTx = vi.spyOn(service, 'executeInTx').mockResolvedValue({
    outcome: { status: 'APPLIED' },
    peers: new Map(),
  });
  return { module, service, executeInTx, tx };
}

describe('thread-keyed established relationship revocation', () => {
  it.each([
    undefined,
    { ...activePair, pairActive: false },
    { ...activePair, actorAccount: 'stranger' },
    { ...activePair, actorAccount: 'bob', endpointBNamespaceId: 8 },
  ])('rejects a missing, inactive or non-owned relationship', async (row) => {
    const f = await fixture(row);
    try {
      expect(
        await f.service.endEstablishedRelationship({ userId: 1, threadId: 12 }),
      ).toMatchObject({ status: 'REJECTED', reason: 'INTENT_NOT_FOUND' });
      expect(f.executeInTx).not.toHaveBeenCalled();
    } finally {
      await f.module.close();
    }
  });

  it.each([
    { row: activePair, target: { account: 'bob', namespaceId: 0 } },
    {
      row: { ...activePair, actorAccount: 'bob' },
      target: { account: 'alice', namespaceId: 0 },
    },
    {
      row: { ...activePair, endpointBNamespaceId: 8 },
      target: { account: 'bob', namespaceId: 8 },
    },
  ])(
    'delegates the exact peer and captured thread/epoch fence',
    async ({ row, target }) => {
      const f = await fixture(row);
      try {
        expect(
          await f.service.endEstablishedRelationship({
            userId: 1,
            threadId: 12,
          }),
        ).toEqual({ status: 'APPLIED' });
        expect(f.executeInTx).toHaveBeenCalledExactlyOnceWith(
          f.tx,
          { userId: 1, decision: 'REVOKED', target },
          [],
          {
            admissionInTx: expect.any(Function),
            establishedRelationship: { threadId: 12, epoch: 7 },
          },
        );
      } finally {
        await f.module.close();
      }
    },
  );
});
