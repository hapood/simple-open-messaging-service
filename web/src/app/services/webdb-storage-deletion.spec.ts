import {
  createMessageDeletionMarker,
  messageTomb,
} from '../../../../shared/message-tomb';
import type { DeletedMessageItem, Message } from './model';
import { SessionLifecycleService } from './session-lifecycle.service';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import type { SessionCacheDescriptor } from './session/session-identity';
import { threadFeedSnapshot } from './thread-feed.test-helper';
import { syncTombstoneThread } from './tombstone-sync';
import { WebdbStorage } from './webdb-storage';

const snapshot = (tombstoneEndSeq: number, threadFeedId = 1) =>
  threadFeedSnapshot(42, {
    publisherNamespaceId: 3,
    profileAccount: 'alice',
    profileRev: 1,
    messageEndSeq: 10,
    tombstoneEndSeq,
    threadFeedId,
  });

const message = (seq = 4): Message => ({
  threadId: 42,
  seq,
  publisherNamespaceId: 3,
  profileNamespaceId: 0,
  namespaceId: 0,
  originSeq: seq,
  creator: { account: 'alice', namespaceId: 0 },
  profileRev: 1,
  createdAt: 100,
  updatedAt: 100,
  contentType: 'PURE_TEXT',
  content: 'private body',
  isDeleted: false,
  localState: 'READY',
});

const deletion = (messageSeq = 4, deletionSeq = 8): DeletedMessageItem => ({
  threadId: 42,
  messageSeq,
  deletionSeq,
  type: 'USER_RETRACTION',
  createdAt: 200,
  updatedAt: 200,
});

