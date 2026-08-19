import { SingleFlight } from './single-flight';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SingleFlight', () => {
  it('returns the exact same operation for the same key while it is pending', async () => {
    const flights = new SingleFlight<string, number>();
    const pending = deferred<number>();
    const factory = vi
      .fn()
      .mockName('factory')
      .mockReturnValue(pending.promise);

    const first = flights.run('thread:42', factory);
    const second = flights.run('thread:42', factory);

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith();
    pending.resolve(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
  });

  it('does not merge different keys', async () => {
    const flights = new SingleFlight<string, number>();
    const factory = vi
      .fn()
      .mockName('factory')
      .mockImplementation(async (value: number) => value);

    const first = flights.run('a', () => factory(1));
    const second = flights.run('b', () => factory(2));

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('removes a failed operation so a later call can retry', async () => {
    const flights = new SingleFlight<string, number>();
    const failed = deferred<number>();
    const firstFactory = vi
      .fn()
      .mockName('firstFactory')
      .mockReturnValue(failed.promise);
    const retryFactory = vi.fn().mockName('retryFactory').mockResolvedValue(9);

    const first = flights.run('key', firstFactory);
    const sameFailure = flights.run('key', retryFactory);
    failed.reject(new Error('offline'));

    await expect(first).rejects.toThrowError('offline');
    await expect(sameFailure).rejects.toThrowError('offline');
    expect(retryFactory).not.toHaveBeenCalled();
    await expect(flights.run('key', retryFactory)).resolves.toEqual(9);
    expect(retryFactory).toHaveBeenCalledTimes(1);
    expect(retryFactory).toHaveBeenCalledWith();
  });

  it('clear detaches pending operations without cancelling them', async () => {
    const flights = new SingleFlight<string, number>();
    const old = deferred<number>();
    const replacement = deferred<number>();

    const oldPromise = flights.run('key', () => old.promise);
    flights.clear();
    const newPromise = flights.run('key', () => replacement.promise);

    expect(newPromise).not.toBe(oldPromise);
    old.resolve(1);
    replacement.resolve(2);
    await expect(oldPromise).resolves.toEqual(1);
    await expect(newPromise).resolves.toEqual(2);
  });
});
