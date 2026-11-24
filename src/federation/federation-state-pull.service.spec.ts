import { describe, expect, it, vi } from 'vitest';
import { FederationStatePullService } from './federation-state-pull.service.js';
import { Logger } from '@nestjs/common';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

describe('FederationStatePullService drain window', () => {
  it.each([true, false])(
    'keeps post-commit profile failure isolated (unavailable=%s)',
    async (unavailable) => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const failure = unavailable
        ? new BusinessException(
            BusinessCode.NOT_FOUND,
            'profile is not available',
          )
        : new Error('database unavailable');
      const resolveDemand = vi.fn().mockRejectedValue(failure);
      const demand = {
        publisherNamespaceId: 7,
        lookup: 'ACCOUNT_PROFILE' as const,
        target: { profileNamespaceId: 7, account: 'alice', rev: 2 },
      };
      const effect = {
        clientFeedUpdates: [],
        statePushNamespaces: [],
        localSystemMessages: [],
        threadRoundWakes: [],
        profileDemands: [demand],
      };
      const service = new FederationStatePullService(
        {
          db: {
            select: () => ({
              from: () => ({
                where: () => ({
                  limit: vi.fn().mockResolvedValue([{ pulledThrough: 2n }]),
                }),
              }),
            }),
          },
        } as never,
        {} as never,
        {} as never,
        {
          captureActiveById: vi.fn().mockResolvedValue({
            domain: 'peer.test',
            namespaceId: 7,
            peerAssignedLocalNamespaceId: 1,
            rootPublicKey: 'root-public-key',
          }),
        } as never,
        {
          advertise: vi.fn(),
          run: async (
            namespace: number,
            signal: AbortSignal,
            callbacks: {
              apply: (tx: unknown, page: unknown) => Promise<void>;
              afterCommit: (page: unknown) => Promise<void>;
            },
          ) => {
            const page = { items: [] };
            await callbacks.apply({}, page);
            await callbacks.afterCommit(page);
          },
        } as never,
        { applyPageInTx: vi.fn().mockResolvedValue(effect) } as never,
        { notifyFeedUpdates: vi.fn() } as never,
        {} as never,
        { resolveDemand } as never,
        {} as never,
        { emit: vi.fn() } as never,
        {
          assertCanConsumeState: vi.fn().mockResolvedValue(undefined),
          tickLax: vi.fn().mockResolvedValue(undefined),
        } as never,
      );
      try {
        await expect(
          service.pullStateFromPeer(7, 2n, new AbortController().signal),
        ).resolves.toBe(2n);
        expect(resolveDemand).toHaveBeenCalledWith(demand);
        expect(warn).toHaveBeenCalledTimes(unavailable ? 0 : 1);
      } finally {
        warn.mockRestore();
      }
    },
  );
  it('passes the pull worker fixed drain bound to state-feed pages', async () => {
    const page = {
      items: [],
      scannedThrough: '5',
      stateFeedEndId: '5',
      profileNamespaceFeedEndId: '0',
      hasMore: false,
    };
    const peerHttp = { get: vi.fn().mockResolvedValue(page) };
    const stateFeedPull = {
      advertise: vi.fn(),
      run: vi.fn(
        async (
          namespaceId: number,
          signal: AbortSignal,
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
          select: () => ({
            from: () => ({
              where: () => ({
                limit: vi.fn().mockResolvedValue([{ pulledThrough: 5n }]),
              }),
            }),
          }),
        },
      } as never,
      peerHttp as never,
      { run: vi.fn((namespaceId, operation) => operation()) } as never,
      {
        captureActiveById: vi.fn().mockResolvedValue({
          domain: 'peer.test',
          namespaceId: 7,
          peerAssignedLocalNamespaceId: 1,
          rootPublicKey: 'root-public-key',
        }),
      } as never,
      stateFeedPull as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        assertCanConsumeState: vi.fn().mockResolvedValue(undefined),
        tickLax: vi.fn().mockResolvedValue(undefined),
      } as never,
    );

    await expect(
      service.pullStateFromPeer(7, 5n, new AbortController().signal),
    ).resolves.toBe(5n);

    expect(peerHttp.get).toHaveBeenCalledWith(
      '/somfp/v1/state-feed?after=2&take=100&through=5',
      'peer.test',
      16 * 1024 * 1024,
      expect.any(AbortSignal),
    );
  });

  it('offers client feed updates to the throttler after each committed state item', async () => {
    const notifyFeedUpdates = vi.fn();
    const stateFeedPull = {
      advertise: vi.fn(),
      run: vi.fn(
        async (
          namespaceId: number,
          signal: AbortSignal,
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
        statePushNamespaces: [],
        localSystemMessages: [],
        threadRoundWakes: [],
        profileDemands: [],
      })
      .mockResolvedValueOnce({
        clientFeedUpdates: [{ userId: 3, feedId: 8 }],
        statePushNamespaces: [],
        localSystemMessages: [],
        threadRoundWakes: [],
        profileDemands: [],
      });
    const service = new FederationStatePullService(
      {
        db: {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: vi.fn().mockResolvedValue([{ pulledThrough: 2n }]),
              }),
            }),
          }),
        },
      } as never,
      {} as never,
      {} as never,
      {
        captureActiveById: vi.fn().mockResolvedValue({
          domain: 'peer.test',
          namespaceId: 7,
          peerAssignedLocalNamespaceId: 1,
          rootPublicKey: 'root-public-key',
        }),
      } as never,
      stateFeedPull as never,
      { applyPageInTx } as never,
      { notifyFeedUpdates } as never,
      {} as never,
      {} as never,
      {} as never,
      { emit: vi.fn() } as never,
      {
        assertCanConsumeState: vi.fn().mockResolvedValue(undefined),
        tickLax: vi.fn().mockResolvedValue(undefined),
      } as never,
    );

    await service.pullStateFromPeer(7, 2n, new AbortController().signal);

    expect(notifyFeedUpdates).toHaveBeenNthCalledWith(1, [
      { userId: 3, feedId: 7 },
    ]);
    expect(notifyFeedUpdates).toHaveBeenNthCalledWith(2, [
      { userId: 3, feedId: 8 },
    ]);
  });
});
