import { describe, expect, it, vi } from 'vitest';
import { FederationStateFeedHeadClient } from './federation-state-feed-head-client.service.js';

describe('FederationStateFeedHeadClient', () => {
  it('reads the current namespace head and sends one pooled HTTP request', async () => {
    const capturePeerResponseToken = vi.fn().mockResolvedValue({
      namespaceId: 7,
    });
    const readFeedEndId = vi.fn().mockResolvedValue(42n);
    const readFeedEndIdProfile = vi.fn().mockResolvedValue(9n);
    const post = vi.fn().mockResolvedValue(undefined);
    const client = new FederationStateFeedHeadClient(
      { capturePeerResponseToken } as never,
      { readFeedEndId } as never,
      { readFeedEndId: readFeedEndIdProfile } as never,
      { post } as never,
    );

    await client.send('peer.test');

    expect(readFeedEndId).toHaveBeenCalledWith(7);
    expect(readFeedEndIdProfile).toHaveBeenCalledWith();
    expect(post).toHaveBeenCalledWith(
      '/s2s/v1/feed-heads',
      JSON.stringify({
        stateFeedEndId: '42',
        profileNamespaceFeedEndId: '9',
      }),
      'peer.test',
    );
  });
});
