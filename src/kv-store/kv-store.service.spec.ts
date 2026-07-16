import { describe, it, expect, vi } from 'vitest';
import { KvStoreService } from './kv-store.service.js';

/**
 * Fixed-window contract for incrWithExpire — the rate-limit primitive ThrottleGuard counts on.
 *
 * Regression guard: an earlier implementation called setex() on EVERY increment, which refreshed
 * the TTL each call and turned this into a SLIDING window. Under sustained load arriving faster
 * than the TTL (e.g. the Docker HEALTHCHECK at one probe / 30s with ttlSec=60) the key never
 * expired, the counter climbed without limit, and the endpoint permanently 429'd after `limit`
 * probes — never recovering, eventually marking a healthy container unhealthy. These tests pin the
 * FIXED-window semantics: the TTL is anchored at the first increment of a window and the count
 * resets at the boundary.
 */
describe('KvStoreService.incrWithExpire — fixed window', () => {
  it('resets at the TTL boundary even under sustained sub-TTL load (regression: was permanent 429)', async () => {
    vi.useFakeTimers();
    try {
      const kvStore = new KvStoreService();
      // One increment per 30s over 120s; ttlSec=60 → windows are [0,60) and [60,120).
      const counts: number[] = [];
      counts.push(await kvStore.incrWithExpire('rl:h', 60)); // t=0  → window A, count 1
      vi.advanceTimersByTime(30_000);
      counts.push(await kvStore.incrWithExpire('rl:h', 60)); // t=30 → window A, count 2
      vi.advanceTimersByTime(30_000);
      counts.push(await kvStore.incrWithExpire('rl:h', 60)); // t=60 → window A expired → new window, count 1
      vi.advanceTimersByTime(30_000);
      counts.push(await kvStore.incrWithExpire('rl:h', 60)); // t=90 → window B, count 2
      vi.advanceTimersByTime(30_000);
      counts.push(await kvStore.incrWithExpire('rl:h', 60)); // t=120 → window B expired → new window, count 1
      // Fixed window: oscillates 1,2,1,2,1 — never climbs. The old sliding bug yielded 1,2,3,4,5.
      expect(counts).toEqual([1, 2, 1, 2, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not refresh the TTL on increments within the window (the core of the fix)', async () => {
    vi.useFakeTimers();
    try {
      const kvStore = new KvStoreService();
      // First incr at t=0 anchors a 60s window ending at t=60.
      await kvStore.incrWithExpire('rl:ttl', 60);
      vi.advanceTimersByTime(30_000);
      await kvStore.incrWithExpire('rl:ttl', 60); // t=30, same window — must NOT push expiry to t=90
      // Advance to t=65. Sliding-window behavior would keep the key alive (expiry t=90) and the
      // next incr would be count 3; the fix expired the window at t=60 → count resets to 1.
      vi.advanceTimersByTime(35_000);
      expect(await kvStore.incrWithExpire('rl:ttl', 60)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still counts a genuine burst up past the limit within one window (rate limiting still works)', async () => {
    vi.useFakeTimers();
    try {
      const kvStore = new KvStoreService();
      // 65 increments with no time advancing → all within window A.
      const counts: number[] = [];
      for (let i = 0; i < 65; i++) counts.push(await kvStore.incrWithExpire('rl:burst', 60));
      expect(counts[0]).toBe(1);
      expect(counts[59]).toBe(60); // last allowed — ThrottleGuard rejects only when n > limit
      expect(counts[60]).toBe(61); // first to trip a limit of 60
      expect(counts[64]).toBe(65);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('KvStoreService KV basics', () => {
  it('setex/get round-trips and expires after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const kvStore = new KvStoreService();
      await kvStore.setex('k', 10, 'v');
      expect(await kvStore.get('k')).toBe('v');
      vi.advanceTimersByTime(9_999);
      expect(await kvStore.get('k')).toBe('v');
      vi.advanceTimersByTime(1);
      expect(await kvStore.get('k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('del removes keys and reports how many were deleted', async () => {
    const kvStore = new KvStoreService();
    await kvStore.setex('a', 60, '1');
    await kvStore.setex('b', 60, '2');
    expect(await kvStore.del('a', 'b', 'missing')).toBe(2);
    expect(await kvStore.get('a')).toBeNull();
  });
});
