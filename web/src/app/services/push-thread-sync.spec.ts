import 'fake-indexeddb/auto';
import { WebdbStorage } from './webdb-storage';
import { syncThreadFeed } from './thread-feed-sync';
import { syncPushThreads } from './push-thread-sync';
import { createP2PConversation, type Message } from './model';
import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';

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
      threadId: 7,
      threadFeedId: feed,
      messageEndSeq: 7,
      tombstoneEndSeq: 1,
      lastReadSeq: 0,
      unreadCount: 7,
      lastMentionSeq: 7,
      previews: [7, 6, 5, 4, 3].map((seq) => ({
        seq,
        createdAt: '2026-09-09T00:00:00Z',
        sender: { account: 'peer', domain: 'test' },
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
    storage = new WebdbStorage();
    await storage.openForUser(String(userId));
    await storage.putMeta('selfProfile', { id: userId, account: 'me' });
    await storage.putThread(
      createP2PConversation(7, { id: 2, account: 'peer', name: 'Peer' }),
    );
  });
  afterEach(async () => {
    await storage.closeAndDelete(String(userId));
  });

  it('requests five previews, keeps one in the database, and never repeats a consumed target', async () => {
    const request = vi.fn().mockResolvedValue(page());
    const result = await syncPushThreads(
      storage,
      userId,
      1,
      request,
      preferences,
      copy,
    );
    expect(request).toHaveBeenCalledWith({
      after: 0,
      through: 1,
      take: 100,
      previewCount: 5,
    });
    expect(result.notifications[0]).toMatchObject({
      count: 7,
      body: '3\n4\n5\n[Retracted]\n[Removed]',
    });
    expect(
      (await storage.getThreadStates())[0].server?.previews?.map((p) => p.seq),
    ).toEqual([7]);
    request.mockClear();
    expect(
      await syncPushThreads(storage, userId, 1, request, preferences, copy),
    ).toMatchObject({ consumed: false, notifications: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('rebases the server count using local read progress, counting tomb slots and excluding own messages', async () => {
    const message: Message = {
      threadId: 7,
      seq: 1,
      creator: { account: 'peer', domain: 'test', namespaceId: 1 },
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
        creator: { account: 'me', domain: 'local', namespaceId: 0 },
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
    await storage.advanceThreadRead(7, 2);
    const result = await syncPushThreads(
      storage,
      userId,
      1,
      async () => page(),
      preferences,
      copy,
    );
    expect(result.notifications[0]).toMatchObject({
      count: 6,
      attention: 'mention',
    });
    expect((await storage.getThreadStates())[0]).toMatchObject({
      localReadSeq: 2,
      server: { unreadCount: 7, lastReadSeq: 0 },
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
    const result = await syncPushThreads(
      storage,
      userId,
      2,
      request,
      preferences,
      copy,
    );
    expect(result).toMatchObject({
      cursor: 1,
      consumed: true,
      error: 'offline',
    });
    expect(result.notifications).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
