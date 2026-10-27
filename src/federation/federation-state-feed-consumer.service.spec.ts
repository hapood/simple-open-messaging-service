import { describe, expect, it, vi } from 'vitest';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';
import { ProfileLookup } from '../profile-resolution/profile-resolution-demand.js';

const tx = () => {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => [{ id: 42, account: 'local.user' }]),
  };
  return {
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(() => query),
  };
};

function createService(routed: string) {
  const receivedUserIntents = {
    applyInTx: vi.fn(async () => ({ routed })),
  };
  const service = new FederationStateFeedConsumerService(
    receivedUserIntents as never,
    {} as never,
    {} as never,
  );
  return { service, receivedUserIntents };
}

function intentItem(status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED') {
  const statusChangedAt = Date.now() - 60_000;
  const expiresAt = statusChangedAt + 24 * 60 * 60 * 1000;
  return {
    account: 'Remote.User',
    peerAccount: 'Local.User',
    eventType: 'RELATIONSHIP_INTENT' as const,
    feedId: '10',
    generatedAt: 1_700_000_000_000,
    body: {
      status,
      namespaceId: 7,
      profileRev: 12,
      note: '',
      statusChangedAt,
      expiresAt: status === 'REQUESTED' ? expiresAt : null,
      ...(status === 'REVOKED' ? {} : { messageEndSeq: 0, tombstoneEndSeq: 0 }),
    },
  };
}

describe('FederationStateFeedConsumerService relationship profile prefetch', () => {
  it.each([undefined, null, -1, 0.5, '1', NaN, Infinity, 2 ** 53])(
    'skips an invalid generation time (%s) without blocking a later item',
    async (generatedAt) => {
      const { service, receivedUserIntents } =
        createService('recorded-request');
      const invalid = {
        ...intentItem('REQUESTED'),
        generatedAt,
      };
      if (generatedAt === undefined) delete invalid.generatedAt;
      const valid = { ...intentItem('REQUESTED'), feedId: '11' };
      await service.applyPageInTx(tx() as never, 'remote.test', 5, {
        items: [invalid as never, valid],
        scannedThrough: '11',
        stateFeedEndId: '11',
        profileNamespaceFeedEndId: '0',
        hasMore: false,
      });
      expect(receivedUserIntents.applyInTx).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts future, decreasing, and zero generation times in feed order', async () => {
    const { service, receivedUserIntents } = createService('recorded-request');
    await service.applyPageInTx(tx() as never, 'remote.test', 5, {
      items: [Number.MAX_SAFE_INTEGER, 1, 0].map((generatedAt, index) => ({
        ...intentItem('REQUESTED'),
        feedId: String(index + 1),
        generatedAt,
      })),
      scannedThrough: '3',
      stateFeedEndId: '3',
      profileNamespaceFeedEndId: '0',
      hasMore: false,
    });
    expect(receivedUserIntents.applyInTx).toHaveBeenCalledTimes(3);
  });

  it.each(['REQUESTED', 'ACCEPTED', 'REVOKED'] as const)(
    'drops missing, null, and legacy transition times for %s without applying them',
    async (status) => {
      const item = intentItem(status);
      const { statusChangedAt, ...withoutTime } = item.body;
      const bodies = [
        withoutTime,
        { ...withoutTime, statusChangedAt: null },
        { ...withoutTime, requestedAt: statusChangedAt },
        { ...item.body, requestedAt: statusChangedAt },
      ];
      for (const body of bodies) {
        const { service, receivedUserIntents } =
          createService('recorded-request');
        await expect(
          service.applyPageInTx(tx() as never, 'remote.test', 5, {
            items: [{ ...item, body }],
            scannedThrough: '10',
            stateFeedEndId: '10',
            profileNamespaceFeedEndId: '0',
            hasMore: false,
          }),
        ).resolves.toMatchObject({
          clientFeedUpdates: [],
          profileDemands: [],
          threadRoundWakes: [],
        });
        expect(receivedUserIntents.applyInTx).not.toHaveBeenCalled();
      }
    },
  );
  it.each(['REQUESTED', 'ACCEPTED'] as const)(
    'prefetches the peer profile for %s intents while disclosure is live',
    async (status) => {
      const { service, receivedUserIntents } =
        createService('recorded-request');
      const db = tx();

      const result = await service.applyPageInTx(
        db as never,
        'remote.test',
        5,
        {
          items: [intentItem(status)],
          scannedThrough: '10',
          stateFeedEndId: '10',
          profileNamespaceFeedEndId: '0',
          hasMore: false,
        },
      );

      expect(receivedUserIntents.applyInTx).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          localUserId: 42,
          peer: {
            account: 'remote.user',
            domain: 'remote.test',
            namespaceId: 5,
          },
        }),
        expect.any(Array),
        expect.any(Set),
      );
      expect(result.profileDemands).toEqual([
        {
          publisherNamespaceId: 5,
          lookup: ProfileLookup.ACCOUNT_PROFILE,
          target: {
            profileNamespaceId: 7,
            account: 'remote.user',
            rev: 12,
          },
        },
      ]);
    },
  );

  it('does not prefetch after a REVOKED intent because remote disclosure is gone', async () => {
    const { service } = createService('kick');
    const db = tx();

    const result = await service.applyPageInTx(db as never, 'remote.test', 5, {
      items: [intentItem('REVOKED')],
      scannedThrough: '10',
      stateFeedEndId: '10',
      profileNamespaceFeedEndId: '0',
      hasMore: false,
    });

    expect(result.profileDemands).toEqual([]);
  });
});
