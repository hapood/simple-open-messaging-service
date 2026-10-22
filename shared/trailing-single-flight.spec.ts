import { describe, expect, it, vi } from 'vitest';
import {
  TrailingSingleFlight,
  coalesceQueuedTargets,
} from './trailing-single-flight.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TrailingSingleFlight', () => {
  it('joins concurrent triggers onto one run', async () => {
    const gate = deferred<void>();
    const runs: number[] = [];
    const flight = new TrailingSingleFlight<number>(async (arg) => {
      runs.push(arg);
      await gate.promise;
    });

    const first = flight.trigger(1);
    const second = flight.trigger(2);
    const third = flight.trigger(3);
    gate.resolve();
    await Promise.all([first, second, third]);

    // One joined round, then a single trailing round with the latest arg.
    expect(runs).toEqual([1, 3]);
  });

  it('honors a custom argument merge', async () => {
    const gate = deferred<void>();
    const runs: number[] = [];
    const flight = new TrailingSingleFlight<number>(
      async (arg) => {
        runs.push(arg);
        await gate.promise;
      },
      (current, incoming) => Math.max(current, incoming),
    );

    const first = flight.trigger(5);
    flight.trigger(2);
    flight.trigger(9);
    gate.resolve();
    await first;
    expect(runs).toEqual([5, 9]);
  });

  it('rejects every awaiter of a failed sequence and clears the slot', async () => {
    const gate = deferred<void>();
    let failNextRound = true;
    const run = vi.fn(async () => {
      await gate.promise;
      if (failNextRound) {
        failNextRound = false;
        throw new Error('round failed');
      }
    });
    const flight = new TrailingSingleFlight<void>(run);

    const first = flight.trigger(undefined);
    const joined = flight.trigger(undefined);
    gate.resolve();
    await expect(first).rejects.toThrow('round failed');
    await expect(joined).rejects.toThrow('round failed');

    // The slot is free again and a fresh trigger starts a new sequence.
    gate.resolve();
    await expect(flight.trigger(undefined)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs the trailing argument in a separate round even when the first round already finished reading its state', async () => {
    // The classic miss: a trigger lands after the in-flight round's last
    // await has resolved but before the sequence settles. The trailing edge
    // must still observe it.
    let rounds = 0;
    const flight = new TrailingSingleFlight<number>(async (arg) => {
      rounds += 1;
      if (arg === 1) await Promise.resolve();
    });
    const first = flight.trigger(1);
    await Promise.resolve();
    const joined = flight.trigger(2);
    await Promise.all([first, joined]);
    expect(rounds).toBe(2);
  });
});

describe('coalesceQueuedTargets', () => {
  it('coalesces queued targets and preserves a trailing wake', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const run = vi.fn().mockResolvedValue(undefined);
    const wake = coalesceQueuedTargets((task) => tasks.push(task), run);
    wake(2);
    wake(5);
    wake(3);
    expect(tasks).toHaveLength(1);
    await tasks.shift()!();
    expect(run).toHaveBeenCalledWith(5);

    let finish!: () => void;
    run.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    wake(6);
    const running = tasks.shift()!();
    wake(9);
    finish();
    await running;
    expect(tasks).toHaveLength(1);
    await tasks.shift()!();
    expect(run.mock.calls.map(([target]) => target)).toEqual([5, 6, 9]);
  });
});

