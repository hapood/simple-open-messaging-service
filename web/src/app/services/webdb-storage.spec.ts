import 'fake-indexeddb/auto';
import { WebdbStorage } from './webdb-storage';
import { WebdbService } from './webdb.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { syncThreadFeed } from './thread-feed-sync';

describe('shared background storage', () => {
  const userId = '9107';
  let storage: WebdbStorage;
  const groupMetaRequest = vi.fn(async () => {
    throw new Error('unexpected group-meta request');
  });
  const profileResolver = vi.fn(async () => false);

  beforeEach(() => {
    storage = new WebdbStorage();
  });
  afterEach(async () => {
    await storage.closeAndDelete(userId);
  });

  it('runs feed synchronization without an Angular injector or a nested worker', async () => {
    await storage.openForUser(userId);
    const result = await syncThreadFeed(
      storage,
      1,
      async () => ({
        code: 0,
        data: {
          items: [
            {
              threadId: 7,
              threadFeedId: 1,
              messageEndSeq: 2,
              tombstoneEndSeq: 0,
              groupMetaFeedEndId: null,
              joinRequestEndFeedId: 0,
              joinRequestReadFeedId: -1,
              groupInviteEndFeedId: 0,
              lastReadSeq: 0,
              unreadCount: 2,
              lastMentionSeq: null,
            },
          ],
          scannedThrough: 1,
          through: 1,
          threadFeedEndId: 1,
          hasMore: false,
        },
      }),
      groupMetaRequest,
      profileResolver,
    );
    expect(result.cursor).toBe(1);
    expect(result.states[0].server?.unreadCount).toBe(2);
    await storage.close();
    const page = new WebdbService(() => null);
    try {
      await page.openExistingForUser(userId);
      expect(await page.getMeta('threadFeedCursor')).toBe(1);
      expect((await page.getThreadStates())[0]).toEqual(result.states[0]);
    } finally {
      await page.close();
    }
  });

  it('does not create a missing account cache on the background existing-only path', async () => {
    await expect(storage.openExistingForUser(userId)).rejects.toThrow();
    expect(
      (await indexedDB.databases()).some((db) => db.name?.endsWith(userId)),
    ).toBe(false);
  });

  it('serializes cursor consumption across two account database owners', async () => {
    await storage.openForUser(userId);
    const background = new WebdbStorage();
    await background.openExistingForUser(userId);
    const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
    let tail: Promise<unknown> = Promise.resolve();
    const lock = vi.fn((_name: string, run: () => Promise<unknown>) => {
      const work = tail.then(run);
      tail = work.catch(() => {});
      return work;
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: lock },
    });
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [],
        scannedThrough: 1,
        through: 1,
        threadFeedEndId: 1,
        hasMore: false,
      },
    });
    try {
      await Promise.all([
        syncThreadFeed(storage, 1, request, groupMetaRequest, profileResolver),
        syncThreadFeed(
          background,
          1,
          request,
          groupMetaRequest,
          profileResolver,
        ),
      ]);
      expect(request).toHaveBeenCalledOnce();
      expect(lock.mock.calls.map((call) => call[0])).toEqual([
        'soms-thread-feed-' + userId,
        'soms-thread-feed-' + userId,
      ]);
    } finally {
      if (previous) Object.defineProperty(navigator, 'locks', previous);
      else Reflect.deleteProperty(navigator, 'locks');
      await background.close();
    }
  });

  it('retains the existing session invalidation gate', async () => {
    const lifetime = new SessionLifecycleService();
    storage = new WebdbStorage(() => null, lifetime);
    await storage.openForUser(userId);
    lifetime.invalidateSession();
    await expect(storage.getThreadStates()).rejects.toThrow();
    storage.dispose();
  });

  it('closes the background handle when another context deletes the cache and rejects a late response', async () => {
    await storage.openForUser(userId);
    const background = new WebdbStorage();
    await background.openExistingForUser(userId);
    let respond!: (value: unknown) => void;
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sync = syncThreadFeed(
      background,
      1,
      () => {
        started();
        return new Promise((resolve) => {
          respond = resolve;
        });
      },
      groupMetaRequest,
      profileResolver,
    );
    await requested;
    await storage.closeAndDelete(userId);
    expect(background.ready()).toBe(false);
    respond({
      code: 0,
      data: {
        items: [],
        scannedThrough: 1,
        through: 1,
        threadFeedEndId: 1,
        hasMore: false,
      },
    });
    expect(await sync).toMatchObject({
      cursor: 0,
      states: [],
      error: expect.any(String),
    });
    expect(
      (await indexedDB.databases()).some((db) => db.name?.endsWith(userId)),
    ).toBe(false);
    await background.close();
  });
});
