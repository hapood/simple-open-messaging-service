import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import { WebdbService } from './webdb.service';
import { ThreadRepository } from './thread-store.service';
import { MessageRepository } from './message-repository.service';
import { MissedSyncService } from './missed-sync.service';
import { ProfileRepository } from './profile-store.service';
import { UserService, type HydratedThreadDeltaOp } from './user.service';
import { MsgService } from './message.service';
import { WebsocketService } from './websocket.service';
import { ConversationItem, Message, User } from './model';

/** Flush the microtask + macrotask queue so the async boot (IDB reads + Observable awaits + the 500ms
 *  debounce) settles. A 0ms flush advances the task queue enough for IDB + Observable microtasks; the
 *  missed-summary walk needs PULL_DEBOUNCE_MS (500). */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a minimal P2P ConversationItem (only the fields the repo reads + sorts on). */
function p2p(threadId: number, peerId: number, opts: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: threadId,
    threadId,
    type: 'P2P',
    lastReadSeq: null,
    role: null,
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastMessageSenderId: null,
    muted: false,
    pinned: false,
    pinnedAt: null,
    clearedAt: null,
    peerUser: {
      id: peerId, account: `u${peerId}`, name: `User ${peerId}`, avatar: '', bio: '',
      isForeigner: false, domain: '', createdAt: 0, updatedAt: 0, isDeleted: false,
    } as User,
    group: undefined as unknown as ConversationItem['group'],
    ...opts,
  };
}

/** A hydrated ADD delta op (the server hydrates ADDs inline; DELETEs carry only the threadId). */
function addOp(item: ConversationItem): HydratedThreadDeltaOp {
  return { threadId: item.threadId, direction: 'ADD', item };
}
function deleteOp(threadId: number): HydratedThreadDeltaOp {
  return { threadId, direction: 'DELETE' };
}

