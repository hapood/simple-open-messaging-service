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
  const requestedAt = Date.now() - 60_000;
  const expiresAt = requestedAt + 24 * 60 * 60 * 1000;
  return {
    account: 'Remote.User',
    peerAccount: 'Local.User',
    eventType: 'RELATIONSHIP_INTENT' as const,
    feedId: '10',
    body: {
      status,
      namespaceId: 7,
      profileRev: 12,
      note: '',
      requestedAt: status === 'REVOKED' ? null : requestedAt,
      expiresAt: status === 'REQUESTED' ? expiresAt : null,
      ...(status === 'REVOKED'
        ? {}
        : { messageEndSeq: 0, tombstoneEndSeq: 0 }),
    },
  };
}

describe('FederationStateFeedConsumerService relationship profile prefetch', () => {
  it.each(['REQUESTED', 'ACCEPTED'] as const)(
    'prefetches the peer profile for %s intents while disclosure is live',
    async (status) => {
      const { service, receivedUserIntents } = createService('recorded-request');
      const db = tx();

      const result = await service.applyPageInTx(db as never, 'remote.test', 5, {
        items: [intentItem(status)],
        scannedThrough: '10',
        stateFeedEndId: '10',
        profileNamespaceFeedEndId: '0',
        hasMore: false,
      });

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
