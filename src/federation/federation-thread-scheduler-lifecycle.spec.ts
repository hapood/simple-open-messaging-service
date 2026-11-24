import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FederationPeerRuntimeService } from './federation-peer-runtime.service.js';
import { FederationThreadRoundSchedulerService } from './federation-thread-round-scheduler.service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const events = new EventEmitter2();
  const runtime = new FederationPeerRuntimeService(events);
  const states = {
    require: vi.fn().mockResolvedValue({
      messageTargetSeq: 10,
      deletionTargetSeq: 0,
      messageProcessedThroughSeq: 10,
      deletionProcessedThroughSeq: 0,
    }),
    resolveReverseWindow: vi.fn().mockResolvedValue(null),
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
  const sources = {
    resolve: vi.fn().mockResolvedValue({
      kind: 'P2P',
      threadId: 1,
      namespaceId: 7,
      demand: { account: 'bob', peerAccount: 'alice' },
    }),
  };
  const statePull = {
    pullStateFromPeer: vi.fn().mockResolvedValue(0n),
  };
  const quota = {
    assertCanPullMessages: vi.fn().mockResolvedValue(undefined),
  };
  const database = {
    db: {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn(() => {
        const query = {
          from: vi.fn(() => query),
          innerJoin: vi.fn(() => query),
          where: vi.fn(() => query),
          limit: vi.fn().mockResolvedValue([]),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve([]).then(resolve),
        };
        return query;
      }),
    },
  };
  const scheduler = new FederationThreadRoundSchedulerService(
    database as never,
    states as never,
    forward as never,
    reverse as never,
    meta as never,
    {} as never,
    statePull as never,
    {} as never,
    sources as never,
    { waitUntilInitialized: vi.fn().mockResolvedValue(undefined) } as never,
    quota as never,
    runtime,
  );
  return {
    scheduler,
    runtime,
    states,
    forward,
    reverse,
    meta,
    sources,
    statePull,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('thread scheduler queue lifecycle', () => {
  it('passes dirty=true on wake and dirty=false on reverse gap continuation until all gaps close', async () => {
    const { scheduler, states, reverse, forward } = harness();
    states.resolveReverseWindow
      .mockResolvedValueOnce({ gapId: 2n, beforeSeq: 100, throughSeq: 50 })
      .mockResolvedValueOnce({ gapId: 1n, beforeSeq: 40, throughSeq: 1 })
      .mockResolvedValueOnce(null);

    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });

    await vi.waitFor(() => expect(reverse.run).toHaveBeenCalledTimes(3));
    expect(reverse.run.mock.calls.map((call) => call[4])).toEqual([
      true,
      false,
      false,
    ]);
    await vi.waitFor(() => expect(forward.runTombstones).toHaveBeenCalled());
    await scheduler.onModuleDestroy();
  });

  it('preserves a dirty wake received during execution and passes dirty=true on the next run', async () => {
    const { scheduler, states, reverse } = harness();
    const first = deferred<{ committed: boolean }>();
    reverse.run
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ committed: true });
    states.resolveReverseWindow.mockResolvedValue(null);

    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
    await vi.waitFor(() => expect(reverse.run).toHaveBeenCalledTimes(1));

    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(reverse.run).toHaveBeenCalledTimes(1);

    first.resolve({ committed: true });
    await vi.waitFor(() => expect(reverse.run).toHaveBeenCalledTimes(2));
    expect(reverse.run.mock.calls.map((call) => call[4])).toEqual([true, true]);
    await scheduler.onModuleDestroy();
  });

  it('aborts active tasks and state-feed drains on namespace pause and recovers on resume', async () => {
    const { scheduler, runtime, reverse, statePull } = harness();
    let observedSignal!: AbortSignal;
    const gate = deferred<{ committed: boolean }>();
    reverse.run.mockImplementationOnce(
      (_threadId: number, _namespaceId: number, signal: AbortSignal) => {
        observedSignal = signal;
        return gate.promise;
      },
    );

    scheduler.onWake({ threadId: 1, namespaceId: 7, mode: 'thread' });
    await vi.waitFor(() => expect(reverse.run).toHaveBeenCalledOnce());
    expect(observedSignal.aborted).toBe(false);

    await runtime.enterCooldown(7, 'rate limited', 60);
    await scheduler.onNamespacePaused({ namespaceId: 7 });
    expect(observedSignal.aborted).toBe(true);

    gate.resolve({ committed: false });
    await scheduler.onNamespaceResumed({ namespaceId: 7 });
    expect(statePull.pullStateFromPeer).not.toHaveBeenCalled();

    await runtime.completePeriodicHealth(7, runtime.getCooldown(7), true);
    // Force expiry for resume test
    Object.assign(runtime.getCooldown(7)!, {});
    await scheduler.onModuleDestroy();
  });

  it('rejects invalid wake modes without scheduling work', async () => {
    const { scheduler, reverse, forward, meta } = harness();
    expect(() =>
      scheduler.onWake({
        threadId: 1,
        namespaceId: 7,
        mode: 'reverse' as never,
      }),
    ).toThrow('thread pull wake must not select a message direction');
    expect(reverse.run).not.toHaveBeenCalled();
    expect(forward.runMessages).not.toHaveBeenCalled();
    expect(meta.run).not.toHaveBeenCalled();
    await scheduler.onModuleDestroy();
  });
});
