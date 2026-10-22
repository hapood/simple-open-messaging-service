import { describe, expect, it, vi } from 'vitest';
import { FederationProfileNamespacePullService } from './federation-profile-namespace-pull.service.js';
import { Logger } from '@nestjs/common';
import type { ProfileNamespaceFeedPage } from './profile-namespace-feed.service.js';
import type { ProfileNamespaceItemEffect } from './profile-namespace-feed-consumer.service.js';

/** A page of one item carrying `namespaceId` at the given `feedId`. */
function page(
  namespaceId: number,
  feedId: string,
  feedEndId: string,
  opts: { scannedThrough?: string; hasMore?: boolean } = {},
): ProfileNamespaceFeedPage {
  return {
    items: [{ namespaceId, feedId }],
    scannedThrough: opts.scannedThrough ?? feedId,
    feedEndId,
    hasMore: opts.hasMore ?? false,
  };
}

/** Effect produced by the consumer inside the pull transaction. */
function effect(
  publisherNamespaceId: number,
  profileNamespaceId: number,
  feedId: bigint,
  expiredLocalRows: boolean,
  clientChangeId: bigint,
): ProfileNamespaceItemEffect {
  return {
    publisherNamespaceId,
    profileNamespaceId,
    triggerFeedId: feedId,
    expiredLocalRows,
    clientChangeId,
  };
}

/** Builds a stubbed pull service harness. `consumerEffect` is the value
 *  returned by the stubbed `consumer.applyItemInTx` inside the drain loop. */
function harness(
  opts: {
    namespaceId?: number;
    pulledThrough?: bigint;
    consumerEffect?: ProfileNamespaceItemEffect;
  } = {},
) {
  const namespaceId = opts.namespaceId ?? 7;
  const consumerEffect =
    opts.consumerEffect ?? effect(namespaceId, 5, 1n, false, 42n);
  const threadAccess = {
    capturePeerResponseToken: vi.fn().mockResolvedValue({ namespaceId }),
  };
  const feedPull = {
    advertise: vi.fn(),
    // The real engine invokes fetch/apply/afterCommit per page; the stub
    // drives one apply+afterCommit cycle so the orchestrator wiring is
    // exercised end to end.
    run: vi.fn(
      async (
        _domain: string,
        _namespaceId: number,
        callbacks: {
          apply: (
            tx: unknown,
            item: { namespaceId: number; feedId: string },
          ) => Promise<ProfileNamespaceItemEffect>;
          afterCommit?: (
            effect: ProfileNamespaceItemEffect,
          ) => Promise<void> | void;
        },
      ) => {
        const applied = await callbacks.apply({} as never, {
          namespaceId: 5,
          feedId: '1',
        });
        await callbacks.afterCommit?.(applied);
      },
    ),
  };
  const sse = { notifyProfileNamespaceChange: vi.fn() };
  const namespaceInfo = { scheduleRefresh: vi.fn() };
  const consumer = {
    applyItemInTx: vi.fn().mockResolvedValue(consumerEffect),
  };
  const observed = { profileNamespaceFeedEndId: 0n };
  const limit = vi
    .fn()
    .mockResolvedValue([{ pulledThrough: opts.pulledThrough ?? 1n }]);
  const database = {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
      update: vi.fn(() => ({
        set: (values: { profileNamespaceFeedEndId: unknown }) => ({
          where: () => ({
            returning: vi.fn(async () => {
              observed.profileNamespaceFeedEndId =
                values.profileNamespaceFeedEndId as bigint;
              return [{ pulledThrough: opts.pulledThrough ?? 1n }];
            }),
          }),
        }),
      })),
    },
  };
  const service = new FederationProfileNamespacePullService(
    database as never,
    {} as never, // peerHttp — unused in pullFromPeer/wake/wakeIfBehind
    {} as never, // trustedPeers — unused in pullFromPeer/wake/wakeIfBehind
    threadAccess as never,
    feedPull as never,
    consumer as never,
    sse as never,
    namespaceInfo as never,
  );
  return {
    service,
    threadAccess,
    feedPull,
    sse,
    namespaceInfo,
    consumer,
    database,
    limit,
    namespaceId,
  };
}

