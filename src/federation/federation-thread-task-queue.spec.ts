import { describe, expect, it, vi } from 'vitest';
import {
  FederationThreadTaskQueue,
  type FederationThreadTask,
} from './federation-thread-task-queue.js';
import { FederationSchedulerMutex } from './federation-scheduler-mutex.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FederationPeerRuntimeService } from './federation-peer-runtime.service.js';
import { FEDERATION_NAMESPACE_PAUSED } from './federation-peer.events.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  const blocked = new Set<number>();
  const execute = vi
    .fn<(task: FederationThreadTask) => Promise<boolean>>()
    .mockResolvedValue(false);
  const failed = vi.fn().mockResolvedValue(undefined);
  const queue = new FederationThreadTaskQueue(
    { allows: (nsid) => !blocked.has(nsid), execute, failed },
    {
      message: 1,
      reverse: 1,
      tombstone: 1,
      meta: 1,
    },
  );
  return { queue, execute, failed, blocked };
}

describe('thread-indexed task queue', () => {
  it('publishes cooldown before cancellation and lets the failing worker cancel itself without deadlock', async () => {
    const events = new EventEmitter2();
    const runtime = new FederationPeerRuntimeService(events);
    const first = deferred<boolean>();
    const execute = vi
      .fn<(task: FederationThreadTask) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(false);
    const queue = new FederationThreadTaskQueue(
      {
        allows: (namespaceId) => runtime.getCooldown(namespaceId) === null,
        execute,
        failed: async (task) =>
          runtime.enterCooldown(task.namespaceId, 'rate limited', 60),
      },
      { message: 1, reverse: 1, tombstone: 1, meta: 1 },
    );
    events.on(FEDERATION_NAMESPACE_PAUSED, async ({ namespaceId }) => {
      expect(runtime.getCooldown(namespaceId)).not.toBeNull();
      await queue.cancelNamespace(namespaceId);
    });
    await queue.wake(1, 7, 'reverse', true);
    await queue.wake(2, 7, 'reverse', true);
    execute.mockRejectedValueOnce(new Error('rate limited'));
    first.resolve(false);
    await vi.waitFor(() => expect(runtime.getCooldown(7)).not.toBeNull());
    await queue.wake(3, 7, 'reverse', true);
    await queue.shutdown();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0].signal.aborted).toBe(true);
  });

  it('rechecks namespace admission after selection and before execution', async () => {
    const execute = vi.fn().mockResolvedValue(false);
    const failed = vi.fn().mockResolvedValue(undefined);
    // Admission is open when waking and selecting, then closes before execution.
    const allows = vi
      .fn<(namespaceId: number) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const queue = new FederationThreadTaskQueue(
      { allows, execute, failed },
      {
        message: 1,
        reverse: 1,
        tombstone: 1,
        meta: 1,
      },
    );
    await queue.wake(1, 7, 'reverse', true);
    await queue.shutdown();
    expect(allows).toHaveBeenCalledTimes(3);
    expect(allows.mock.calls.every(([namespaceId]) => namespaceId === 7)).toBe(
      true,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('keeps another namespace task in the same thread when cancelling one namespace', async () => {
    const { queue, execute, blocked } = harness();
    const first = deferred<boolean>();
    execute.mockReturnValueOnce(first.promise);
    await queue.wake(1, 7, 'reverse', true);
    await queue.wake(1, 8, 'reverse', true);
    blocked.add(7);
    await queue.cancelNamespace(7);
    first.resolve(false);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls[1][0]).toMatchObject({
      threadId: 1,
      namespaceId: 8,
      direction: 'reverse',
      dirty: true,
    });
    expect(execute.mock.calls[1][0].signal.aborted).toBe(false);
    await queue.shutdown();
  });

  it('serializes message directions across all sources but lets tomb run independently', async () => {
    const { queue, execute } = harness();
    const first = deferred<boolean>();
    execute.mockReturnValueOnce(first.promise);
    await queue.wake(1, 7, 'message', true);
    await queue.wake(1, 8, 'reverse', true);
    await queue.wake(1, 8, 'tombstone', true);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls.map(([task]) => task.direction)).toEqual([
      'message',
      'tombstone',
    ]);
    first.resolve(false);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(execute.mock.calls[2][0].direction).toBe('reverse');
    await queue.shutdown();
  });

  it('selects ready dirty work before an internal continuation', async () => {
    const { queue, execute } = harness();
    const first = deferred<boolean>();
    execute.mockReturnValueOnce(first.promise);
    await queue.wake(1, 7, 'reverse', true);
    await queue.wake(2, 8, 'reverse', true);
    first.resolve(true);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(
      execute.mock.calls.map(([task]) => [task.threadId, task.dirty]),
    ).toEqual([
      [1, true],
      [2, true],
      [1, false],
    ]);
    await queue.shutdown();
  });

  it('coalesces dirty received during an active round', async () => {
    const { queue, execute } = harness();
    const first = deferred<boolean>();
    execute.mockReturnValueOnce(first.promise);
    await queue.wake(1, 7, 'reverse', true);
    await queue.wake(1, 7, 'reverse', true);
    await queue.wake(1, 7, 'reverse', true);
    first.resolve(false);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls.map(([task]) => task.dirty)).toEqual([
      true,
      true,
    ]);
    await queue.shutdown();
  });

  it('cancels a namespace without waiting for its worker and isolates restored tasks from stale finally', async () => {
    const { queue, execute, blocked } = harness();
    const first = deferred<boolean>();
    execute.mockReturnValueOnce(first.promise);
    await queue.wake(1, 7, 'reverse', true);
    await queue.wake(2, 7, 'reverse', true);
    blocked.add(7);
    await queue.cancelNamespace(7);
    expect(execute.mock.calls[0][0].signal.aborted).toBe(true);
    await queue.wake(3, 7, 'reverse', true);
    blocked.delete(7);
    await queue.wake(1, 7, 'reverse', true);
    expect(execute).toHaveBeenCalledTimes(1);
    first.resolve(true);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute.mock.calls[1][0]).toMatchObject({
      threadId: 1,
      dirty: true,
    });
    expect(execute.mock.calls[1][0].signal.aborted).toBe(false);
    await queue.shutdown();
  });

  it('does not retry failed tasks or manufacture dirty', async () => {
    const { queue, execute, failed } = harness();
    const error = new Error('failed');
    execute.mockRejectedValueOnce(error);
    await queue.wake(1, 7, 'reverse', true);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    await queue.shutdown();
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('scheduler mutation mutex', () => {
  it('preserves FIFO order and releases after throwing', async () => {
    const mutex = new FederationSchedulerMutex();
    const order: number[] = [];
    const failed = mutex.runExclusive(() => {
      order.push(1);
      throw new Error('mutation');
    });
    const next = mutex.runExclusive(() => {
      order.push(2);
      return 42;
    });
    await expect(failed).rejects.toThrow('mutation');
    await expect(next).resolves.toBe(42);
    expect(order).toEqual([1, 2]);
  });
});
