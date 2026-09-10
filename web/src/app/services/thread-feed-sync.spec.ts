import { describe, expect, it, vi } from 'vitest';
import { syncThreadFeed, coalesceThreadFeedWakes } from './thread-feed-sync';
import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';

const snapshot = (feedId: number): ThreadFeedSnapshot => ({
  threadId: 7,
  threadFeedId: feedId,
  messageEndSeq: feedId,
  tombstoneEndSeq: 0,
  lastReadSeq: 0,
  unreadCount: feedId,
  lastMentionSeq: null,
});

function storage() {
  let cursor = 0;
  return {
    getMeta: vi.fn(async () => cursor),
    mergeThreadStates: vi.fn(
      async (states: ThreadFeedSnapshot[], next: number) => {
        cursor = next;
        return states.map((server) => ({
          threadId: server.threadId,
          server,
          localReadSeq: 0,
        }));
      },
    ),
  };
}

function page(
  scannedThrough: number,
  through: number,
  head = through,
  items = [snapshot(scannedThrough)],
) {
  return {
    code: 0,
    data: {
      items,
      scannedThrough,
      through,
      threadFeedEndId: head,
      hasMore: scannedThrough < through,
    },
  };
}

describe('thread feed executor', () => {
  it('ignores a notification wake already consumed by ordinary synchronization', async () => {
    const db = storage();
    const ordinary = vi.fn().mockResolvedValue(page(5, 5));
    await syncThreadFeed(db, 5, ordinary);
    expect(ordinary).toHaveBeenCalledWith({
      after: 0,
      through: 5,
      take: 100,
      previewCount: 1,
    });
    const notification = vi.fn();
    for (const target of [5, 4]) {
      expect(await syncThreadFeed(db, target, notification, 5)).toEqual({
        cursor: 5,
        states: [],
      });
    }
    expect(notification).not.toHaveBeenCalled();
  });

  it('uses five previews on every notification page and shares durable progress', async () => {
    const db = storage();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1, 2))
      .mockResolvedValueOnce(page(2, 2));
    await syncThreadFeed(db, 2, request, 5);
    expect(request.mock.calls.map(([body]) => body.previewCount)).toEqual([
      5, 5,
    ]);
    const ordinary = vi.fn();
    expect(await syncThreadFeed(db, 2, ordinary)).toEqual({
      cursor: 2,
      states: [],
    });
    expect(ordinary).not.toHaveBeenCalled();
  });

  it('coalesces queued wakes and does not automatically retry a failed run', async () => {
    const tasks: Array<() => Promise<void>> = [];
    const run = vi.fn().mockResolvedValue(undefined);
    const wake = coalesceThreadFeedWakes((task) => tasks.push(task), run);
    wake(2);
    wake(5);
    wake(3);
    expect(tasks).toHaveLength(1);
    await tasks.shift()!();
    expect(run).toHaveBeenCalledWith(5);
    expect(tasks).toHaveLength(0);
    run.mockRejectedValueOnce(new Error('offline'));
    wake(5);
    await expect(tasks.shift()!()).rejects.toThrow('offline');
    expect(tasks).toHaveLength(0);
    wake(5);
    expect(tasks).toHaveLength(1);
  });

  it('preserves a wake arriving while a drain is in flight', async () => {
    const tasks: Array<() => Promise<void>> = [];
    let finish!: () => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const wake = coalesceThreadFeedWakes((task) => tasks.push(task), run);
    wake(2);
    const running = tasks.shift()!();
    wake(3);
    wake(7);
    expect(tasks).toHaveLength(0);
    finish();
    await running;
    expect(tasks).toHaveLength(1);
    await tasks.shift()!();
    expect(run.mock.calls.map(([target]) => target)).toEqual([2, 7]);
  });
  it('owns pagination, follows the new head, and coalesces committed snapshots by thread', async () => {
    const db = storage();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1, 2))
      .mockResolvedValueOnce(page(2, 2, 3))
      .mockResolvedValueOnce(page(3, 3));
    const result = await syncThreadFeed(db, 2, request);
    expect(
      request.mock.calls.map(([body]) => [body.after, body.through]),
    ).toEqual([
      [0, 2],
      [1, 2],
      [2, 3],
    ]);
    expect(result).toEqual({
      cursor: 3,
      states: [{ threadId: 7, server: snapshot(3), localReadSeq: 0 }],
    });
    expect(await db.getMeta()).toBe(3);
  });

  it('returns committed pages on failure without retrying and resumes from durable progress on the next wake', async () => {
    const db = storage();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1, 2))
      .mockRejectedValueOnce(new Error('offline'));
    const result = await syncThreadFeed(db, 2, request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      cursor: 1,
      error: 'offline',
      states: [{ server: { threadFeedId: 1 } }],
    });
    const resumed = vi.fn().mockResolvedValue(page(2, 2));
    expect(await syncThreadFeed(db, 2, resumed)).toMatchObject({ cursor: 2 });
    expect(resumed).toHaveBeenCalledWith({
      after: 1,
      through: 2,
      take: 100,
      previewCount: 1,
    });
  });

  it('does not advance progress when the page transaction fails', async () => {
    const db = storage();
    db.mergeThreadStates.mockRejectedValueOnce(new Error('transaction failed'));
    const result = await syncThreadFeed(
      db,
      1,
      vi.fn().mockResolvedValue(page(1, 1)),
    );
    expect(result).toEqual({
      cursor: 0,
      states: [],
      error: 'transaction failed',
    });
    expect(await db.getMeta()).toBe(0);
  });

  it('advances compacted empty pages and skips requests when already caught up', async () => {
    const db = storage();
    const request = vi.fn().mockResolvedValue(page(5, 5, 5, []));
    expect(await syncThreadFeed(db, 5, request)).toEqual({
      cursor: 5,
      states: [],
    });
    await syncThreadFeed(db, 5, request);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects unordered snapshots before any commit', async () => {
    const db = storage();
    const request = vi
      .fn()
      .mockResolvedValue(page(2, 2, 2, [snapshot(2), snapshot(1)]));
    expect(await syncThreadFeed(db, 2, request)).toMatchObject({
      cursor: 0,
      error: 'unordered thread feed page',
    });
    expect(db.mergeThreadStates).not.toHaveBeenCalled();
  });
});
