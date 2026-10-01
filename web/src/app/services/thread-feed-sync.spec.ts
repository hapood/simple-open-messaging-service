import { describe, expect, it, vi } from 'vitest';
import { syncThreadFeed } from './thread-feed-sync';
import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';
import { threadStructure } from './thread-feed.test-helper';

const groupMetaRequest = vi.fn(async () => {
  throw new Error('unexpected group-meta request');
});
const profileResolver = vi.fn(async () => false);

const snapshot = (feedId: number): ThreadFeedSnapshot => ({
  ...threadStructure(7, {
    profile: {
      account: 'peer',
      domain: 'local',
      namespaceId: 0,
      profileRev: 0,
    },
  }),
  threadId: 7,
  threadFeedId: feedId,
  messageEndSeq: feedId,
  tombstoneEndSeq: 0,
  alias: null,
  threadProfileRev: 0,
  groupMetaFeedEndId: null,
  joinRequestEndFeedId: 0,
  joinRequestReadFeedId: -1,
  groupInviteEndFeedId: 0,
  announcementReadFeedId: 0,
  lastReadSeq: 0,
  unreadCount: feedId,
  lastMentionSeq: null,
});

function storage() {
  let cursor = 0;
  return {
    getThreads: vi.fn(async () => []),
    getThreadStates: vi.fn(async () => []),
    getUnresolvedGroupMetaProfiles: vi.fn(async () => []),
    beginGroupMetaRecovery: vi.fn(async () => undefined),
    applyGroupMetaPage: vi.fn(async () => undefined),
    getMeta: vi.fn(async () => cursor),
    mergeThreadStates: vi.fn(
      async (states: ThreadFeedSnapshot[], next: number) => {
        cursor = next;
        return states.map((snapshot) => ({
          ...snapshot,
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
  it('ignores a wake already consumed by an earlier synchronization', async () => {
    const db = storage();
    const initial = vi.fn().mockResolvedValue(page(5, 5));
    await syncThreadFeed(db, 5, initial, groupMetaRequest, profileResolver);
    expect(initial).toHaveBeenCalledWith({
      after: 0,
      through: 5,
      take: 100,
      previewCount: 3,
    });
    const repeated = vi.fn();
    for (const target of [5, 4]) {
      expect(
        await syncThreadFeed(
          db,
          target,
          repeated,
          groupMetaRequest,
          profileResolver,
        ),
      ).toEqual({
        cursor: 5,
        groupThreadIds: [],
        states: [],
      });
    }
    expect(repeated).not.toHaveBeenCalled();
  });

  it('uses three previews on every page and shares durable progress', async () => {
    const db = storage();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1, 2))
      .mockResolvedValueOnce(page(2, 2));
    await syncThreadFeed(db, 2, request, groupMetaRequest, profileResolver);
    expect(request.mock.calls.map(([body]) => body.previewCount)).toEqual([
      3, 3,
    ]);
    const repeated = vi.fn();
    expect(
      await syncThreadFeed(db, 2, repeated, groupMetaRequest, profileResolver),
    ).toEqual({
      cursor: 2,
      groupThreadIds: [],
      states: [],
    });
    expect(repeated).not.toHaveBeenCalled();
  });

  it('owns pagination, follows the new head, and coalesces committed snapshots by thread', async () => {
    const db = storage();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1, 2))
      .mockResolvedValueOnce(page(2, 2, 3))
      .mockResolvedValueOnce(page(3, 3));
    const result = await syncThreadFeed(
      db,
      2,
      request,
      groupMetaRequest,
      profileResolver,
    );
    expect(
      request.mock.calls.map(([body]) => [body.after, body.through]),
    ).toEqual([
      [0, 2],
      [1, 2],
      [2, 3],
    ]);
    expect(result).toEqual({
      cursor: 3,
      groupThreadIds: [],
      states: [{ ...snapshot(3), localReadSeq: 0 }],
    });
    expect(await db.getMeta()).toBe(3);
  });

  it('returns committed pages on failure without retrying and resumes from durable progress on the next wake', async () => {
    const db = storage();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(1, 2))
      .mockRejectedValueOnce(new Error('offline'));
    const result = await syncThreadFeed(
      db,
      2,
      request,
      groupMetaRequest,
      profileResolver,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      cursor: 1,
      error: 'offline',
      states: [{ threadFeedId: 1 }],
    });
    const resumed = vi.fn().mockResolvedValue(page(2, 2));
    expect(
      await syncThreadFeed(db, 2, resumed, groupMetaRequest, profileResolver),
    ).toMatchObject({ cursor: 2 });
    expect(resumed).toHaveBeenCalledWith({
      after: 1,
      through: 2,
      take: 100,
      previewCount: 3,
    });
  });

  it('does not advance progress when the page transaction fails', async () => {
    const db = storage();
    db.mergeThreadStates.mockRejectedValueOnce(new Error('transaction failed'));
    const result = await syncThreadFeed(
      db,
      1,
      vi.fn().mockResolvedValue(page(1, 1)),
      groupMetaRequest,
      profileResolver,
    );
    expect(result).toEqual({
      cursor: 0,
      groupThreadIds: [],
      states: [],
      error: 'transaction failed',
    });
    expect(await db.getMeta()).toBe(0);
  });

  it('advances compacted empty pages and skips requests when already caught up', async () => {
    const db = storage();
    const request = vi.fn().mockResolvedValue(page(5, 5, 5, []));
    expect(
      await syncThreadFeed(db, 5, request, groupMetaRequest, profileResolver),
    ).toEqual({
      cursor: 5,
      groupThreadIds: [],
      states: [],
    });
    await syncThreadFeed(db, 5, request, groupMetaRequest, profileResolver);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects unordered snapshots before any commit', async () => {
    const db = storage();
    const request = vi
      .fn()
      .mockResolvedValue(page(2, 2, 2, [snapshot(2), snapshot(1)]));
    expect(
      await syncThreadFeed(db, 2, request, groupMetaRequest, profileResolver),
    ).toMatchObject({
      cursor: 0,
      error: 'unordered thread feed page',
    });
    expect(db.mergeThreadStates).not.toHaveBeenCalled();
  });
});
