import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { WebdbStorage } from './webdb-storage';
import { synchronizeStateFeed } from './worker-state-feed-sync';
import type { ClientStateFeedItem } from './user.service';

function storage(start = 0) {
  let cursor = start;
  let boundary: number | undefined;
  return {
    getSyncState: vi.fn(async (key: string) =>
      key === 'stateFeedId'
        ? cursor
        : key === 'stateFeedFullThrough'
          ? boundary
          : undefined,
    ),
    applyStateFeedPage: vi.fn(
      async (
        _items: ClientStateFeedItem[],
        next: number,
        _reset: boolean,
        full?: number | null,
      ) => {
        cursor = next;
        if (full !== undefined) boundary = full ?? undefined;
      },
    ),
  };
}

function page(mode: 'full' | 'delta', scannedThrough: number, through: number) {
  return {
    code: 0,
    data: {
      mode,
      items: [],
      scannedThrough,
      stateFeedEndId: through,
      hasMore: scannedThrough < through,
    },
  };
}

describe('database-worker state-feed executor', () => {
  it('commits the full boundary and cursor atomically in IndexedDB', async () => {
    const db = new WebdbStorage();
    await db.openForUser('94082');
    try {
      await db.applyStateFeedPage([], 1, true, 3);
      expect(await db.getSyncState('stateFeedFullThrough')).toBe(3);
      expect(await db.getSyncState('stateFeedId')).toBe(1);
      await expect(db.applyStateFeedPage([], 2, false, 1)).rejects.toThrow(
        'invalid state-feed full boundary',
      );
      expect(await db.getSyncState('stateFeedId')).toBe(1);
      await db.applyStateFeedPage([], 3, false, null);
      expect(await db.getSyncState('stateFeedFullThrough')).toBeUndefined();
      expect(await db.getSyncState('stateFeedId')).toBe(3);
    } finally {
      await db.closeAndDelete('94082');
    }
  });
  it('persists the full boundary until the last page and ignores an already consumed wake', async () => {
    const db = storage();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page('full', 1, 3))
      .mockResolvedValueOnce(page('full', 3, 3));
    expect(await synchronizeStateFeed(db, 3, request)).toBe(3);
    expect(request.mock.calls.map(([query]) => query)).toEqual([
      { mode: 'full', after: 0, through: 3, take: 100 },
      { mode: 'full', after: 1, through: 3, take: 100 },
    ]);
    expect(
      db.applyStateFeedPage.mock.calls.map(([, cursor, reset, full]) => [
        cursor,
        reset,
        full,
      ]),
    ).toEqual([
      [1, true, 3],
      [3, false, null],
    ]);
    expect(await synchronizeStateFeed(db, 3, request)).toBe(3);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('resumes an interrupted full snapshot instead of turning its next page into a delta', async () => {
    const db = storage();
    const failed = vi
      .fn()
      .mockResolvedValueOnce(page('full', 1, 3))
      .mockRejectedValueOnce(new Error('offline'));
    await expect(synchronizeStateFeed(db, 3, failed)).rejects.toThrow(
      'offline',
    );
    expect(await db.getSyncState('stateFeedFullThrough')).toBe(3);
    const retry = vi.fn().mockResolvedValue(page('full', 3, 3));
    expect(await synchronizeStateFeed(db, 3, retry)).toBe(3);
    expect(retry).toHaveBeenCalledWith({
      mode: 'full',
      after: 1,
      through: 3,
      take: 100,
    });
  });

  it('rebuilds the current projection after a rejected cursor without replaying old pages', async () => {
    const db = storage(8);
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        code: 30006,
        data: { resumeAfter: 0, resumeBefore: 3 },
      })
      .mockResolvedValueOnce(page('full', 2, 2));
    expect(await synchronizeStateFeed(db, 9, request)).toBe(2);
    expect(db.applyStateFeedPage).toHaveBeenCalledWith([], 2, true, null);
    expect(await db.getSyncState('stateFeedId')).toBe(2);
  });

  it('rejects a stalled page without advancing the local cursor', async () => {
    const db = storage(1);
    await expect(
      synchronizeStateFeed(db, 2, async () => page('delta', 1, 2)),
    ).rejects.toThrow('invalid state-feed page');
    expect(db.applyStateFeedPage).not.toHaveBeenCalled();
  });
});
