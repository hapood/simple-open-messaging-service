import { describe, expect, it } from 'vitest';
import { KeyedMutex } from './keyed-mutex.js';

describe('KeyedMutex', () => {
  it('serializes the same key in FIFO order', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = mutex.runExclusive('a', async () => {
      events.push('first:start');
      await held;
      events.push('first:end');
    });
    const second = mutex.runExclusive('a', async () => events.push('second'));
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('allows different keys to run concurrently and releases after errors', async () => {
    const mutex = new KeyedMutex();
    const active: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = mutex.runExclusive('a', async () => {
      active.push('a');
      await held;
      throw new Error('expected');
    });
    await mutex.runExclusive('b', async () => active.push('b'));
    expect(active).toEqual(['a', 'b']);
    release();
    await expect(first).rejects.toThrow('expected');
    await expect(mutex.runExclusive('a', async () => 42)).resolves.toBe(42);
  });
});