/** Flushes the fire-and-forget drain kicked off by `wake()`/`wakeIfBehind()`. */
function flushFireAndForget() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('FederationProfileNamespacePullService', () => {
  describe('pullFromPeer', () => {
    it('advertises the required end, drains, and returns the committed cursor', async () => {
      const { service, feedPull, threadAccess, namespaceId } = harness({
        pulledThrough: 3n,
      });
      const cursor = await service.pullFromPeer('peer.test', 3n);
      expect(threadAccess.capturePeerResponseToken).toHaveBeenCalledWith(
        'peer.test',
      );
      expect(feedPull.advertise).toHaveBeenCalledWith(
        'peer.test',
        namespaceId,
        3n,
      );
      expect(feedPull.run).toHaveBeenCalledOnce();
      expect(cursor).toBe(3n);
    });

    it('broadcasts the client change id via SSE after each commit', async () => {
      const { service, sse } = harness({
        consumerEffect: effect(7, 5, 1n, false, 42n),
      });
      await service.pullFromPeer('peer.test');
      expect(sse.notifyProfileNamespaceChange).toHaveBeenCalledWith(42n);
    });

    it('schedules a cache refresh only when the item expired local rows', async () => {
      const { service, namespaceInfo } = harness({
        consumerEffect: effect(7, 5, 1n, true, 10n),
      });
      await service.pullFromPeer('peer.test');
      expect(namespaceInfo.scheduleRefresh).toHaveBeenCalledOnce();
      expect(namespaceInfo.scheduleRefresh).toHaveBeenCalledWith(
        { publisherNamespaceId: 7, profileNamespaceId: 5 },
        1n,
      );
    });

    it('does not schedule a refresh when no local row expired', async () => {
      const { service, namespaceInfo } = harness({
        consumerEffect: effect(7, 5, 1n, false, 10n),
      });
      await service.pullFromPeer('peer.test');
      expect(namespaceInfo.scheduleRefresh).not.toHaveBeenCalled();
    });

    it('throws when the drain stops short of the required end', async () => {
      const { service, feedPull } = harness({ pulledThrough: 1n });
      feedPull.run.mockImplementationOnce(async () => undefined);
      await expect(service.pullFromPeer('peer.test', 5n)).rejects.toThrow(
        /stopped at 1 before required end 5/,
      );
    });
  });

  describe('wake', () => {
    it('starts a drain with the advertised end and swallows failures', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const { service, feedPull } = harness({ pulledThrough: 2n });
      feedPull.run.mockImplementationOnce(async () => {
        throw new Error('peer unreachable');
      });
      service.wake('peer.test', 2n);
      await flushFireAndForget();
      expect(feedPull.run).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('profile namespace pull failed for peer.test'),
      );
      warn.mockRestore();
    });
  });

  describe('wakeIfBehind', () => {
    it('wakes the drain when the observed end is ahead of the cursor', async () => {
      const { service, feedPull } = harness({ pulledThrough: 1n });
      feedPull.run.mockImplementation(async () => undefined);
      await service.wakeIfBehind('peer.test', 5n);
      await flushFireAndForget();
      expect(feedPull.run).toHaveBeenCalledOnce();
    });

    it('does not wake when the cursor is already at the observed end', async () => {
      const { service, feedPull } = harness({ pulledThrough: 5n });
      await service.wakeIfBehind('peer.test', 5n);
      await flushFireAndForget();
      expect(feedPull.run).not.toHaveBeenCalled();
    });

    it('does not wake when the cursor is ahead of the observed end', async () => {
      const { service, feedPull } = harness({ pulledThrough: 9n });
      await service.wakeIfBehind('peer.test', 5n);
      await flushFireAndForget();
      expect(feedPull.run).not.toHaveBeenCalled();
    });
  });

  describe('pullFeedPage URL construction', () => {
    function urlHarness() {
      const captured: string[] = [];
      const trustedPeers = {
        run: vi.fn(async (_domain: string, fn: () => Promise<unknown>) => fn()),
      };
      const peerHttp = {
        get: vi.fn(async (path: string) => {
          captured.push(path);
          return page(5, '1', '1');
        }),
      };
      const service = new FederationProfileNamespacePullService(
        {
          db: {
            select: () => ({
              from: () => ({
                where: () => ({
                  limit: vi
                    .fn()
                    .mockResolvedValue([
                      { profileNamespaceFeedPulledThrough: 0n },
                    ]),
                }),
              }),
            }),
          },
        } as never,
        peerHttp as never,
        trustedPeers as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      return { service, captured };
    }

    it('builds the bare feed path with no cursor parameters', async () => {
      const { service, captured } = urlHarness();
      const result = await service.pullFeedPage('peer.test');
      expect(captured[0]).toBe('/s2s/v1/profile-namespace-feed');
      expect(result.feedEndId).toBe('1');
    });

    it('appends after, take, and through query parameters', async () => {
      const { service, captured } = urlHarness();
      await service.pullFeedPage('peer.test', 2n, 100, 5n);
      expect(captured[0]).toBe(
        '/s2s/v1/profile-namespace-feed?after=2&take=100&through=5',
      );
    });

    it('accepts after alone', async () => {
      const { service, captured } = urlHarness();
      await service.pullFeedPage('peer.test', 2n);
      expect(captured[0]).toBe('/s2s/v1/profile-namespace-feed?after=2');
    });

    it('rejects take without after', async () => {
      const { service } = urlHarness();
      await expect(
        service.pullFeedPage('peer.test', undefined, 100),
      ).rejects.toThrow('invalid profile namespace feed cursor/page size');
    });

    it('rejects through without after', async () => {
      const { service } = urlHarness();
      await expect(
        service.pullFeedPage('peer.test', undefined, undefined, 5n),
      ).rejects.toThrow('invalid profile namespace feed cursor/page size');
    });

    it('rejects a negative after', async () => {
      const { service } = urlHarness();
      await expect(service.pullFeedPage('peer.test', -1n)).rejects.toThrow(
        'invalid profile namespace feed cursor/page size',
      );
    });

    it('rejects a through below after', async () => {
      const { service } = urlHarness();
      await expect(
        service.pullFeedPage('peer.test', 5n, undefined, 2n),
      ).rejects.toThrow('invalid profile namespace feed cursor/page size');
    });

    it('rejects an out-of-range take', async () => {
      const { service } = urlHarness();
      await expect(service.pullFeedPage('peer.test', 1n, 0)).rejects.toThrow(
        'invalid profile namespace feed cursor/page size',
      );
      await expect(service.pullFeedPage('peer.test', 1n, 201)).rejects.toThrow(
        'invalid profile namespace feed cursor/page size',
      );
    });
  });
});
