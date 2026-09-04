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
      stateFeedPull as never,
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

  it('offers client feed updates to the throttler after each committed state item', async () => {
    const notifyFeedUpdates = vi.fn();
    const stateFeedPull = {
      advertise: vi.fn(),
      run: vi.fn(
        async (
          _domain: string,
          _namespaceId: number,
          callbacks: {
            apply: (tx: unknown, page: unknown) => Promise<void>;
            afterCommit: (page: unknown) => Promise<void>;
          },
        ) => {
          const first = {
            items: [{ feedId: '1' }],
            scannedThrough: '1',
            stateFeedEndId: '2',
            hasMore: true,
          };
          const second = {
            items: [{ feedId: '2' }],
            scannedThrough: '2',
            stateFeedEndId: '2',
            hasMore: false,
          };
          await callbacks.apply({}, first);
          await callbacks.afterCommit(first);
          await callbacks.apply({}, second);
          await callbacks.afterCommit(second);
        },
      ),
    };
    const applyPageInTx = vi
      .fn()
      .mockResolvedValueOnce({
        clientFeedUpdates: [{ userId: 3, feedId: 7 }],
        statePushDomains: [],
        localSystemMessages: [],
        threadRoundWakes: [],
        profileResolutions: [],
      })
      .mockResolvedValueOnce({
        clientFeedUpdates: [{ userId: 3, feedId: 8 }],
        statePushDomains: [],
        localSystemMessages: [],
        threadRoundWakes: [],
        profileResolutions: [],
      });
    const service = new FederationStatePullService(
      {
        db: {
          query: {
            peerStateFeedPullCursor: {
              findFirst: vi.fn().mockResolvedValue({ committedThrough: 2n }),
            },
          },
        },
      } as never,
      {} as never,
      {} as never,
      {
        capturePeerResponseToken: vi.fn().mockResolvedValue({
          domain: 'peer.test',
          namespaceId: 7,
          rootKeyFingerprint: 'root',
        }),
      } as never,
      stateFeedPull as never,
      { applyPageInTx } as never,
      { notifyFeedUpdates } as never,
      {} as never,
      {} as never,
      { emit: vi.fn() } as never,
    );

    await service.pullStateFromPeer('peer.test');

    expect(notifyFeedUpdates).toHaveBeenNthCalledWith(1, [
      { userId: 3, feedId: 7 },
    ]);
    expect(notifyFeedUpdates).toHaveBeenNthCalledWith(2, [
      { userId: 3, feedId: 8 },
    ]);
  });
});
