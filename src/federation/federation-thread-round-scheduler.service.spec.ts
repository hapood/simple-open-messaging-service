import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationThreadRoundRemoteError } from './federation-thread-round-error.js';
import { FederationThreadRoundSchedulerService } from './federation-thread-round-scheduler.service.js';

function source(threadId: number) {
  return {
    kind: 'GROUP' as const,
    threadId,
    peerDomain: threadId === 2 ? 'b.test' : 'a.test',
    selector: { account: `!group-${threadId}` },
  };
}

function harness() {
  const databaseState = {
    active: true,
    ownerDomain: 'a.test',
    startupRows: [] as Array<Record<string, unknown>>,
  };
  const states = {
    require: vi.fn().mockResolvedValue({
      messageTargetSeq: 10,
      deletionTargetSeq: 0,
      messageProcessedThroughSeq: 10,
      deletionProcessedThroughSeq: 0,
      historyBoundaryReached: true,
    }),
  };
  const sources = { resolve: vi.fn((threadId: number) => source(threadId)) };
  const forward = {
    runMessages: vi.fn().mockResolvedValue(undefined),
    runTombstones: vi.fn().mockResolvedValue(undefined),
  };
  const reverse = {
    run: vi.fn().mockResolvedValue(undefined),
  };
  const database = {
    db: {
      select: vi.fn((shape: Record<string, unknown>) => {
        const result =
          'threadId' in shape
            ? databaseState.startupRows
            : 'domain' in shape
              ? databaseState.active
                ? [{ domain: 'a.test' }]
                : []
              : [
                  {
                    peerDomain: databaseState.ownerDomain,
                    namespaceId: 7,
                  },
                ];
        const query = {
          from: vi.fn(() => query),
          innerJoin: vi.fn(() => query),
          where: vi.fn(() => query),
          limit: vi.fn().mockResolvedValue(result),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(result).then(resolve),
        };
        return query;
      }),
    },
  };
  const federation = {
    listTrustedPeerDomains: vi.fn().mockResolvedValue([]),
    pullStateFromPeer: vi.fn().mockResolvedValue(0n),
    handleThreadQueryForbidden: vi.fn().mockResolvedValue('P2P_REVOKED'),
  };
  const scheduler = new FederationThreadRoundSchedulerService(
    database as never,
    states as never,
    forward as never,
    reverse as never,
    federation as never,
    sources as never,
  );
  return {
    scheduler,
    states,
    sources,
    forward,
    reverse,
    database,
    databaseState,
    federation,
  };
}

