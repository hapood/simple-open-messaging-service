import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../database/database.service.js';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';

const page: PeerStateFeedPage = {
  items: [
    {
      account: '!group',
      eventType: 'GROUP_META_FEED_HEAD',
      feedId: '12',
      body: { groupMetaFeedEndId: '40' },
    },
  ],
  scannedThrough: '12',
  stateFeedEndId: '12',
  hasMore: false,
};

function harness(
  dependency:
    | { ready: true; committedThrough: bigint }
    | { ready: false; taskId: bigint },
) {
  const ensureInTx = vi.fn().mockResolvedValue(dependency);
  const service = Object.create(
    FederationStateFeedConsumerService.prototype,
  ) as FederationStateFeedConsumerService & Record<string, unknown>;
  Object.assign(service, {
    config: { domain: 'local.test' },
    logger: { error: vi.fn() },
    groupMetaTasks: { ensureInTx },
  });
  const limit = vi.fn().mockResolvedValue([{ groupId: 8 }]);
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit })),
      })),
    })),
  } as unknown as DatabaseTransaction;
  return { service, tx, ensureInTx };
}

describe('State Feed Group Meta scheduling', () => {
  it('creates or merges the durable task and completes the current item', async () => {
    const h = harness({ ready: false, taskId: 50n });

    await expect(
      h.service.applyPageInTx(h.tx, 'peer.test', 3, page),
    ).resolves.toEqual({
      clientFeedUpdates: [],
      statePushDomains: [],
      localSystemMessages: [],
      threadRoundWakes: [],
      profileResolutions: [],
    });

    expect(h.ensureInTx).toHaveBeenCalledWith(h.tx, {
      groupId: 8,
      groupAccount: '!group',
      peerDomain: 'peer.test',
      namespaceId: 3,
      through: 40n,
    });
  });

  it('does not duplicate completed task projection in the State Feed transaction', async () => {
    const h = harness({ ready: true, committedThrough: 40n });

    await expect(
      h.service.applyPageInTx(h.tx, 'peer.test', 3, page),
    ).resolves.toEqual({
      clientFeedUpdates: [],
      statePushDomains: [],
      localSystemMessages: [],
      threadRoundWakes: [],
      profileResolutions: [],
    });

    expect(h.ensureInTx).toHaveBeenCalledOnce();
  });
});
