import { describe, it, expect } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { BoundedRequestScheduler } from './bounded-request-scheduler';

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('BoundedRequestScheduler', () => {
  it('bounds eight requests and removes queued cancellations without starting them', async () => {
    const scheduler = new BoundedRequestScheduler(8);
    const jobs = Array.from({ length: 10 }, () => deferred<number>());
    const started: number[] = [];
    const subscriptions = jobs.map((job, i) =>
      scheduler
        .schedule(async () => {
          started.push(i);
          return job.promise;
        })
        .subscribe(),
    );
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    subscriptions[8].unsubscribe();
    jobs[0].resolve(0);
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9]);
    jobs.forEach((job, i) => job.resolve(i));
    await tick();
  });

  it('does not release aborted slots until the actual transport settles', async () => {
    const scheduler = new BoundedRequestScheduler(1);
    const transport = deferred<number>();
    let signal: AbortSignal | undefined;
    let secondStarted = false;
    const subscription = scheduler
      .schedule((current) => {
        signal = current;
        return transport.promise;
      })
      .subscribe();
    const second = firstValueFrom(
      scheduler.schedule(async () => {
        secondStarted = true;
        return 2;
      }),
    );
    await tick();
    subscription.unsubscribe();
    expect(signal?.aborted).toBe(true);
    await tick();
    expect(secondStarted).toBe(false);
    transport.reject(new Error('abort acknowledged'));
    expect(await second).toBe(2);
  });

  it('does not cancel successful completion, including firstValueFrom teardown', async () => {
    const scheduler = new BoundedRequestScheduler(1);
    let signal: AbortSignal | undefined;
    expect(
      await firstValueFrom(
        scheduler.schedule(async (current) => {
          signal = current;
          return 1;
        }),
      ),
    ).toBe(1);
    expect(signal?.aborted).toBe(false);
  });

  it('releases failures and synchronous throws without leaking capacity', async () => {
    const scheduler = new BoundedRequestScheduler(1);
    await expect(
      firstValueFrom(
        scheduler.schedule(() => {
          throw new Error('failure');
        }),
      ),
    ).rejects.toThrow('failure');
    expect(await firstValueFrom(scheduler.schedule(async () => 2))).toBe(2);
  });
});
