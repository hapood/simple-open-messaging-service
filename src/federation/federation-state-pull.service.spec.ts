import { describe, expect, it, vi } from 'vitest';
import { FederationStatePullService } from './federation-state-pull.service.js';

describe('FederationStatePullService drain window', () => {
  it('passes the pull worker fixed drain bound to state-feed pages', async () => {
    const page = {
      items: [],
      scannedThrough: '5',
      stateFeedEndId: '5',
      hasMore: false,
    };
    const peerHttp = { get: vi.fn().mockResolvedValue(page) };
    const stateFeedPull = {
      advertise: vi.fn(),
      run: vi.fn(
        async (
          _domain: string,
          _namespaceId: number,
          callbacks: {
            fetch: (after?: bigint, through?: bigint) => Promise<unknown>;
          },
        ) => {
          await callbacks.fetch(2n, 5n);
        },
      ),
    };
    const service = new FederationStatePullService(
      {
        db: {
          query: {
            peerStateFeedPullCursor: {
              findFirst: vi.fn().mockResolvedValue({ committedThrough: 5n }),
            },
          },
        },
      } as never,
      peerHttp as never,
      { run: vi.fn((_domain, operation) => operation()) } as never,
      {
        capturePeerResponseToken: vi.fn().mockResolvedValue({
          domain: 'peer.test',
          namespaceId: 7,
          rootKeyFingerprint: 'root',
        }),
      } as never,
      {} as never,
      stateFeedPull as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.pullStateFromPeer('peer.test', 5n)).resolves.toBe(5n);

    expect(peerHttp.get).toHaveBeenCalledWith(
      '/s2s/v1/state-feed?after=2&take=100&through=5',
      'peer.test',
      16 * 1024 * 1024,
    );
  });
});
