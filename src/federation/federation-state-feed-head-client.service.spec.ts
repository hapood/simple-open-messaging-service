import { describe, expect, it, vi } from 'vitest';
import { FederationStateFeedHeadClient } from './federation-state-feed-head-client.service.js';

describe('FederationStateFeedHeadClient', () => {
  it('sends only the snapshot; send time belongs to the HTTP signature', async () => {
    const capturePeerResponseToken = vi
      .fn()
      .mockResolvedValue({ namespaceId: 7 });
    const snapshot = {
      stateFeedEndId: '42',
      profileNamespaceFeedEndId: '9',
      generatedAt: 1000,
    };
    const execute = vi.fn().mockResolvedValue({ rows: [snapshot] });
    const post = vi.fn().mockResolvedValue(undefined);
    const client = new FederationStateFeedHeadClient(
      { capturePeerResponseToken } as never,
      { db: { execute } } as never,
      { post } as never,
    );
    await client.send('peer.test');
    expect(execute).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      '/s2s/v1/feed-heads',
      JSON.stringify(snapshot),
      'peer.test',
    );
    expect(JSON.parse(post.mock.calls[0][1])).toEqual(snapshot);
  });

  it('does not send a fabricated empty head for a missing namespace', async () => {
    const post = vi.fn();
    const client = new FederationStateFeedHeadClient(
      { capturePeerResponseToken: async () => ({ namespaceId: 7 }) } as never,
      { db: { execute: async () => ({ rows: [] }) } } as never,
      { post } as never,
    );
    await expect(client.send('peer.test')).rejects.toThrow(
      'namespace is missing',
    );
    expect(post).not.toHaveBeenCalled();
  });
});