describe('ThreadRepository (eager cache-paint + HELLO delta-refresh)', () => {
  let repo: ThreadRepository;
  let webdb: WebdbService;
  let eventSubject: Subject<{ event: string; data?: unknown }>;
  let sessionUserId: ReturnType<typeof signal<number | null>>;
  let sessionProfile: ReturnType<typeof signal<User | undefined>>;
  let establishSessionSpy: jasmine.Spy;
  let queryThreadDeltaSpy: jasmine.Spy;
  let advanceCursorSpy: jasmine.Spy;
  let cursorSignal: ReturnType<typeof signal<number | undefined>>;
  let putProfileSpy: jasmine.Spy;

  beforeEach(async () => {
    eventSubject = new Subject();
    sessionUserId = signal<number | null>(null);
    sessionProfile = signal<User | undefined>({ id: 1 } as User);
    cursorSignal = signal<number | undefined>(undefined);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ThreadRepository,
        MessageRepository,
        WebdbService,
        { provide: MsgService, useValue: { queryMessageLog: jasmine.createSpy('queryMessageLog') } },
        {
          provide: ProfileRepository,
          useValue: {
            putProfile: jasmine.createSpy('putProfile').and.resolveTo(undefined),
            getProfile: jasmine.createSpy('getProfile').and.resolveTo(undefined),
          },
        },
        { provide: MissedSyncService, useValue: { fetchMissedSummary: jasmine.createSpy('fetchMissedSummary').and.resolveTo({ items: [], hasMore: false, nextCursor: null }) } },
        { provide: WebsocketService, useValue: { eventSubject } },
        {
          provide: UserService,
          useValue: {
            sessionUserId,
            sessionProfile,
            // Mirror the real establishSession's session-tracking input: the repo's reset effect watches
            // sessionUserId, so the mock sets it for the HELLO→establish→session-active lifecycle (+ the
            // logout→null→reset test). The per-user IDB is pre-opened for '1' below.
            establishSession: (establishSessionSpy = jasmine.createSpy('establishSession').and.callFake(
              async (userId: number) => { sessionUserId.set(userId); },
            )),
            threadRevCursor: () => cursorSignal(),
            seedThreadRevCursor: (rev: number) => cursorSignal.set(rev),
            advanceThreadRevCursor: (advanceCursorSpy = jasmine.createSpy('advanceThreadRevCursor').and.callFake(
              (r: number) => cursorSignal.set(r),
            )),
            queryThreadDelta: (queryThreadDeltaSpy = jasmine.createSpy('queryThreadDelta')),
            syncPeerProfile: () => of({ code: 0 }),
            markRead: () => of({ code: 0 }),
          },
        },
      ],
    });
    repo = TestBed.inject(ThreadRepository);
    webdb = TestBed.inject(WebdbService);
    putProfileSpy = TestBed.inject(ProfileRepository).putProfile as jasmine.Spy;
    await webdb.openForUser('1');
  });

  afterEach(async () => {
    try {
      await webdb.closeAndDelete('1');
    } catch {
      /* already closed */
    }
  });

  /** Seed a thread record directly into the IDB `threads` store — the cache the eager paint reads. */
  async function seedCachedThread(t: ConversationItem): Promise<void> {
    await (await webdb.db()).put('threads', t);
  }

  /** Seed a local message body directly into the IDB `messages` store — the local-first preview source.
   *  `content`/`creator` default to the cache-GC seed shape (`${threadId}:${seq}` / `threadId * 11`). */
  async function seedMessage(threadId: number, seq: number, content = `${threadId}:${seq}`, creator = threadId * 11): Promise<void> {
    const db = await webdb.db();
    const tx = db.transaction('messages', 'readwrite');
    await tx.store.put({
      threadId, seq, contentType: 'PURE_TEXT', content, creator,
      createdAt: 0, updatedAt: 0, isDeleted: false,
    } as unknown as Message);
    await tx.done;
  }

  /** Emit the HELLO connect handshake — the network-refresh half of boot (delta-replay + missed walk). */
  function emitHello(data: {
    userId?: number;
    latestMessage?: { threadId: number; seq: number; ts: number } | null;
    threadRevision?: number;
    profileRev?: number;
    hasUrFriendReq?: boolean;
  }): void {
    eventSubject.next({ event: 'HELLO', data });
  }

  /** Populate via the EAGER CACHE-PAINT (seed IDB + load) — the instant pre-HELLO path. For tests that
   *  just need a populated list (mutations, messages, peer profile) without exercising the delta. */
  async function populate(items: ConversationItem[]): Promise<void> {
    const db = await webdb.db();
    const tx = db.transaction('threads', 'readwrite');
    for (const it of items) await tx.store.put(it);
    await tx.done;
    repo.load();
    await flush(20);
  }

  /** Populate via a HELLO-driven delta replay (seeds cursor 0, replays (0,rev] with hydrated ADD ops). For
   *  tests that exercise the delta path + need the cursor set (live delta, reconnect). */
  async function populateViaDelta(items: ConversationItem[], rev = 5): Promise<void> {
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: items.map(addOp) }));
    emitHello({ userId: 1, threadRevision: rev });
    await flush(20);
  }

  // ── eager cache-paint (load — the instant pre-HELLO boot path) ─────────────────────────────────

  it('load() eager-paints the IDB cache INSTANTLY (pre-HELLO) + flips READY', async () => {
    await seedCachedThread(p2p(1, 11));
    await seedCachedThread(p2p(2, 22));
    repo.load();
    await flush(20);
    expect(repo.items().map((t) => t.threadId).sort()).toEqual([1, 2]);
    expect(repo.status()).toBe('READY');
  });

  it('load() with no cache leaves LOADING (awaiting HELLO delta)', async () => {
    repo.load();
    await flush(20);
    expect(repo.items()).toEqual([]);
    expect(repo.status()).toBe('LOADING');
  });

  // The clobber guard: a cache-paint that runs AFTER a fresher HELLO delta already populated the list
  // must BAIL — a late IDB read must not revert the list to the (now stale) cache.
  it('load() bails if the list is already populated (a late cache read cannot clobber a fresher delta)', async () => {
    // Delta populates [1] (the fresher state) + writes it through to IDB.
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [addOp(p2p(1, 11))] }));
    emitHello({ userId: 1, threadRevision: 5 });
    await flush(20);
    expect(repo.items().map((t) => t.threadId)).toEqual([1]);

    // Sneak a stale extra thread into the IDB cache, then load() — it must NOT revert/add it.
    await seedCachedThread(p2p(99, 99));
    repo.load();
    await flush(20);
    expect(repo.items().map((t) => t.threadId)).toEqual([1]); // 99 not clobbered in
  });

  // Regression guard for the "暂无消息 on first launch" bug: the list embeds NO preview content, so each
  // thread's preview must be derived from its newest CACHED local message (local-first). load()'s paint
  // runs hydratePreviews — seed a local newest message + the cached thread, load, assert the preview +
  // sender are derived from the local message.
  it('load() re-derives the list preview from the newest cached local message (local-first)', async () => {
    await seedCachedThread(p2p(1, 77));
    await seedMessage(1, 5, 'hello world', 77);
    repo.load();
    await flush(20);
    const items = repo.items();
    expect(items[0].lastMessagePreview).toBe('hello world');
    expect(items[0].lastMessageSenderId).toBe(77);
  });

  // ── HELLO (the network-refresh half: delta-replay + missed-summary walk) ───────────────────────

  it('HELLO without a userId is ignored (no session established, no fetch)', async () => {
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [] }));
    emitHello({}); // no userId → onHello bails before establishing the session
    await flush(20);
    expect(establishSessionSpy).not.toHaveBeenCalled();
    expect(queryThreadDeltaSpy).not.toHaveBeenCalled();
  });

  it('cold start: HELLO seeds cursor 0, replays (0,rev] with hydrated ADD ops, populates the list', async () => {
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [addOp(p2p(1, 11)), addOp(p2p(2, 22))] }));
    emitHello({ userId: 1, threadRevision: 5 });
    await flush(20);

    expect(repo.items().map((t) => t.threadId).sort()).toEqual([1, 2]);
    expect(repo.status()).toBe('READY');
    // ONE request — the delta hydrates the ADDs inline (no second batch-hydrate round-trip).
    expect(queryThreadDeltaSpy).toHaveBeenCalledWith({ fromRevision: 0, toRevision: 5 });
    expect(advanceCursorSpy).toHaveBeenCalledWith(5);
  });

  it('HELLO without a latestMessage does not trigger a missed-summary walk', async () => {
    const missed = TestBed.inject(MissedSyncService) as unknown as { fetchMissedSummary: jasmine.Spy };
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [] }));
    emitHello({ userId: 1, threadRevision: 5 }); // no latestMessage → no `to` to walk toward
    await flush(700);
    expect(missed.fetchMissedSummary).not.toHaveBeenCalled();
  });

  // HELLO's latestMessage sets the walk's `to` → after the 500ms debounce, pullMissed walks `(from, to]`
  // (from = the persisted HWM, null on first boot), caches bodies, advances the HWM to `to`.
  it('HELLO latestMessage → debounced (from,to] walk → HWM persists to `to`', async () => {
    const missed = TestBed.inject(MissedSyncService) as unknown as { fetchMissedSummary: jasmine.Spy };
    await seedCachedThread(p2p(1, 77));
    await seedMessage(1, 5, 'hello world', 77);
    missed.fetchMissedSummary.and.resolveTo({
      items: [{
        threadId: 1, type: 'P2P', displayName: 'User 77', unreadCount: 0, muted: false,
        senderAvatarUrl: '', senderUserId: 77,
        latestMessage: { threadId: 1, seq: 5, contentType: 'PURE_TEXT', content: 'hello world',
          creator: 77, createdAt: 1000, mediaStatus: 'ready', sv: 5 },
      }],
      hasMore: false, nextCursor: null,
    });
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [] }));
    emitHello({ userId: 1, threadRevision: 5, latestMessage: { threadId: 1, seq: 5, ts: 1000 } });
    await flush(700);
    expect(missed.fetchMissedSummary).toHaveBeenCalledWith(null, { threadId: 1, seq: 5 });
    expect(await webdb.getMeta('missedCursor')).toEqual({ threadId: 1, seq: 5 }); // HWM persisted to `to`
  });

  // ── reconnect (the SSE stream re-pushes HELLO → onHello re-runs; no separate reconnect wiring) ──

  it('a second HELLO (reconnect) re-establishes the session + replays the incremental delta', async () => {
    await populateViaDelta([p2p(1, 11), p2p(2, 22)], 5); // cursor → 5
    expect(repo.items().map((t) => t.threadId).sort()).toEqual([1, 2]);

    establishSessionSpy.calls.reset();
    queryThreadDeltaSpy.calls.reset();
    // The reconnect re-pushes HELLO with the same userId + a newer revision → incremental (5, 6] (the
    // cursor survives in-memory across the reconnect, so it is NOT re-seeded to 0).
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [addOp(p2p(3, 33))] }));
    emitHello({ userId: 1, threadRevision: 6 });
    await flush(20);

    expect(establishSessionSpy).toHaveBeenCalledWith(1, 0, false);
    expect(queryThreadDeltaSpy).toHaveBeenCalledWith({ fromRevision: 5, toRevision: 6 });
    expect(repo.items().map((t) => t.threadId).sort()).toEqual([1, 2, 3]);
    expect(cursorSignal()).toBe(6);
  });

  // ── session-end reset (logout / account switch) ───────────────────────────────────────────────

  // Regression guard for the account-switch bug: logout (sessionUserId → null) must drop the previous
  // user's cached list + flip status back to LOADING, so the next login's list re-loads instead of
  // painting stale data.
  it('session-end (sessionUserId→null) drops the cached list + re-arms LOADING', async () => {
    sessionUserId.set(1); // simulate HELLO→establishSession activating the session (populate is cache-only)
    await populate([p2p(1, 11), p2p(2, 22)]);
    expect(repo.items().length).toBe(2);
    expect(repo.status()).toBe('READY');

    // UserService.clearSession sets sessionUserId→null → the repo's session-end effect fires reset():
    // drops the IN-MEMORY list + flips status back to LOADING. (The IDB wipe + cursor reset are
    // clearSession's own job — the repo owns only in-memory state.)
    sessionUserId.set(null);
    await flush(20);
    expect(repo.items()).toEqual([]);
    expect(repo.status()).toBe('LOADING');
    expect(repo.error()).toBe('');
  });

  // ── live NEW_MESSAGE (identity-only signal — no body) ─────────────────────────────────────────

  it('onNewMessage bumps unread (closed thread) and reorders to the tier head', async () => {
    await populate([p2p(1, 11, { lastMessageAt: 100 }), p2p(2, 22, { lastMessageAt: 200 })]);

    eventSubject.next({ event: 'NEW_MESSAGE', data: { threadId: 1, seq: 100, ts: 300 } });
    await flush();

    const items = repo.items();
    expect(items[0].threadId).toBe(1); // bumped to the head of the unpinned tier (lastMessageAt 300)
    expect(items[0].unreadCount).toBe(1);
    // Write-through: the IDB record carries the new unread.
    const rec = await (await webdb.db()).get('threads', 1);
    expect(rec?.unreadCount).toBe(1);
  });

  it('onNewMessage does not badge the open thread', async () => {
    await populate([p2p(1, 11)]);
    repo.setOpenThread(1);
    eventSubject.next({ event: 'NEW_MESSAGE', data: { threadId: 1, seq: 100, ts: 300 } });
    await flush();
    expect(repo.items()[0].unreadCount).toBe(0);
  });

  it('onNewMessage dedupes a redelivered frame (same seq)', async () => {
    await populate([p2p(1, 11)]);
    const frame = { threadId: 1, seq: 100, ts: 300 };
    eventSubject.next({ event: 'NEW_MESSAGE', data: frame });
    await flush();
    eventSubject.next({ event: 'NEW_MESSAGE', data: frame }); // redelivery
    await flush();
    expect(repo.items()[0].unreadCount).toBe(1); // bumped once, not twice
  });

  // ── mutations (each writes through to IDB + emits a fine-grained signal update) ───────────────

  it('applyThreadMeta patches the row, re-sorts (pin), and writes through to IDB', async () => {
    await populate([p2p(1, 11, { lastMessageAt: 100 }), p2p(2, 22, { lastMessageAt: 200 })]);
    repo.applyThreadMeta(1, { pinned: true, pinnedAt: 500 });
    await flush();

    const items = repo.items();
    expect(items[0].threadId).toBe(1); // pinned → top
    expect(items[0].pinned).toBe(true);
    const rec = await (await webdb.db()).get('threads', 1);
    expect(rec?.pinned).toBe(true);
  });

  it('removeThread drops the item from the list AND IDB', async () => {
    await populate([p2p(1, 11), p2p(2, 22)]);
    repo.removeThread(1);
    await flush();
    expect(repo.items().map((t) => t.threadId)).toEqual([2]);
    expect(await (await webdb.db()).get('threads', 1)).toBeUndefined();
  });

  it('removeThread also purges the cached message bodies from IDB (cache GC on thread removal)', async () => {
    await populate([p2p(1, 11), p2p(2, 22)]);
    // Seed message bodies for BOTH threads directly into the messages store.
    await seedMessage(1, 1); await seedMessage(1, 2); await seedMessage(2, 1);

    const db = await webdb.db();
    const msgCount = async (threadId: number): Promise<number> => {
      let n = 0;
      let cursor = await db.transaction('messages').store.openCursor(
        IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]),
      );
      while (cursor) { n++; cursor = await cursor.continue(); }
      return n;
    };
    expect(await msgCount(1)).toBe(2); // pre-condition

    repo.removeThread(1);
    await flush();

    expect(await msgCount(1)).toBe(0); // thread 1's bodies purged via the message repo
    expect(await msgCount(2)).toBe(1); // thread 2's bodies untouched — the purge is scoped
  });

  // ── THREAD_REVISION_UPDATED delta (live add/delete — the same hydrated shape as the init replay) ─

  it('THREAD_REVISION_UPDATED delta: DELETE removes locally, ADD (hydrated) inserts, cursor advances', async () => {
    await populateViaDelta([p2p(1, 11), p2p(2, 22)], 5); // cursor → 5

    // Live delta: delete thread 1, add thread 3 (hydrated inline — no second fetch).
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [deleteOp(1), addOp(p2p(3, 33))] }));
    eventSubject.next({ event: 'THREAD_REVISION_UPDATED', data: { revision: 12 } });
    await flush(20);

    expect(repo.items().map((t) => t.threadId).sort()).toEqual([2, 3]);
    expect(advanceCursorSpy).toHaveBeenCalledWith(12);
    // The added thread is persisted; the deleted one is gone from IDB.
    expect(await (await webdb.db()).get('threads', 3)).toBeDefined();
    expect(await (await webdb.db()).get('threads', 1)).toBeUndefined();
  });

  // A signal that lands before HELLO seeds the cursor is dropped — pullDelta's "cursor undefined → return"
  // guard. (onHello is the sole seeder now; there is no snapshot fetch to race against.)
  it('THREAD_REVISION_UPDATED is dropped while the cursor is unseeded (no HELLO yet)', async () => {
    // cursorSignal starts undefined — do NOT emit HELLO.
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [] }));
    eventSubject.next({ event: 'THREAD_REVISION_UPDATED', data: { revision: 12 } });
    await flush(20);
    expect(queryThreadDeltaSpy).not.toHaveBeenCalled();
  });

  // ── PEER_PROFILE_UPDATED (a friend changed avatar/name/bio) ───────────────────────────────────

  it('PEER_PROFILE_UPDATED patches the matching P2P row by peerUser.id and writes the profile through', async () => {
    await populate([p2p(1, 11, {
      peerUser: { id: 11, name: 'Old', account: 'u11', avatar: '/old.webp', bio: '', isForeigner: false, domain: '', createdAt: 0, updatedAt: 0, isDeleted: false } as User,
    })]);

    eventSubject.next({
      event: 'PEER_PROFILE_UPDATED',
      data: { id: 11, name: 'New', account: 'u11', avatar: '/new.webp', bio: 'b', isForeigner: false, domain: '', createdAt: 0, updatedAt: 0, isDeleted: false },
    });
    await flush();

    expect(repo.items()[0].peerUser.name).toBe('New');
    // Profile write-through fires for the embedded peer profile.
    expect(putProfileSpy).toHaveBeenCalledWith('u11', 'user', jasmine.objectContaining({ name: 'New' }));
  });

  // ── optimistic read-watermark merge (B6) ───────────────────────────────────────────────────

  it('optimistic lastReadSeq masks a stale server unread regression while a markRead POST is in flight', async () => {
    // Reconfigure the missed-summary pull to return the SERVER's stale view: lastReadSeq 5, unread 3 (the
    // markRead POST has not landed yet). noteOptimisticRead records the local truth (seq 10); the merge must
    // keep it + mask the unread regression.
    const fetchSpy = (TestBed.inject(MissedSyncService) as unknown as {
      fetchMissedSummary: jasmine.Spy;
    }).fetchMissedSummary;
    fetchSpy.and.resolveTo({
      items: [{
        threadId: 1, type: 'P2P', displayName: 'A', unreadCount: 3, muted: false, lastReadSeq: 5,
        senderAvatarUrl: '', senderUserId: 11, latestMessage: null,
      }],
      hasMore: false, nextCursor: null,
    });
    await populate([p2p(1, 11, { lastReadSeq: 5, unreadCount: 0 })]);
    repo.noteOptimisticRead(1, 10); // local truth ahead of the server
    // A NEW_MESSAGE advances `to` + schedules the debounced missed-summary walk.
    eventSubject.next({ event: 'NEW_MESSAGE', data: { threadId: 1, seq: 12, ts: 1000 } });
    await flush(700); // past the 500ms pull debounce

    const item = repo.items().find((t) => t.threadId === 1)!;
    expect(item.lastReadSeq).toBe(10); // optimistic (10) wins over stale server (5)
    expect(item.unreadCount).toBe(0); // the server's transient unread=3 is masked
  });
});
