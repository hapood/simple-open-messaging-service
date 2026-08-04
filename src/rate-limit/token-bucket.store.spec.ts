import { describe, expect, it } from 'vitest';
import { TokenBucketStore } from './token-bucket.store.js';

describe('TokenBucketStore', () => {
  it('allows a burst, rejects exhaustion and reports retry time', () => {
    const store = new TokenBucketStore();
    const config = { ratePerSecond: 2, burst: 3 };
    expect(store.consume('key', config, 1, 0).allowed).toBe(true);
    expect(store.consume('key', config, 1, 0).allowed).toBe(true);
    expect(store.consume('key', config, 1, 0).allowed).toBe(true);
    expect(store.consume('key', config, 1, 0)).toMatchObject({
      allowed: false,
      retryAfterMs: 500,
    });
  });

  it('replenishes using monotonic elapsed time', () => {
    const store = new TokenBucketStore();
    const config = { ratePerSecond: 2, burst: 2 };
    store.consume('key', config, 2, 100);
    expect(store.consume('key', config, 1, 599).allowed).toBe(false);
    expect(store.consume('key', config, 1, 600).allowed).toBe(true);
  });

  it('removes idle buckets and bounds cardinality', () => {
    const store = new TokenBucketStore(2, 1_000);
    const config = { ratePerSecond: 1, burst: 1 };
    store.consume('a', config, 1, 0);
    store.consume('b', config, 1, 1);
    store.consume('c', config, 1, 2);
    expect(store.size).toBe(2);
    expect(store.cleanup(1_002)).toBe(2);
    expect(store.size).toBe(0);
  });
});