describe('durable browser deletion state', () => {
  const userId = '9142';
  let storage: WebdbStorage;
  let session: SessionCacheDescriptor;

  beforeEach(async () => {
    storage = new WebdbStorage(() => null, new SessionLifecycleService());
    session = await prepareTestSessionCache();
    storage.bindSessionCache(session);
    await storage.openForUser(userId);
  });

  afterEach(async () => {
    await storage.closeAndDelete(userId);
  });

  it.each([0, 7])(
    'initializes deletion progress from creation end %s only',
    async (end) => {
      await storage.mergeThreadStates([snapshot(end)], 1);
      expect(await storage.getDeletedHwm(42)).toBe(end);
      expect(await storage.getMessageHead(42)).toBeUndefined();
      expect(await (await storage.db()).get('threads', 42)).toMatchObject({
        deletedHwm: end,
        messageHead: null,
      });
      const request = vi.fn();
      expect(await syncTombstoneThread(storage, request, 42, end)).toEqual([]);
      expect(request).not.toHaveBeenCalled();

      await storage.mergeThreadStates([snapshot(12, 2)], 2);
      expect(await storage.getDeletedHwm(42)).toBe(end);
      await storage.applyDeletedMessages(42, [deletion()], 8);
      await storage.putMessageHead(42, 10);
      await storage.mergeThreadStates([snapshot(15, 3)], 3);
      await storage.mergeThreadStates([snapshot(end)], 1);
      await storage.patchThread(42, { muted: true });
      await storage.advanceThreadRead(42, 5);
      await storage.putMessageHead(42, 6);
      await storage.applyDeletedMessages(42, [], 2);
      await storage.close();
      await storage.openExistingForUser(userId);
      expect(await storage.getDeletedHwm(42)).toBe(8);
      expect(await storage.getMessageHead(42)).toBe(10);
      expect(await (await storage.db()).get('threads', 42)).toMatchObject({
        tombstoneEndSeq: 15,
        deletedHwm: 8,
        messageHead: 10,
        localReadSeq: 5,
        muted: true,
      });
    },
  );

  it('rejects missing thread progress without fabricating a thread or tomb', async () => {
    await expect(storage.getDeletedHwm(42)).rejects.toThrow(
      'missing required deleted-message HWM',
    );
    await expect(storage.getMessageHead(42)).rejects.toThrow('missing thread');
    await expect(
      storage.applyDeletedMessages(42, [deletion()], 8),
    ).rejects.toThrow('missing required deleted-message HWM');
    const request = vi.fn();
    await expect(syncTombstoneThread(storage, request, 42, 0)).rejects.toThrow(
      'missing required deleted-message HWM',
    );
    expect(request).not.toHaveBeenCalled();
    expect(await (await storage.db()).get('threads', 42)).toBeUndefined();
    expect(await storage.getMessageDeletions(42, [4])).toEqual([]);
  });

  it('rejects a missing persisted HWM rather than repairing it from a later feed end', async () => {
    await storage.mergeThreadStates([snapshot(7)], 1);
    const db = await storage.db();
    const row = (await db.get('threads', 42))!;
    // Deliberate corruption: current rows require this field, even when it is zero.
    const corrupted = { ...row };
    Reflect.deleteProperty(corrupted, 'deletedHwm');
    await db.put('threads', corrupted);
    await expect(storage.getDeletedHwm(42)).rejects.toThrow(
      'missing required deleted-message HWM',
    );
    await expect(
      storage.applyDeletedMessages(42, [deletion()], 8),
    ).rejects.toThrow('missing required deleted-message HWM');
    await expect(
      storage.mergeThreadStates([snapshot(12, 2)], 2),
    ).rejects.toThrow('missing required deleted-message HWM');
    expect(await db.get('threads', 42)).toEqual(corrupted);
    expect((await storage.readAccountState()).threadFeedCursor).toBe(1);
    expect(await storage.getMessageDeletions(42, [4])).toEqual([]);
  });

  it.each(['thread', 'database'] as const)(
    'preserves cursors and feed/history tomb guards after %s cache eviction',
    async (kind) => {
      await storage.mergeThreadStates([snapshot(7)], 1);
      const historyTomb = messageTomb(message(5), 'MODERATION_REMOVAL');
      await storage.commitBrowserMessagePage({
        threadId: 42,
        scan: { left: 3, right: 6 },
        messages: [message(), historyTomb, message(6)],
        gaps: [],
        knownNewestSeq: 10,
      });
      await storage.applyDeletedMessages(42, [deletion()], 8);
      if (kind === 'thread') await storage.deleteMessagesByThread(42);
      else await storage.recreateMessageCache();
      expect(await storage.queryCachedMessages(42, 'asc', 10)).toEqual([]);
      expect(
        await storage.countUnreadMessageSlots(42, 0, 10, {
          account: 'me',
          namespaceId: 0,
        }),
      ).toBe(0);
      expect(await storage.getMessageRanges(42)).toEqual([]);
      expect(await storage.getMessageHead(42)).toBe(10);
      expect(await storage.getDeletedHwm(42)).toBe(8);
      expect(await storage.getMessageDeletions(42, [4, 5, 6])).toEqual([
        { seq: 4, type: 'USER_RETRACTION' },
        { seq: 5, type: 'MODERATION_REMOVAL' },
      ]);
      await storage.close();
      await storage.openExistingForUser(userId);
      await storage.putCachedMessages([message(), message(5)]);
      const committed = await storage.commitBrowserMessagePage({
        threadId: 42,
        scan: { left: 3, right: 6 },
        messages: [message(), message(5), message(6)],
        gaps: [],
        knownNewestSeq: 6,
      });
      expect(committed.messages).toEqual([message(6)]);
      expect(await storage.getMessage(42, 4)).toBeUndefined();
      expect(await storage.getMessageByOrigin(42, 3, 5)).toBeUndefined();
      expect(await storage.getNewestMessages([42])).toEqual([message(6)]);
      expect(await storage.getMessageHead(42)).toBe(10);
      expect(await storage.getDeletedHwm(42)).toBe(8);
    },
  );

  it.each(['live-first', 'tomb-first'] as const)(
    'serializes %s commits across independent database owners',
    async (order) => {
      await storage.mergeThreadStates([snapshot(0)]);
      const background = new WebdbStorage(
        () => null,
        new SessionLifecycleService(),
      );
      background.bindSessionCache(session);
      await background.openExistingForUser(userId);
      const lock = vi.spyOn(navigator.locks, 'request');
      const live = () =>
        storage.commitBrowserMessagePage({
          threadId: 42,
          scan: { left: 3, right: 4 },
          messages: [message()],
          gaps: [],
          knownNewestSeq: 10,
        });
      const tomb = () => background.applyDeletedMessages(42, [deletion()], 8);
      try {
        await Promise.all(
          order === 'live-first' ? [live(), tomb()] : [tomb(), live()],
        );
        expect(lock.mock.calls.map(([name]) => name)).toEqual([
          `soms-message-commit-${userId}-42`,
          `soms-message-commit-${userId}-42`,
        ]);
        expect(await storage.getDeletedHwm(42)).toBe(8);
        expect(await background.getMessageHead(42)).toBe(10);
        expect(await storage.getMessage(42, 4)).toBeUndefined();
        expect(await storage.queryCachedMessages(42, 'asc', 10)).toEqual([]);
        expect(await (await storage.db()).get('messages', [42, 4])).toEqual(
          createMessageDeletionMarker(42, 4, 'USER_RETRACTION'),
        );
      } finally {
        lock.mockRestore();
        await background.close();
      }
    },
  );

  it('skips deletion markers before ordering, anchors, limits, and unread counting', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    await storage.putCachedMessages([
      messageTomb(message(2), 'USER_RETRACTION'),
      messageTomb(
        { ...message(4), creator: { account: 'me', namespaceId: 0 } },
        'USER_RETRACTION',
      ),
      messageTomb(message(6), 'MODERATION_REMOVAL'),
    ]);
    await storage.applyDeletedMessages(42, [deletion(3)], 8);
    await storage.recreateMessageCache();
    await storage.putCachedMessages([message(1), message(5), message(7)]);
    expect(
      (await storage.queryCachedMessages(42, 'asc', 3)).map((row) => row.seq),
    ).toEqual([1, 5, 7]);
    expect(
      (await storage.queryCachedMessages(42, 'desc', 3)).map((row) => row.seq),
    ).toEqual([7, 5, 1]);
    expect(
      (await storage.queryCachedMessages(42, 'asc', 2, 2)).map(
        (row) => row.seq,
      ),
    ).toEqual([5, 7]);
    expect(
      (await storage.queryCachedMessages(42, 'desc', 2, 6)).map(
        (row) => row.seq,
      ),
    ).toEqual([5, 1]);
    expect(
      await storage.countUnreadMessageSlots(42, 1, 6, {
        account: 'me',
        namespaceId: 0,
      }),
    ).toBe(1);
    expect(
      await storage.countUnreadMessageSlots(99, 0, 10, {
        account: 'me',
        namespaceId: 0,
      }),
    ).toBe(0);
  });

  it('skips invisible markers across multiple bounded batches without consuming take', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    await storage.putCachedMessages(
      Array.from({ length: 120 }, (_, i) =>
        messageTomb(message(i * 2 + 2), 'USER_RETRACTION'),
      ),
    );
    await storage.recreateMessageCache();
    await storage.putCachedMessages(
      Array.from({ length: 240 }, (_, i) => message(i + 1)),
    );
    const cursorContinue = vi.spyOn(IDBCursor.prototype, 'continue');
    const bulkRead = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const rows = await storage.queryCachedMessages(42, 'desc', 240);
    // Timeline reads must transfer bounded batches, not round-trip every slot.
    expect(cursorContinue).not.toHaveBeenCalled();
    expect(bulkRead).toHaveBeenCalled();
    expect(bulkRead.mock.calls.every(([, count]) => count === 100)).toBe(true);
    cursorContinue.mockRestore();
    bulkRead.mockRestore();
    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: 120 }, (_, i) => 239 - i * 2),
    );
    expect(rows.filter((row) => row.isDeleted)).toHaveLength(0);
    for (const take of [99, 100, 101]) {
      expect(
        (await storage.queryCachedMessages(42, 'desc', take, 201)).map(
          (row) => row.seq,
        ),
      ).toEqual(
        Array.from({ length: Math.min(take, 100) }, (_, i) => 199 - i * 2),
      );
      expect(
        (await storage.queryCachedMessages(42, 'asc', take, 40)).map(
          (row) => row.seq,
        ),
      ).toEqual(
        Array.from({ length: Math.min(take, 100) }, (_, i) => 41 + i * 2),
      );
    }
    expect(
      await storage.countUnreadMessageSlots(42, 0, 240, {
        account: 'me',
        namespaceId: 0,
      }),
    ).toBe(120);
    await storage.recreateMessageCache();
    expect(
      (await storage.queryCachedMessages(42, 'asc', 120)).map((row) => row.seq),
    ).toEqual([]);
    expect(
      await storage.countUnreadMessageSlots(42, 0, 240, {
        account: 'me',
        namespaceId: 0,
      }),
    ).toBe(0);
  });

  it('folds repeated identities in order within a batched cache write', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    const messages = [
      message(1),
      messageTomb(message(1), 'USER_RETRACTION'),
      { ...message(1), updatedAt: 300 },
      messageTomb(message(1), 'MODERATION_REMOVAL'),
      message(2),
      { ...message(2), content: 'latest body' },
    ];
    await storage.putCachedMessages(messages);
    expect(await storage.queryCachedMessages(42, 'asc', 10)).toEqual([
      { ...message(2), content: 'latest body' },
    ]);
    await storage.applyDeletedMessages(
      42,
      [deletion(2, 1), { ...deletion(2, 2), type: 'MODERATION_REMOVAL' }],
      2,
    );
    await storage.recreateMessageCache();
    expect(await storage.queryCachedMessages(42, 'desc', 10)).toEqual([]);
    expect(await storage.getDeletedHwm(42)).toBe(2);
  });

  it.each(['caller', 'reset', 'close'] as const)(
    'cancels a queued cross-context commit on %s without waiting for the external holder',
    async (kind) => {
      await storage.mergeThreadStates([snapshot(0)]);
      const name = `soms-message-commit-${userId}-42`;
      let release!: () => void;
      let acquired!: () => void;
      const entered = new Promise<void>((resolve) => (acquired = resolve));
      const held = navigator.locks.request(name, async () => {
        acquired();
        await new Promise<void>((resolve) => (release = resolve));
      });
      await entered;
      const caller = new AbortController();
      const request = vi.spyOn(navigator.locks, 'request');
      try {
        const pending = storage.commitBrowserMessagePage(
          {
            threadId: 42,
            scan: { left: 3, right: 4 },
            messages: [message()],
            gaps: [],
            knownNewestSeq: 10,
          },
          caller.signal,
        );
        const rejected = expect(pending).rejects.toThrow();
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        if (kind === 'caller') caller.abort();
        else if (kind === 'reset') await storage.recreateMessageCache();
        else await storage.close();
        await rejected;
        if (kind === 'close') await storage.openExistingForUser(userId);
        expect(await storage.getMessageHead(42)).toBeUndefined();
        expect(await storage.getMessage(42, 4)).toBeUndefined();
        expect(await storage.getMessageRanges(42)).toEqual([]);
      } finally {
        request.mockRestore();
        release();
        await held;
      }
    },
  );

  it('revalidates cancellation inside the lock callback before any commit', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    const caller = new AbortController();
    const request = vi
      .spyOn(navigator.locks, 'request')
      .mockImplementationOnce(async (_name, _options, callback) => {
        caller.abort();
        return callback!(null);
      });
    try {
      await expect(
        storage.commitBrowserMessagePage(
          {
            threadId: 42,
            scan: { left: 3, right: 4 },
            messages: [message()],
            gaps: [],
            knownNewestSeq: 10,
          },
          caller.signal,
        ),
      ).rejects.toThrow('message cache lifetime expired');
      expect(await storage.getMessageHead(42)).toBeUndefined();
      expect(await storage.getMessageRanges(42)).toEqual([]);
    } finally {
      request.mockRestore();
    }
  });

  it('rolls back the stub and HWM together when a feed transaction aborts', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    await storage.putCachedMessages([message()]);
    const original = IDBObjectStore.prototype.put;
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === 'threads') throw new Error('injected HWM failure');
        return original.apply(this, args);
      });
    try {
      await expect(
        storage.applyDeletedMessages(42, [deletion()], 8),
      ).rejects.toThrow('injected HWM failure');
    } finally {
      put.mockRestore();
    }
    expect(await storage.getDeletedHwm(42)).toBe(0);
    expect(await storage.getMessage(42, 4)).toEqual(message());
  });

  it('filters current local coverage before slot reads but accepts both server gap states', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    await storage.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 0, right: 4 },
      messages: [message(1)],
      gaps: [
        { left: 1, right: 2, state: 'SERVER_PENDING' },
        { left: 2, right: 3, state: 'SERVER_UNAVAILABLE' },
      ],
    });
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    await storage.putCachedMessages([
      message(1),
      message(2),
      message(3),
      message(4),
      message(5),
    ]);
    const messageKeys = get.mock.calls
      .filter(
        (_, index) =>
          (get.mock.contexts[index] as IDBObjectStore).name === 'messages',
      )
      .map(([key]) => key);
    expect(messageKeys).toEqual([
      [42, 2],
      [42, 3],
      [42, 5],
    ]);
    get.mockRestore();
    expect(await storage.getMessage(42, 4)).toBeUndefined();
    expect(
      (await storage.queryCachedMessages(42, 'asc', 10)).map((row) => row.seq),
    ).toEqual([1, 2, 3, 5]);
    expect(
      (await storage.getMessageRanges(42)).map((range) => range.state),
    ).toEqual([
      'LOCAL_COVERED',
      'SERVER_PENDING',
      'SERVER_UNAVAILABLE',
      'LOCAL_COVERED',
    ]);
    const committed = await storage.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 0, right: 5 },
      messages: [1, 2, 3, 4, 5].map((seq) => ({
        ...message(seq),
        content: 'later',
      })),
      gaps: [],
    });
    expect(committed.messages).toEqual([
      message(1),
      ...[2, 3, 5].map((seq) => ({ ...message(seq), content: 'later' })),
    ]);
    expect((await storage.getMessage(42, 1))?.content).toBe('private body');
    expect((await storage.getMessage(42, 3))?.content).toBe('later');
    expect(await storage.getMessage(42, 4)).toBeUndefined();
    expect(await storage.getMessageRanges(42)).toEqual([
      { threadId: 42, left: 0, right: 5, state: 'LOCAL_COVERED' },
    ]);
  });

  it('returns only persisted input message slots, not other cached rows in the scan', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    await storage.putCachedMessages([message(3), message(6)]);
    const committed = await storage.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 2, right: 7 },
      messages: [message(7), messageTomb(message(4), 'USER_RETRACTION')],
      gaps: [],
    });
    expect(committed.messages).toEqual([message(7)]);
    expect(committed.ranges).toEqual(await storage.getMessageRanges(42));
    expect(
      await storage.commitBrowserMessagePage({
        threadId: 42,
        scan: null,
        messages: [],
        gaps: [],
      }),
    ).toEqual({ messages: [], ranges: committed.ranges });
  });

  it('returns zero rows for a committed tomb-only page', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    const committed = await storage.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 0, right: 2 },
      messages: [messageTomb(message(1), 'USER_RETRACTION')],
      gaps: [],
    });
    expect(committed.messages).toEqual([]);
    expect(committed.ranges).toEqual([
      { threadId: 42, left: 0, right: 2, state: 'LOCAL_COVERED' },
    ]);
  });

  it('validates raw rows before filtering and rolls back bodies, ranges, and head on failure', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    await storage.commitBrowserMessagePage({
      threadId: 42,
      scan: { left: 0, right: 4 },
      messages: [],
      gaps: [],
      knownNewestSeq: 4,
    });
    await expect(
      storage.commitBrowserMessagePage({
        threadId: 42,
        scan: { left: 0, right: 4 },
        messages: [message(4), message(4)],
        gaps: [],
        knownNewestSeq: 10,
      }),
    ).rejects.toThrow('duplicate');
    expect(await storage.getMessageHead(42)).toBe(4);
    const original = IDBObjectStore.prototype.put;
    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === 'messageRanges')
          throw new Error('injected range failure');
        return original.apply(this, args);
      });
    try {
      await expect(
        storage.commitBrowserMessagePage({
          threadId: 42,
          scan: { left: 4, right: 5 },
          messages: [message(5)],
          gaps: [],
          knownNewestSeq: 10,
        }),
      ).rejects.toThrow('injected range failure');
    } finally {
      put.mockRestore();
    }
    expect(await storage.getMessage(42, 5)).toBeUndefined();
    expect(await storage.getMessageHead(42)).toBe(4);
    expect(await storage.getMessageRanges(42)).toEqual([
      { threadId: 42, left: 0, right: 4, state: 'LOCAL_COVERED' },
    ]);
  });

  it('returns only stored deletion coordinates and exact reasons for requested mounted slots', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    await storage.putCachedMessages([message(1), message(2), message(3)]);
    await storage.applyDeletedMessages(
      42,
      [deletion(2, 1), { ...deletion(3, 2), type: 'MODERATION_REMOVAL' }],
      2,
    );
    expect(await storage.getMessageDeletions(42, [])).toEqual([]);
    expect(await storage.getMessageDeletions(99, [2, 3])).toEqual([]);
    expect(await storage.getMessageDeletions(42, [1, 2, 2, 3, 4])).toEqual([
      { seq: 2, type: 'USER_RETRACTION' },
      { seq: 3, type: 'MODERATION_REMOVAL' },
    ]);
    await storage.close();
    await storage.openExistingForUser(userId);
    expect(await storage.getMessageDeletions(42, [3])).toEqual([
      { seq: 3, type: 'MODERATION_REMOVAL' },
    ]);
    expect(await storage.countCachedMessages()).toBe(1);
    expect(await storage.queryCachedMessages(42, 'asc', 10)).toEqual([
      message(1),
    ]);
  });

  it('upserts deletion coordinates without any old-message reads and counts them as zero', async () => {
    await storage.mergeThreadStates([snapshot(0)]);
    await storage.putCachedMessages([message()]);
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    await storage.applyDeletedMessages(42, [deletion(), deletion(5)], 8);
    expect(
      get.mock.contexts.map((store) => (store as IDBObjectStore).name),
    ).toEqual(['threads']);
    get.mockRestore();
    expect(await storage.countCachedMessages()).toBe(0);
    expect(await (await storage.db()).get('messages', [42, 4])).toEqual(
      createMessageDeletionMarker(42, 4, 'USER_RETRACTION'),
    );
  });
});