describe('FederationThreadRoundSchedulerService', () => {
  it('discards a stale wake after thread ownership changes', async () => {
    const { scheduler, forward, databaseState } = harness();
    databaseState.ownerDomain = 'b.test';

    await expect(
      scheduler.wake(1, 'a.test', 'message'),
    ).resolves.toBeUndefined();
    expect(forward.runMessages).not.toHaveBeenCalled();
    await scheduler.onModuleDestroy();
  });

  it('coalesces a wake received while the same direction is active', async () => {
    const { scheduler, forward } = harness();
    let release!: () => void;
    forward.runMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );

    await scheduler.wake(1, 'a.test', 'message');
    await vi.waitFor(() => expect(forward.runMessages).toHaveBeenCalledOnce());
    await scheduler.wake(1, 'a.test', 'message');
    expect(forward.runMessages).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() =>
      expect(forward.runMessages).toHaveBeenCalledTimes(2),
    );
    await scheduler.onModuleDestroy();
  });

  it('runs message and tombstone single-flights independently for one thread', async () => {
    const { scheduler, forward } = harness();
    let releaseMessage!: () => void;
    let releaseTombstone!: () => void;
    forward.runMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseMessage = () => resolve(undefined);
        }),
    );
    forward.runTombstones.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseTombstone = () => resolve(undefined);
        }),
    );

    scheduler.onWake({
      threadId: 1,
      peerDomain: 'a.test',
      namespaceId: 7,
      direction: 'forward',
    });

    await vi.waitFor(() => {
      expect(forward.runMessages).toHaveBeenCalledOnce();
      expect(forward.runTombstones).toHaveBeenCalledWith(1, 'a.test', 7, 50);
    });
    releaseMessage();
    releaseTombstone();
    await scheduler.onModuleDestroy();
  });

  it('coalesces new tombstone work while the durable round is active', async () => {
    const { scheduler, states, forward } = harness();
    states.require.mockResolvedValue({
      messageTargetSeq: 20,
      deletionTargetSeq: 12,
      messageProcessedThroughSeq: 20,
      deletionProcessedThroughSeq: 12,
      historyBoundaryReached: true,
    });
    let releaseFirst!: () => void;
    forward.runTombstones
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(undefined);
          }),
      )
      .mockResolvedValueOnce(undefined);

    scheduler.onWake({
      threadId: 1,
      peerDomain: 'a.test',
      namespaceId: 7,
      direction: 'forward',
    });
    await vi.waitFor(() =>
      expect(forward.runTombstones).toHaveBeenCalledWith(1, 'a.test', 7, 50),
    );

    scheduler.onWake({
      threadId: 1,
      peerDomain: 'a.test',
      namespaceId: 7,
      direction: 'forward',
    });
    scheduler.onWake({
      threadId: 1,
      peerDomain: 'a.test',
      namespaceId: 7,
      direction: 'forward',
    });
    expect(forward.runTombstones).toHaveBeenCalledOnce();
    releaseFirst();

    await vi.waitFor(() =>
      expect(forward.runTombstones).toHaveBeenNthCalledWith(
        2,
        1,
        'a.test',
        7,
        50,
      ),
    );
    await scheduler.onModuleDestroy();
  });

  it('rotates peers after each one-round quantum', async () => {
    const { scheduler, forward } = harness();
    (
      scheduler as unknown as {
        limits: { message: number; tombstone: number; reverse: number };
      }
    ).limits.message = 1;
    const order: number[] = [];
    let releaseFirst!: () => void;
    forward.runMessages.mockImplementation(async (threadId: number) => {
      order.push(threadId);
      if (threadId === 1 && order.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return undefined;
    });

    scheduler.onWake({
      threadId: 1,
      peerDomain: 'a.test',
      namespaceId: 7,
      direction: 'forward',
    });
    scheduler.onWake({
      threadId: 3,
      peerDomain: 'a.test',
      namespaceId: 7,
      direction: 'forward',
    });
    scheduler.onWake({
      threadId: 2,
      peerDomain: 'b.test',
      namespaceId: 7,
      direction: 'forward',
    });
    await vi.waitFor(() => expect(order).toEqual([1]));
    releaseFirst();
    await vi.waitFor(() => expect(order).toEqual([1, 2, 3]));
    await scheduler.onModuleDestroy();
  });

  it('continues reverse batches until durable history is closed', async () => {
    const { scheduler, states, reverse } = harness();
    states.require
      .mockResolvedValueOnce({
        historyBoundaryReached: false,
        messageTargetSeq: 10,
        deletionTargetSeq: 0,
        messageProcessedThroughSeq: 10,
        deletionProcessedThroughSeq: 0,
      })
      .mockResolvedValue({
        historyBoundaryReached: true,
        messageTargetSeq: 10,
        deletionTargetSeq: 0,
        messageProcessedThroughSeq: 10,
        deletionProcessedThroughSeq: 0,
      });

    await scheduler.wake(1, 'a.test', 'reverse');
    await vi.waitFor(() => expect(reverse.run).toHaveBeenCalledTimes(2));
    await scheduler.onModuleDestroy();
  });

  it('continues a captured namespace across scheduler quanta', async () => {
    const { scheduler, states, forward, databaseState } = harness();
    databaseState.ownerDomain = 'b.test';
    states.require
      .mockResolvedValueOnce({
        historyBoundaryReached: true,
        messageTargetSeq: 10,
        deletionTargetSeq: 0,
        messageProcessedThroughSeq: 9,
        deletionProcessedThroughSeq: 0,
      })
      .mockResolvedValue({
        historyBoundaryReached: true,
        messageTargetSeq: 10,
        deletionTargetSeq: 0,
        messageProcessedThroughSeq: 10,
        deletionProcessedThroughSeq: 0,
      });

    scheduler.onWake({
      threadId: 1,
      peerDomain: 'a.test',
      namespaceId: 7,
      direction: 'forward',
    });

    await vi.waitFor(() =>
      expect(forward.runMessages).toHaveBeenCalledTimes(2),
    );
    await scheduler.onModuleDestroy();
  });

  it('restarts a failed network round from durable state after backoff', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, forward, states } = harness();
      forward.runMessages
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockResolvedValueOnce(undefined);

      await scheduler.wake(1, 'a.test', 'message');
      await vi.advanceTimersByTimeAsync(0);
      expect(forward.runMessages).toHaveBeenCalledOnce();
      expect(states.require).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(forward.runMessages).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() =>
        expect(forward.runMessages).toHaveBeenCalledTimes(2),
      );
      expect(states.require).toHaveBeenCalledOnce();
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards a network retry when the namespace is already inactive', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, forward, databaseState } = harness();
      databaseState.active = false;
      forward.runMessages.mockRejectedValueOnce(
        new Error('network unavailable'),
      );

      await scheduler.wake(1, 'a.test', 'message');
      await vi.advanceTimersByTimeAsync(60_000);

      expect(forward.runMessages).toHaveBeenCalledOnce();
      scheduler.onWake({
        threadId: 1,
        peerDomain: 'a.test',
        namespaceId: 7,
        direction: 'forward',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(forward.runMessages).toHaveBeenCalledOnce();
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks namespace activity immediately before a delayed retry', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, forward, databaseState } = harness();
      forward.runMessages.mockRejectedValueOnce(
        new Error('network unavailable'),
      );

      await scheduler.wake(1, 'a.test', 'message');
      await vi.advanceTimersByTimeAsync(0);
      expect(forward.runMessages).toHaveBeenCalledOnce();

      databaseState.active = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(forward.runMessages).toHaveBeenCalledOnce();
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a permanent thread-query business error', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, forward } = harness();
      forward.runMessages.mockRejectedValueOnce(
        new FederationThreadRoundRemoteError(
          new S2sResponseError(
            'malformed response',
            400,
            BusinessCode.FEDERATION_MALFORMED,
          ),
          7,
        ),
      );

      await scheduler.wake(1, 'a.test', 'message');
      await vi.advanceTimersByTimeAsync(0);
      expect(forward.runMessages).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(forward.runMessages).toHaveBeenCalledOnce();
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors retryAfter for a retryable query business result', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { scheduler, forward } = harness();
      forward.runMessages
        .mockRejectedValueOnce(
          new FederationThreadRoundRemoteError(
            new S2sResponseError(
              'query throttled',
              200,
              BusinessCode.FEDERATION_MESSAGE_QUERY_RATE_LIMITED,
              { retryAfter: 3 },
            ),
            7,
          ),
        )
        .mockResolvedValueOnce(undefined);

      await scheduler.wake(1, 'a.test', 'message');
      await vi.advanceTimersByTimeAsync(2_999);
      expect(forward.runMessages).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() =>
        expect(forward.runMessages).toHaveBeenCalledTimes(2),
      );
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an HTTP server failure from durable state', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler, forward, states } = harness();
      forward.runTombstones
        .mockRejectedValueOnce(
          new FederationThreadRoundRemoteError(
            new S2sResponseError('peer unavailable', 503),
            7,
          ),
        )
        .mockResolvedValueOnce(undefined);

      await scheduler.wake(1, 'a.test', 'tombstone');
      await vi.advanceTimersByTimeAsync(0);
      expect(forward.runTombstones).toHaveBeenCalledOnce();
      expect(states.require).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() =>
        expect(forward.runTombstones).toHaveBeenCalledTimes(2),
      );
      expect(states.require).toHaveBeenCalledOnce();
      await scheduler.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops every direction on FORBIDDEN and reopens only after a new thread wake', async () => {
    const { scheduler, forward, federation } = harness();
    forward.runMessages
      .mockRejectedValueOnce(
        new FederationThreadRoundRemoteError(
          new S2sResponseError('forbidden', 200, BusinessCode.FORBIDDEN),
          7,
        ),
      )
      .mockResolvedValue(undefined);

    await scheduler.wake(1, 'a.test', 'message');
    await vi.waitFor(() =>
      expect(federation.handleThreadQueryForbidden).toHaveBeenCalledWith(
        1,
        'a.test',
        7,
        7,
      ),
    );
    await scheduler.wake(1, 'a.test', 'message');
    expect(forward.runMessages).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(federation.pullStateFromPeer).toHaveBeenCalledWith('a.test', 0n),
    );

    scheduler.onWake({
      threadId: 1,
      peerDomain: 'a.test',
      namespaceId: 7,
      direction: 'forward',
    });
    await vi.waitFor(() =>
      expect(forward.runMessages).toHaveBeenCalledTimes(2),
    );
    await scheduler.onModuleDestroy();
  });

  it('immediately restarts stale FORBIDDEN work without blocking the thread', async () => {
    const { scheduler, forward, federation } = harness();
    federation.handleThreadQueryForbidden.mockResolvedValueOnce('STALE');
    forward.runMessages
      .mockRejectedValueOnce(
        new FederationThreadRoundRemoteError(
          new S2sResponseError('forbidden', 200, BusinessCode.FORBIDDEN),
          7,
        ),
      )
      .mockResolvedValueOnce(undefined);

    await scheduler.wake(1, 'a.test', 'message');
    await vi.waitFor(() =>
      expect(forward.runMessages).toHaveBeenCalledTimes(2),
    );
    expect(federation.pullStateFromPeer).toHaveBeenCalledWith('a.test', 0n);
    await scheduler.onModuleDestroy();
  });

  it('reconstructs independent message, tombstone, and reverse work at startup', async () => {
    const { scheduler, databaseState, forward, reverse } = harness();
    databaseState.startupRows = [
      {
        threadId: 1,
        peerDomain: 'a.test',
        namespaceId: 7,
        messageTargetSeq: 12,
        deletionTargetSeq: 4,
        messageProcessedThroughSeq: 10,
        deletionProcessedThroughSeq: 2,
        historyBoundaryReached: false,
      },
    ];

    await scheduler.onApplicationBootstrap();
    await vi.waitFor(() => {
      expect(forward.runMessages).toHaveBeenCalledOnce();
      expect(forward.runTombstones).toHaveBeenCalledWith(1, 'a.test', 7, 50);
      expect(reverse.run).toHaveBeenCalledOnce();
    });
    await scheduler.onModuleDestroy();
  });

  it('single-flights a peer state drain and follows with the greatest dirty target', async () => {
    const { scheduler, federation } = harness();
    let release!: () => void;
    federation.pullStateFromPeer
      .mockImplementationOnce(
        () =>
          new Promise<bigint>((resolve) => {
            release = () => resolve(7n);
          }),
      )
      .mockResolvedValueOnce(11n);

    scheduler.wakeStateFeed('a.test', 7n);
    await vi.waitFor(() =>
      expect(federation.pullStateFromPeer).toHaveBeenCalledOnce(),
    );
    scheduler.wakeStateFeed('a.test', 11n);
    scheduler.wakeStateFeed('a.test', 5n);
    expect(federation.pullStateFromPeer).toHaveBeenCalledOnce();

    release();
    await vi.waitFor(() =>
      expect(federation.pullStateFromPeer).toHaveBeenCalledTimes(2),
    );
    expect(federation.pullStateFromPeer).toHaveBeenLastCalledWith(
      'a.test',
      11n,
    );
    await scheduler.onModuleDestroy();
  });
});
