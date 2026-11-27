import { describe, expect, it, vi } from 'vitest';
import { WebdbStorage } from './webdb-storage';
import { SessionLifecycleService } from './session-lifecycle.service';
import { synchronizeStateFeed } from './worker-state-feed-sync';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import type { AccountState } from '../../../../shared/account-state';
import type { ClientStateFeedItem } from './user.service';

function accountState(overrides: Partial<AccountState>): AccountState {
  return {
    selfProfile: null,
    selfIdentity: null,
    composerDrafts: [],
    threadFeedCursor: null,
    stateFeedId: null,
    stateFeedFullThrough: null,
    stateFeedTarget: 0,
    profileNamespaceChangeEndId: null,
    intentRequestEndId: null,
    intentRequestReadId: null,
    intentRequestOptimisticReadId: null,
    ...overrides,
  };
}

function storage(start = 0) {
  let cursor = start;
  let boundary: number | undefined;
  let target = 0;
  return {
    advanceStateFeedTarget: vi.fn(async (incoming: number) => { target = Math.max(target, incoming); }),
    readAccountState: vi.fn(async () =>
      accountState({
        stateFeedId: cursor === 0 ? null : cursor,
        stateFeedFullThrough: boundary ?? null,
        stateFeedTarget: target,
      }),
    ),
    applyStateFeedPage: vi.fn(
      async (
        _items: ClientStateFeedItem[],
        next: number,
        full?: number,
        incomingTarget?: number,
      ) => {
        cursor = next;
        if (full !== undefined) boundary = Math.max(boundary ?? 0, full);
        if (incomingTarget !== undefined) target = Math.max(target, incomingTarget);
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
    const db = new WebdbStorage(() => null, new SessionLifecycleService());
    const cache = await prepareTestSessionCache();
    db.bindSessionCache(cache);
    await db.openForUser('94082');
    try {
      await db.applyStateFeedPage([], 1, 3, 5);
      expect((await db.readAccountState()).stateFeedFullThrough).toBe(3);
      expect((await db.readAccountState()).stateFeedId).toBe(1);
      await expect(db.applyStateFeedPage([], 2, -1)).rejects.toThrow(
        'invalid state-feed full boundary',
      );
      expect((await db.readAccountState()).stateFeedId).toBe(1);
      await db.applyStateFeedPage([], 3, 3, 3);
      expect((await db.readAccountState()).stateFeedFullThrough).toBe(3);
      expect((await db.readAccountState()).stateFeedTarget).toBe(5);
      expect((await db.readAccountState()).stateFeedId).toBe(3);
    } finally {
      await db.closeAndDelete('94082');
    }
  });
  it('retains the full boundary after the last page and ignores an already consumed wake', async () => {
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
      db.applyStateFeedPage.mock.calls.map(([, cursor, full, target]) => [
        cursor,
        full,
        target,
      ]),
    ).toEqual([
      [1, 3, 3],
      [3, 3, 3],
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
    expect((await db.readAccountState()).stateFeedFullThrough).toBe(3);
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
      .mockResolvedValueOnce(page('full', 2, 2))
      .mockResolvedValueOnce(page('delta', 9, 9));
    expect(await synchronizeStateFeed(db, 9, request)).toBe(9);
    expect(db.applyStateFeedPage).toHaveBeenCalledWith([], 0, 2, 9);
    expect((await db.readAccountState()).stateFeedId).toBe(9);
    expect((await db.readAccountState()).stateFeedTarget).toBe(9);
  });

  it('rejects a stalled page without advancing the local cursor', async () => {
    const db = storage(1);
    await expect(
      synchronizeStateFeed(db, 2, async () => page('delta', 1, 2)),
    ).rejects.toThrow('invalid state-feed page');
    expect(db.applyStateFeedPage).not.toHaveBeenCalled();
  });
});
