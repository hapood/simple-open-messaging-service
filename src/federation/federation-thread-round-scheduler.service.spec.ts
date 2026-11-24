import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { QuotaPausedError } from '../quota/quota-runtime.js';
import {
  FederationThreadSourceInactiveError,
  S2sResponseError,
} from './federation-errors.js';
import { FederationPeerRuntimeService } from './federation-peer-runtime.service.js';
import {
  FederationThreadRoundAuthorizationEpochChangedError,
  FederationThreadRoundRemoteError,
} from './federation-thread-round-error.js';
import { FederationThreadRoundSchedulerService } from './federation-thread-round-scheduler.service.js';

function source(threadId: number, namespaceId = 7) {
  return {
    kind: 'GROUP' as const,
    localGroupAuthority: true,
    threadId,
    namespaceId,
    demand: { account: `!group-${threadId}` },
  };
}

function harness() {
  const databaseState = {
    active: true,
    startupRows: [] as Array<Record<string, unknown>>,
    peers: [] as Array<{ id: number }>,
  };
  const states = {
    require: vi.fn().mockResolvedValue({
      messageTargetSeq: 10,
      deletionTargetSeq: 0,
      messageProcessedThroughSeq: 10,
      deletionProcessedThroughSeq: 0,
    }),
    resolveReverseWindow: vi.fn().mockResolvedValue(null),
  };
  const sources = {
    resolve: vi.fn((threadId: number, namespaceId: number) =>
      source(threadId, namespaceId),
    ),
  };
  const forward = {
    runMessages: vi.fn().mockResolvedValue(undefined),
    runTombstones: vi.fn().mockResolvedValue({ hasMore: false }),
  };
  const reverse = {
    run: vi.fn().mockResolvedValue({ committed: true }),
  };
  const meta = {
    run: vi.fn().mockResolvedValue(false),
  };
  const database = {
    db: {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      query: {
        identityNamespace: {
          findMany: vi.fn(async () => databaseState.peers),
        },
      },
      select: vi.fn((shape: Record<string, unknown>) => {
        const result =
          'threadId' in shape
            ? databaseState.startupRows
            : databaseState.active
              ? [{ id: 7 }]
              : [];
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
  const peerLifecycle = {
    listTrustedPeerDomains: vi.fn().mockResolvedValue([]),
  };
  const statePull = {
    pullStateFromPeer: vi.fn().mockResolvedValue(0n),
  };
  const denials = {
    handleThreadQueryForbidden: vi.fn().mockResolvedValue('P2P_REVOKED'),
  };
  const quota = { assertCanPullMessages: vi.fn().mockResolvedValue(undefined) };
  const events = new EventEmitter2();
  const runtime = new FederationPeerRuntimeService(events);
  const scheduler = new FederationThreadRoundSchedulerService(
    database as never,
    states as never,
    forward as never,
    reverse as never,
    meta as never,
    peerLifecycle as never,
    statePull as never,
    denials as never,
    sources as never,
    {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitUntilInitialized: vi.fn().mockResolvedValue(undefined),
    } as never,
    quota as never,
    runtime,
  );
  return {
    scheduler,
    runtime,
    quota,
    states,
    sources,
    peerLifecycle,
    statePull,
    denials,
    forward,
    reverse,
    meta,
    database,
    databaseState,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('FederationThreadRoundSchedulerService', () => {
  it.each(['P2P', 'GROUP'] as const)(
    'routes ordinary %s message advertisements to reverse and wakes the deletion cutoff',
    async (kind) => {
      const h = harness();
      h.sources.resolve.mockImplementation(
        (threadId, namespaceId) =>
          ({
            ...source(threadId, namespaceId),
            kind,
            localGroupAuthority: false,
          }) as never,
      );
      try {
        h.scheduler.onWake({
          threadId: 1,
          namespaceId: 7,
          mode: 'thread',
        });
        await vi.waitFor(() => expect(h.reverse.run).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
          expect(h.forward.runTombstones).toHaveBeenCalled(),
        );
        expect(h.forward.runMessages).not.toHaveBeenCalled();
      } finally {
        await h.scheduler.onModuleDestroy();
      }
    },
  );

  it('does not spin on a reverse page when no recoverable gap remains', async () => {
    const h = harness();
    h.sources.resolve.mockImplementation((threadId, namespaceId) => ({
      ...source(threadId, namespaceId),
      localGroupAuthority: false,
    }));
    h.reverse.run.mockResolvedValue({ committed: false });
    h.states.resolveReverseWindow.mockResolvedValue(null);
    try {
      h.scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
      await vi.waitFor(() => expect(h.reverse.run).toHaveBeenCalledOnce());
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.reverse.run).toHaveBeenCalledOnce();
      expect(h.forward.runTombstones).toHaveBeenCalledOnce();
    } finally {
      await h.scheduler.onModuleDestroy();
    }
  });

  it('enters namespace cooldown on QuotaPausedError and resumes only after periodic Health', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { scheduler, runtime, forward, quota } = harness();
    try {
      quota.assertCanPullMessages.mockRejectedValueOnce(
        new QuotaPausedError(60),
      );
      scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
      await vi.waitFor(() => expect(runtime.getCooldown(7)).not.toBeNull());
      expect(forward.runMessages).not.toHaveBeenCalled();

      const observed = runtime.getCooldown(7);
      quota.assertCanPullMessages.mockResolvedValue(undefined);
      vi.advanceTimersByTime(60_000);
      // Expiry alone does not resume work.
      scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
      await vi.advanceTimersByTimeAsync(0);
      expect(forward.runMessages).not.toHaveBeenCalled();

      await runtime.completePeriodicHealth(7, observed, true);
      await scheduler.onNamespaceResumed({ namespaceId: 7 });
      scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
      await vi.waitFor(() =>
        expect(forward.runMessages).toHaveBeenCalledOnce(),
      );
    } finally {
      await scheduler.onModuleDestroy();
      vi.useRealTimers();
    }
  });

  it('starts initialized work after a local relationship publication without waiting for a content head', async () => {
    const h = harness();
    h.databaseState.startupRows = [
      {
        threadId: 1,
        namespaceId: 1,
        threadType: 'GROUP',
        authorityNamespaceId: 0,
        messageTargetSeq: 3,
        messageProcessedThroughSeq: 2,
        deletionTargetSeq: 0,
        deletionProcessedThroughSeq: 0,
        reverseCoveredThroughSeq: 0,
        reversePending: false,
      },
    ];
    try {
      await h.scheduler.onRelationshipStatePublished({ namespaceId: 1 });
      await vi.waitFor(() => {
        expect(h.forward.runMessages).toHaveBeenCalled();
        expect(h.reverse.run).not.toHaveBeenCalled();
      });
      expect(h.forward.runTombstones).not.toHaveBeenCalled();
    } finally {
      await h.scheduler.onModuleDestroy();
    }
  });

  it.each(['message', 'tombstone', 'reverse'] as const)(
    'logs stale %s rounds at debug and does not locally retry ordinary errors',
    async (direction) => {
      vi.useFakeTimers();
      const { scheduler, forward, reverse, sources } = harness();
      sources.resolve.mockImplementation((threadId, namespaceId) => ({
        ...source(threadId, namespaceId),
        localGroupAuthority: direction !== 'reverse',
      }));
      const run =
        direction === 'message'
          ? forward.runMessages
          : direction === 'tombstone'
            ? forward.runTombstones
            : reverse.run;
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const debug = vi
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => {});
      run
        .mockRejectedValueOnce(
          new FederationThreadRoundAuthorizationEpochChangedError(),
        )
        .mockRejectedValueOnce(new Error('network unavailable'));
      try {
        await (
          scheduler as unknown as {
            wakeCaptured(
              threadId: number,
              namespaceId: number,
              direction: 'message' | 'tombstone' | 'reverse',
            ): Promise<void>;
          }
        ).wakeCaptured(1, 7, direction);
        await vi.advanceTimersByTimeAsync(0);
        expect(debug).toHaveBeenCalledWith(
          expect.stringContaining('authorization epoch changed'),
        );
        expect(warn).not.toHaveBeenCalled();

        await (
          scheduler as unknown as {
            wakeCaptured(
              threadId: number,
              namespaceId: number,
              direction: 'message' | 'tombstone' | 'reverse',
            ): Promise<void>;
          }
        ).wakeCaptured(1, 7, direction);
        await vi.advanceTimersByTimeAsync(0);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('network unavailable'),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        expect(run).toHaveBeenCalledTimes(2);
      } finally {
        await scheduler.onModuleDestroy();
        warn.mockRestore();
        debug.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(['message', 'tombstone', 'reverse'] as const)(
    'logs handled %s authorization denials only at debug level',
    async (direction) => {
      const { scheduler, forward, reverse, statePull, sources } = harness();
      sources.resolve.mockImplementation((threadId, namespaceId) => ({
        ...source(threadId, namespaceId),
        localGroupAuthority: direction !== 'reverse',
      }));
      const run =
        direction === 'message'
          ? forward.runMessages
          : direction === 'tombstone'
            ? forward.runTombstones
            : reverse.run;
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const error = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      const debug = vi
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => {});
      run.mockRejectedValueOnce(
        new FederationThreadRoundRemoteError(
          new S2sResponseError('forbidden', 200, BusinessCode.FORBIDDEN),
          7,
        ),
      );
      try {
        await (
          scheduler as unknown as {
            wakeCaptured(
              threadId: number,
              namespaceId: number,
              direction: 'message' | 'tombstone' | 'reverse',
            ): Promise<void>;
          }
        ).wakeCaptured(1, 7, direction);
        await vi.waitFor(() =>
          expect(statePull.pullStateFromPeer).toHaveBeenCalled(),
        );
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledWith(
          expect.stringContaining('P2P_REVOKED'),
        );
      } finally {
        await scheduler.onModuleDestroy();
        warn.mockRestore();
        error.mockRestore();
        debug.mockRestore();
      }
    },
  );

  it('still reports failures while handling an authorization denial', async () => {
    const { scheduler, forward, denials } = harness();
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    denials.handleThreadQueryForbidden.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    forward.runMessages.mockRejectedValueOnce(
      new FederationThreadRoundRemoteError(
        new S2sResponseError('forbidden', 200, BusinessCode.FORBIDDEN),
        7,
      ),
    );
    try {
      scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining(
            'failed to converge forbidden federation thread',
          ),
        ),
      );
    } finally {
      await scheduler.onModuleDestroy();
      error.mockRestore();
    }
  });

  it.each(['message', 'tombstone', 'reverse'] as const)(
    'quietly ends inactive %s work and allows a later wake',
    async (direction) => {
      const { scheduler, forward, reverse, denials, sources } = harness();
      sources.resolve.mockImplementation((threadId, namespaceId) => ({
        ...source(threadId, namespaceId),
        localGroupAuthority: direction !== 'reverse',
      }));
      const run =
        direction === 'message'
          ? forward.runMessages
          : direction === 'tombstone'
            ? forward.runTombstones
            : reverse.run;
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const error = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      run.mockRejectedValueOnce(
        new FederationThreadSourceInactiveError('membership ended'),
      );
      try {
        const wake = () =>
          (
            scheduler as unknown as {
              wakeCaptured(
                threadId: number,
                namespaceId: number,
                direction: 'message' | 'tombstone' | 'reverse',
              ): Promise<void>;
            }
          ).wakeCaptured(1, 7, direction);
        await wake();
        await new Promise((resolve) => setImmediate(resolve));
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledTimes(1);
        expect(denials.handleThreadQueryForbidden).not.toHaveBeenCalled();
        await wake();
        await new Promise((resolve) => setImmediate(resolve));
        expect(run).toHaveBeenCalledTimes(2);
      } finally {
        await scheduler.onModuleDestroy();
        warn.mockRestore();
        error.mockRestore();
      }
    },
  );

  it('coalesces a wake received while the same direction is active', async () => {
    const { scheduler, forward } = harness();
    let release!: () => void;
    forward.runMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );

    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
    await vi.waitFor(() => expect(forward.runMessages).toHaveBeenCalledOnce());
    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
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
          releaseTombstone = () => resolve({ hasMore: false });
        }),
    );

    scheduler.onWake({
      threadId: 1,
      namespaceId: 7,
      mode: 'thread',
    });

    await vi.waitFor(() => {
      expect(forward.runMessages).toHaveBeenCalledOnce();
      expect(forward.runTombstones).toHaveBeenCalledWith(
        1,
        7,
        expect.any(AbortSignal),
        50,
      );
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
    });
    let releaseFirst!: () => void;
    forward.runTombstones
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ hasMore: true });
          }),
      )
      .mockResolvedValueOnce({ hasMore: false });

    scheduler.onWake({
      threadId: 1,
      namespaceId: 7,
      mode: 'thread',
    });
    await vi.waitFor(() =>
      expect(forward.runTombstones).toHaveBeenCalledWith(
        1,
        7,
        expect.any(AbortSignal),
        50,
      ),
    );

    scheduler.onWake({
      threadId: 1,
      namespaceId: 7,
      mode: 'thread',
    });
    scheduler.onWake({
      threadId: 1,
      namespaceId: 7,
      mode: 'thread',
    });
    expect(forward.runTombstones).toHaveBeenCalledOnce();
    releaseFirst();

    await vi.waitFor(() =>
      expect(forward.runTombstones).toHaveBeenNthCalledWith(
        2,
        1,
        7,
        expect.any(AbortSignal),
        50,
      ),
    );
    await scheduler.onModuleDestroy();
  });

  it('continues reverse batches until no recoverable gap remains', async () => {
    const { scheduler, states, reverse, sources } = harness();
    sources.resolve.mockImplementation((threadId, namespaceId) => ({
      ...source(threadId, namespaceId),
      localGroupAuthority: false,
    }));
    states.resolveReverseWindow
      .mockResolvedValueOnce({ gapId: 1n, beforeSeq: 10, throughSeq: 1 })
      .mockResolvedValueOnce(null);

    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
    await vi.waitFor(() => expect(reverse.run).toHaveBeenCalledTimes(2));
    await scheduler.onModuleDestroy();
  });

  it('continues a forward namespace across scheduler quanta', async () => {
    const { scheduler, states, forward } = harness();
    let messageRuns = 0;
    forward.runMessages.mockImplementation(async () => {
      messageRuns += 1;
    });
    states.require.mockImplementation(async () => ({
      messageTargetSeq: 10,
      deletionTargetSeq: 0,
      messageProcessedThroughSeq: messageRuns < 2 ? 9 : 10,
      deletionProcessedThroughSeq: 0,
    }));

    scheduler.onWake({
      threadId: 1,
      namespaceId: 7,
      mode: 'thread',
    });

    await vi.waitFor(() =>
      expect(forward.runMessages).toHaveBeenCalledTimes(2),
    );
    await scheduler.onModuleDestroy();
  });

  it('cancels queued source work on FORBIDDEN and reopens on a new thread wake', async () => {
    const { scheduler, forward, denials, statePull } = harness();
    forward.runMessages
      .mockRejectedValueOnce(
        new FederationThreadRoundRemoteError(
          new S2sResponseError('forbidden', 200, BusinessCode.FORBIDDEN),
          7,
        ),
      )
      .mockResolvedValue(undefined);

    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
    await vi.waitFor(() =>
      expect(denials.handleThreadQueryForbidden).toHaveBeenCalledWith(1, 7, 7),
    );
    await vi.waitFor(() =>
      expect(statePull.pullStateFromPeer).toHaveBeenCalledWith(
        7,
        0n,
        expect.any(AbortSignal),
      ),
    );

    scheduler.onWake({
      threadId: 1,
      namespaceId: 7,
      mode: 'thread',
    });
    await vi.waitFor(() =>
      expect(forward.runMessages).toHaveBeenCalledTimes(2),
    );
    await scheduler.onModuleDestroy();
  });

  it('wakes state-feed on STALE FORBIDDEN without cancelling the source', async () => {
    const { scheduler, forward, denials, statePull } = harness();
    denials.handleThreadQueryForbidden.mockResolvedValueOnce('STALE');
    forward.runMessages.mockRejectedValueOnce(
      new FederationThreadRoundRemoteError(
        new S2sResponseError('forbidden', 200, BusinessCode.FORBIDDEN),
        7,
      ),
    );

    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
    await vi.waitFor(() =>
      expect(statePull.pullStateFromPeer).toHaveBeenCalledWith(
        7,
        0n,
        expect.any(AbortSignal),
      ),
    );
    await scheduler.onModuleDestroy();
  });

  it('stops a denied mirror until the next push without pulling state', async () => {
    const { scheduler, forward, denials, statePull } = harness();
    denials.handleThreadQueryForbidden.mockResolvedValueOnce(
      'MIRROR_WAITING_FOR_PUSH',
    );
    forward.runMessages
      .mockRejectedValueOnce(
        new FederationThreadRoundRemoteError(
          new S2sResponseError('forbidden', 200, BusinessCode.FORBIDDEN),
          7,
        ),
      )
      .mockResolvedValueOnce(undefined);

    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
    await vi.waitFor(() =>
      expect(denials.handleThreadQueryForbidden).toHaveBeenCalledOnce(),
    );
    expect(statePull.pullStateFromPeer).not.toHaveBeenCalled();

    scheduler.onWake({
      threadId: 1,
      namespaceId: 7,
      mode: 'thread',
    });
    await vi.waitFor(() =>
      expect(forward.runMessages).toHaveBeenCalledTimes(2),
    );
    await scheduler.onModuleDestroy();
  });

  it('reconstructs independent message, tombstone, and reverse work at startup', async () => {
    const { scheduler, databaseState, forward, reverse } = harness();
    databaseState.startupRows = [
      {
        threadId: 1,
        namespaceId: 7,
        threadType: 'GROUP',
        authorityNamespaceId: 0,
        messageTargetSeq: 12,
        deletionTargetSeq: 4,
        messageProcessedThroughSeq: 10,
        deletionProcessedThroughSeq: 2,
        reverseCoveredThroughSeq: 0,
        reversePending: false,
      },
    ];

    await scheduler.onApplicationBootstrap();
    await vi.waitFor(() => {
      expect(forward.runMessages).toHaveBeenCalledOnce();
      expect(forward.runTombstones).toHaveBeenCalledWith(
        1,
        7,
        expect.any(AbortSignal),
        50,
      );
      expect(reverse.run).not.toHaveBeenCalled();
    });
    await scheduler.onModuleDestroy();
  });

  it('restores both publishers of the same local thread without merging their work', async () => {
    const { scheduler, databaseState, forward, states } = harness();
    databaseState.startupRows = [7, 8].map((namespaceId) => ({
      threadId: 1,
      namespaceId,
      threadType: 'GROUP',
      authorityNamespaceId: 0,
      messageTargetSeq: 10,
      messageProcessedThroughSeq: 0,
      deletionTargetSeq: 2,
      deletionProcessedThroughSeq: 0,
      reverseCoveredThroughSeq: 0,
      reversePending: false,
    }));
    await scheduler.onApplicationBootstrap();
    await vi.waitFor(() => {
      expect(forward.runMessages).toHaveBeenCalledWith(
        1,
        7,
        expect.any(AbortSignal),
        50,
      );
      expect(forward.runMessages).toHaveBeenCalledWith(
        1,
        8,
        expect.any(AbortSignal),
        50,
      );
      expect(forward.runTombstones).toHaveBeenCalledWith(
        1,
        7,
        expect.any(AbortSignal),
        50,
      );
      expect(forward.runTombstones).toHaveBeenCalledWith(
        1,
        8,
        expect.any(AbortSignal),
        50,
      );
      expect(states.require).toHaveBeenCalledWith(1, 7);
      expect(states.require).toHaveBeenCalledWith(1, 8);
    });
    await scheduler.onModuleDestroy();
  });

  it('single-flights a peer state drain and follows with the greatest dirty target', async () => {
    const { scheduler, statePull } = harness();
    let release!: () => void;
    statePull.pullStateFromPeer
      .mockImplementationOnce(
        () =>
          new Promise<bigint>((resolve) => {
            release = () => resolve(7n);
          }),
      )
      .mockResolvedValueOnce(11n);

    void scheduler.wakeStateFeed(7, 7n);
    await vi.waitFor(() =>
      expect(statePull.pullStateFromPeer).toHaveBeenCalledOnce(),
    );
    void scheduler.wakeStateFeed(7, 11n);
    void scheduler.wakeStateFeed(7, 5n);
    expect(statePull.pullStateFromPeer).toHaveBeenCalledOnce();

    release();
    await vi.waitFor(() =>
      expect(statePull.pullStateFromPeer).toHaveBeenCalledTimes(2),
    );
    expect(statePull.pullStateFromPeer).toHaveBeenLastCalledWith(
      7,
      11n,
      expect.any(AbortSignal),
    );
    await scheduler.onModuleDestroy();
  });
});
