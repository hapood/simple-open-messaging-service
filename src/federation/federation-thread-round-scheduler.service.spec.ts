import { describe, expect, it, vi } from 'vitest';
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
    run: vi.fn().mockResolvedValue({ blockedByPending: false }),
  };
  const reverse = {
    run: vi.fn().mockResolvedValue({ blockedByPending: false }),
  };
  const database = {
    db: {
      select: vi.fn(() => ({
        from: vi.fn().mockResolvedValue([]),
      })),
    },
  };
  const scheduler = new FederationThreadRoundSchedulerService(
    database as never,
    states as never,
    forward as never,
    reverse as never,
  );
  return { scheduler, states, sources, forward, reverse, database };
}

describe('FederationThreadRoundSchedulerService', () => {
  it('coalesces a wake received while the same direction is active', async () => {
    const { scheduler, forward } = harness();
    let release!: () => void;
    forward.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ blockedByPending: false });
        }),
    );

    await scheduler.wake(1, 'a.test', 'forward');
    await vi.waitFor(() => expect(forward.run).toHaveBeenCalledOnce());
    await scheduler.wake(1, 'a.test', 'forward');
    expect(forward.run).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(forward.run).toHaveBeenCalledTimes(2));
    await scheduler.onModuleDestroy();
  });

  it('rotates peers after each one-round quantum', async () => {
    const { scheduler, forward } = harness();
    (
      scheduler as unknown as {
        limits: { forward: number; reverse: number };
      }
    ).limits.forward = 1;
    const order: number[] = [];
    let releaseFirst!: () => void;
    forward.run.mockImplementation(async (threadId: number) => {
      order.push(threadId);
      if (threadId === 1 && order.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { blockedByPending: false };
    });

    await Promise.all([
      scheduler.wake(1, 'a.test', 'forward'),
      scheduler.wake(3, 'a.test', 'forward'),
      scheduler.wake(2, 'b.test', 'forward'),
    ]);
    await vi.waitFor(() => expect(order).toEqual([1]));
    releaseFirst();
    await vi.waitFor(() => expect(order).toEqual([1, 2, 3]));
    await scheduler.onModuleDestroy();
  });

  it('does not hot-loop a reverse round blocked at pending media', async () => {
    const { scheduler, states, reverse } = harness();
    states.require.mockResolvedValue({
      historyBoundaryReached: false,
      messageTargetSeq: 10,
      deletionTargetSeq: 0,
      messageProcessedThroughSeq: 10,
      deletionProcessedThroughSeq: 0,
    });
    reverse.run.mockResolvedValue({ blockedByPending: true });

    await scheduler.wake(1, 'a.test', 'reverse');
    await vi.waitFor(() => expect(reverse.run).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reverse.run).toHaveBeenCalledOnce();

    scheduler.onWake({
      threadId: 1,
      peerDomain: 'a.test',
      direction: 'reverse',
    });
    await vi.waitFor(() => expect(reverse.run).toHaveBeenCalledTimes(2));
    await scheduler.onModuleDestroy();
  });

  it('reconstructs forward and reverse work from durable state at startup', async () => {
    const { scheduler, database, forward, reverse } = harness();
    database.db.select.mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([
        {
          threadId: 1,
          peerDomain: 'a.test',
          messageTargetSeq: 12,
          deletionTargetSeq: 4,
          messageProcessedThroughSeq: 10,
          deletionProcessedThroughSeq: 4,
          historyBoundaryReached: false,
        },
      ]),
    });

    await scheduler.onApplicationBootstrap();
    await vi.waitFor(() => {
      expect(forward.run).toHaveBeenCalledOnce();
      expect(reverse.run).toHaveBeenCalledOnce();
    });
    await scheduler.onModuleDestroy();
  });
});
