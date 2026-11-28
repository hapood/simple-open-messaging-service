import { describe, expect, it, vi } from 'vitest';
import {
  DatabaseOperationGate,
  DatabaseOperationLifetimeEndedError,
} from './database-operation-gate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('DatabaseOperationGate', () => {
  it('rejects terminal results without releasing drain before underlying work settles', async () => {
    const lifetime = new AbortController();
    const gate = new DatabaseOperationGate();
    gate.bind(lifetime.signal);
    const work = deferred<number>();
    const result = gate.run(() => work.promise);
    const rejected = expect(result).rejects.toThrow('lifetime ended');
    lifetime.abort();
    const idle = vi.fn();
    const drain = gate.drain().then(idle);
    await Promise.resolve();
    expect(idle).not.toHaveBeenCalled();
    work.resolve(4);
    await rejected;
    await drain;
    expect(idle).toHaveBeenCalledOnce();
  });

  it('does not start queued or new work after termination and cannot rebind', async () => {
    const gate = new DatabaseOperationGate();
    const lifetime = new AbortController();
    gate.bind(lifetime.signal);
    const operation = vi.fn(async () => 1);
    const queued = Promise.resolve().then(() => gate.run(operation));
    lifetime.abort();
    await expect(queued).rejects.toThrow('lifetime ended');
    await expect(gate.run(operation)).rejects.toThrow('lifetime ended');
    expect(operation).not.toHaveBeenCalled();
    expect(() => gate.bind(new AbortController().signal)).toThrow(
      'already bound',
    );
  });

  it('drains failures and leaves explicit owner cleanup outside business admission', async () => {
    const gate = new DatabaseOperationGate();
    const lifetime = new AbortController();
    gate.bind(lifetime.signal);
    const work = deferred<void>();
    const result = gate.run(() => work.promise);
    const failure = new Error('write failed');
    const rejected = expect(result).rejects.toMatchObject({
      name: 'DatabaseOperationLifetimeEndedError',
      cause: failure,
    });
    lifetime.abort();
    const cleanup = vi.fn();
    const closing = gate.drain().then(cleanup);
    work.reject(failure);
    await rejected;
    await closing;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('preserves active failures and exposes terminal errors without string matching', async () => {
    const gate = new DatabaseOperationGate();
    const lifetime = new AbortController();
    gate.bind(lifetime.signal);
    const failure = new Error('database unavailable');
    await expect(
      gate.run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    lifetime.abort();
    await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(
      DatabaseOperationLifetimeEndedError,
    );
  });

  it('supports standalone storage owners without an app lifetime', async () => {
    const gate = new DatabaseOperationGate();
    await expect(gate.run(async () => 3)).resolves.toBe(3);
    await gate.drain();
  });
});
