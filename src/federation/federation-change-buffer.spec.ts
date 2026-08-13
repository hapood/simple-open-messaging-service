import { describe, expect, it } from 'vitest';
import {
  FederationChangeBuffer,
  type FederationBufferedChange,
} from './federation-change-buffer.js';

function change(feedId: bigint): FederationBufferedChange {
  return {
    feedId,
    threadId: 2,
    messageId: feedId + 100n,
    messageSeq: Number(feedId),
  };
}

describe('FederationChangeBuffer', () => {
  it('is bounded and preserves entries rejected at capacity', () => {
    const buffer = new FederationChangeBuffer(3, 2);
    expect(buffer.append(change(1n))).toBe(true);
    expect(buffer.append(change(2n))).toBe(true);
    expect(buffer.append(change(3n))).toBe(true);
    expect(buffer.append(change(4n))).toBe(false);
    expect(buffer.full).toBe(true);
    expect(buffer.snapshot().map((entry) => entry.feedId)).toEqual([
      1n,
      2n,
      3n,
    ]);
  });

  it('reads exact retry pages without mutation', () => {
    const buffer = new FederationChangeBuffer(10, 2);
    for (let id = 1n; id <= 5n; id++) buffer.append(change(id));
    expect(buffer.readAfter(2n, 2).map((entry) => entry.feedId)).toEqual([
      3n,
      4n,
    ]);
    expect(buffer.readAfter(2n, 2).map((entry) => entry.feedId)).toEqual([
      3n,
      4n,
    ]);
    expect(buffer.size).toBe(5);
  });

  it('retires acknowledged chunks and accepts new tail entries', () => {
    const buffer = new FederationChangeBuffer(5, 2);
    for (let id = 1n; id <= 5n; id++) buffer.append(change(id));
    expect(buffer.retireThrough(3n).map((entry) => entry.feedId)).toEqual([
      1n,
      2n,
      3n,
    ]);
    expect(buffer.append(change(6n))).toBe(true);
    expect(buffer.append(change(7n))).toBe(true);
    expect(buffer.snapshot().map((entry) => entry.feedId)).toEqual([
      4n,
      5n,
      6n,
      7n,
    ]);
  });

  it('rejects non-monotonic ids', () => {
    const buffer = new FederationChangeBuffer();
    buffer.append(change(2n));
    expect(() => buffer.append(change(2n))).toThrow(/increasing/);
  });
});
