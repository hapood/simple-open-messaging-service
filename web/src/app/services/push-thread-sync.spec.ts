import 'fake-indexeddb/auto';
import { WebdbStorage } from './webdb-storage';
import { SessionLifecycleService } from './session-lifecycle.service';
import { syncThreadFeed } from './thread-feed-sync';
import { syncPushThreads } from './push-thread-sync';
import type { Message } from './model';
import {
  attentionSnapshot,
  type ThreadFeedSnapshot,
} from '../../../../shared/thread-attention';
import { threadStructure } from './thread-feed.test-helper';

describe('Push thread-feed synchronization', () => {
  let storage: WebdbStorage;
  const userId = 9307;
  const copy = {
    lang: 'en',
    privateBody: 'New message',
    retracted: '[Retracted]',
    removed: '[Removed]',
  };
  const preferences = { get: async <T>(): Promise<T | undefined> => undefined };
  function snapshot(feed = 1): ThreadFeedSnapshot {
    return {
      ...threadStructure(7, {
        profileAccount: 'peer',
        publisherNamespaceId: 0,
        profileRev: 0,
      }),
      threadId: 7,
      threadFeedId: feed,
      messageEndSeq: 7,
      tombstoneEndSeq: 1,
      alias: null,
      profileRev: 0,
      groupMetaFeedEndId: null,
      joinRequestEndFeedId: 0,
      joinRequestReadFeedId: -1,
      groupInviteEndFeedId: 0,
      announcementReadFeedId: 0,
      lastReadSeq: 0,
      unreadCount: 7,
      lastMentionSeq: 7,
      previews: [5, 6, 7].map((seq) => ({
        seq,
        createdAt: '2026-09-09T00:00:00Z',
        sender: { account: 'peer', profileNamespaceId: 0, profileRev: 1 },
        text: String(seq),
        status:
          seq === 7
            ? 'MODERATION_REMOVAL'
            : seq === 6
              ? 'USER_RETRACTION'
              : 'LIVE',
      })),
    };
  }
  const page = (
    state = snapshot(),
    through = state.threadFeedId,
    head = through,
  ) => ({
    code: 0,
    data: {
      items: [state],
      scannedThrough: state.threadFeedId,
      through,
      threadFeedEndId: head,
      hasMore: state.threadFeedId < through,
    },
  });
  beforeEach(async () => {
    storage = new WebdbStorage(() => null, new SessionLifecycleService());
    await storage.openForUser(String(userId));
    await storage.putMeta('selfProfile', {
      id: userId,
      account: 'me',
      domain: 'chat.example.test',
      namespaceId: 0,
    });
  });
  afterEach(async () => {
    await storage.closeAndDelete(String(userId));
  });

  it('does not invent a counterpart when the local conversation was removed', async () => {
    vi.spyOn(storage, 'getThreads').mockResolvedValue([]);
    const result = await syncPushThreads(storage, userId, 1, async () => page(), preferences, copy);
    expect(result.cursor).toBe(1);
    expect(result.notifications).toEqual([]);
  });

  it('requests three previews, keeps one in the database, and never repeats a consumed target', async () => {
    const request = vi.fn().mockResolvedValue(page());
    const result = await syncPushThreads(storage, userId, 1, request, preferences, copy);
    expect(request).toHaveBeenCalledWith({
      after: 0,
      through: 1,
      take: 100,
      previewCount: 3,
    });
    expect(result.states[0].threadFeedId).toBe(1);
    expect(result.notifications[0]).toMatchObject({
      count: 7,
      body: '5\n[Retracted]\n[Removed]',
    });
    expect(
      attentionSnapshot((await storage.getThreadStates())[0])?.previews?.map(
        (p) => p.seq,
      ),
    ).toEqual([7]);
    request.mockClear();
    expect(
      await syncPushThreads(storage, userId, 1, request, preferences, copy),
    ).toMatchObject({ consumed: false, notifications: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('continues after a service-worker push when the page worker starts', async () => {
    await syncPushThreads(storage, userId, 1, async () => page(), preferences, copy);
    await storage.close();
    storage = new WebdbStorage(() => null, new SessionLifecycleService());
    await storage.openExistingForUser(String(userId));
    const next = {
      ...snapshot(2),
      messageEndSeq: 8,
      unreadCount: 8,
      previews: [
        {
          seq: 8,
          createdAt: '2026-09-09T00:00:00Z',
          sender: { account: 'peer', profileNamespaceId: 0, profileRev: 1 },
          status: 'LIVE' as const,
          text: 'next',
        },
      ],
    };
    const request = vi.fn().mockResolvedValue(page(next));
    const result = await syncPushThreads(storage, userId, 2, request, preferences, copy);
    expect(request).toHaveBeenCalledWith({
      after: 1,
      through: 2,
      take: 100,
      previewCount: 3,
    });
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].body).toBe('next');
    const repeated = vi.fn();
    expect(
      (
        await syncPushThreads(storage, userId, 2, repeated, preferences, copy)
      ).notifications,
    ).toEqual([]);
    expect(repeated).not.toHaveBeenCalled();
  });

  it('uses the delivered alias for offline notifications and does not notify for alias-only changes', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(page({ ...snapshot(), alias: 'Offline label' }));
    const first = await syncPushThreads(storage, userId, 1, request, preferences, copy);
    expect(first.notifications[0].title).toBe('Offline label');
    request.mockResolvedValue(page({ ...snapshot(2), alias: null }));
    const cleared = await syncPushThreads(storage, userId, 2, request, preferences, copy);
    expect(cleared.cursor).toBe(2);
    expect(cleared.notifications).toEqual([]);
    expect((await storage.getThreads())[0].alias).toBeNull();
  });

  it('rebases the server count using local read progress, counting tomb slots and excluding own messages', async () => {
    const message: Message = {
      publisherNamespaceId: 0,
      originSeq: 1,
      threadId: 7,
      namespaceId: 0,
      seq: 1,
      creator: { account: 'peer', namespaceId: 1 },
      profileRev: 1,
      createdAt: 0,
      updatedAt: 0,
      contentType: 'PURE_TEXT',
      content: 'message',
      isDeleted: false,
      localState: 'READY',
    };
    await storage.putCachedMessages([
      message,
      {
        ...message,
        seq: 2,
        creator: { account: 'me', namespaceId: 0 },
      },
    ]);
    await storage.applyDeletedMessages(
      7,
      [
        {
          threadId: 7,
          messageSeq: 1,
          deletionSeq: 1,
          type: 'USER_RETRACTION',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      1,
    );
    await storage.mergeThreadStates([
      {
        ...snapshot(1),
        messageEndSeq: 2,
        unreadCount: 2,
        lastMentionSeq: null,
      },
    ]);
    await storage.advanceThreadRead(7, 2);
    const result = await syncPushThreads(storage, userId, 2, async () => page(snapshot(2)), preferences, copy);
    expect(result.error).toBeUndefined();
    expect(result.states).toHaveLength(1);
    expect(result.notifications[0]).toMatchObject({
      count: 6,
      attention: 'mention',
    });
    expect((await storage.getThreadStates())[0]).toMatchObject({
      localReadSeq: 2,
      unreadCount: 7,
      lastReadSeq: 0,
    });
  });

  it('does not notify when ordinary synchronization already consumed the target', async () => {
    await syncThreadFeed(storage, 1, async () => page());
    const request = vi.fn();
    expect(
      await syncPushThreads(storage, userId, 1, request, preferences, copy),
    ).toMatchObject({ consumed: false, notifications: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('delivers committed pages after a later page fails without retrying', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(snapshot(), 2))
      .mockRejectedValueOnce(new Error('offline'));
    const result = await syncPushThreads(storage, userId, 2, request, preferences, copy);
    expect(result).toMatchObject({
      cursor: 1,
      consumed: true,
      error: 'offline',
    });
    expect(result.notifications).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
