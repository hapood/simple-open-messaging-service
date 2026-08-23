import type { Mock } from 'vitest';
import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Subject, firstValueFrom, of } from 'rxjs';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import { WebdbService } from './webdb.service';
import { rawPreview, ThreadRepository } from './thread-store.service';
import { MessageRepository } from './message-repository.service';
import { ThreadCatchUpService } from './thread-catch-up.service';
import { ProfileRepository } from './profile-store.service';
import { UserService } from './user.service';
import { MsgService } from './message.service';
import { WebsocketService } from './websocket.service';
import { ConversationItem, Message, User } from './model';
import { ToastService } from './toast.service';
import { TranslocoService } from '@jsverse/transloco';

/** Flush the microtask + macrotask queue so the async boot (IDB reads + Observable awaits + the 200ms
 *  debounce) settles. A 0ms flush advances the task queue enough for IDB + Observable microtasks; the
 *  missed-summary walk needs PULL_DEBOUNCE_MS (200). */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a minimal P2P ConversationItem (only the fields the repo reads + sorts on). */
function p2p(
  threadId: number,
  peerId: number,
  opts: Partial<ConversationItem> = {},
): ConversationItem {
  return {
    id: threadId,
    threadId,
    type: 'P2P',
    conversationState: 'ACTIVE',
    lastReadSeq: null,
    role: null,
    unreadCount: 0,
    mentionUnread: [],
    lastMessagePreview: null,
    lastMessageAt: null,
    lastMessageSeq: null,
    lastMessageSenderId: null,
    muted: false,
    pinned: false,
    pinnedAt: null,
    clearedSeq: null,
    peerUser: {
      id: peerId,
      account: `u${peerId}`,
      name: `User ${peerId}`,
      avatar: '',
      bio: '',
      isForeigner: false,
      domain: '',
      createdAt: 0,
      updatedAt: 0,
      isDeleted: false,
    } as User,
    group: undefined as unknown as ConversationItem['group'],
    ...opts,
  };
}

describe('ThreadRepository (eager cache-paint + HELLO delta-refresh)', () => {
  let repo: ThreadRepository;
  let webdb: WebdbService;
  let eventSubject: Subject<{
    event: string;
    data?: unknown;
  }>;
  let sessionUserId: ReturnType<typeof signal<number | null>>;
  let sessionProfile: ReturnType<typeof signal<User | undefined>>;
  let establishSessionSpy: Mock;
  let queryStateFeedSpy: Mock;
  let getThreadInfoSpy: Mock;
  let queryReadDeltaSpy: Mock;
  let queryUserInfoSpy: Mock;
  let advanceCursorSpy: Mock;
  let applyFriendRequestStateRevisionSpy: Mock;
  let applyFriendIntentStateRevisionSpy: Mock;
  let cursorSignal: ReturnType<typeof signal<number | undefined>>;
  let putProfileSpy: Mock;
  let toastWarn: Mock;

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
        {
          provide: ToastService,
          useValue: { warn: (toastWarn = vi.fn().mockName('toastWarn')) },
        },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        {
          provide: MsgService,
          useValue: {
            queryMessageLog: vi.fn().mockName('queryMessageLog'),
            getDeletedMessageHwm: vi
              .fn()
              .mockName('getDeletedMessageHwm')
              .mockReturnValue(of({ code: 0, data: { hwm: '0' } })),
          },
        },
        {
          provide: ProfileRepository,
          useValue: {
            putProfile: vi
              .fn()
              .mockName('putProfile')
              .mockResolvedValue(undefined),
            getProfile: vi
              .fn()
              .mockName('getProfile')
              .mockResolvedValue(undefined),
          },
        },
        {
          provide: ThreadCatchUpService,
          useValue: {
            catchUp: vi.fn().mockName('catchUp').mockResolvedValue({
              items: [],
              hasMore: false,
              scannedThrough: 0,
              messageFeedEndId: 0,
            }),
            catchUpTombstones: vi.fn().mockResolvedValue({
              items: [],
              hasMore: false,
              scannedThrough: 0,
              tombstoneFeedEndId: 0,
            }),
          },
        },
        {
          provide: WebsocketService,
          useValue: { eventSubject, reconnect$: new Subject<void>() },
        },
        {
          provide: UserService,
          useValue: {
            sessionUserId,
            sessionProfile,
            // Mirror the real establishSession's session-tracking input: the repo's reset effect watches
            // sessionUserId, so the mock sets it for the HELLO→establish→session-active lifecycle (+ the
            // logout→null→reset test). The per-user IDB is pre-opened for '1' below.
            establishSession: (establishSessionSpy = vi
              .fn()
              .mockName('establishSession')
              .mockImplementation(async (userId: number) => {
                sessionUserId.set(userId);
              })),
            stateFeedCursor: () => cursorSignal(),
            seedStateFeedCursor: (rev: number) => cursorSignal.set(rev),
            advanceStateFeedCursor: (advanceCursorSpy = vi
              .fn()
              .mockName('advanceStateFeedCursor')
              .mockImplementation((r: number) => cursorSignal.set(r))),
            queryStateFeed: (queryStateFeedSpy = vi
              .fn()
              .mockName('queryStateFeed')
              .mockImplementation(
                (params: { mode: 'full' | 'delta'; through: number }) =>
                  of({
                    code: 0,
                    data: {
                      mode: params.mode,
                      items: [],
                      hasMore: false,
                      scannedThrough: params.through,
                      stateFeedEndId: params.through,
                    },
                  }),
              )),
            getThreadInfo: (getThreadInfoSpy = vi
              .fn()
              .mockName('getThreadInfo')
              .mockReturnValue(of({ code: 1 }))),
            queryReadDelta: (queryReadDeltaSpy = vi
              .fn()
              .mockName('queryReadDelta')
              .mockReturnValue(
                of({ code: 0, data: { readRevision: 0, items: [] } }),
              )),
            queryUserInfo: (queryUserInfoSpy = vi
              .fn()
              .mockName('queryUserInfo')
              .mockReturnValue(of({ code: 0, data: [] }))),
            applyStateProfile: (profile: User) => {
              if (profile.id === sessionProfile()?.id)
                sessionProfile.set(profile);
            },
            applyFriendRequestStateRevision:
              (applyFriendRequestStateRevisionSpy = vi
                .fn()
                .mockName('applyFriendRequestStateRevision')),
            applyFriendIntentStateRevision: (applyFriendIntentStateRevisionSpy =
              vi.fn().mockName('applyFriendIntentStateRevision')),
            markRead: () => of({ code: 0 }),
          },
        },
      ],
    });
    repo = TestBed.inject(ThreadRepository);
    webdb = TestBed.inject(WebdbService);
    putProfileSpy = TestBed.inject(ProfileRepository).putProfile as Mock;
    await webdb.openForUser('1');
    TestBed.flushEffects();
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
  async function seedMessage(
    threadId: number,
    seq: number,
    content = `${threadId}:${seq}`,
    creator = threadId * 11,
  ): Promise<void> {
    const db = await webdb.messageDb();
    const tx = db.transaction('messages', 'readwrite');
    await tx.store.put({
      threadId,
      seq,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: content }),
      creator,
      createdAt: 0,
      updatedAt: 0,
      isDeleted: false,
    } as unknown as Message);
    await tx.done;
  }

  /** Emit the HELLO connect handshake — revision replay plus durable feed catch-up. */
  function emitHello(data: {
    userId?: number;
    stateFeedEndId: number;
    profileRev?: number;
    readRevision?: number;
  }): void {
    eventSubject.next({
      event: 'HELLO',
      data,
    });
  }

  /** Populate via the EAGER CACHE-PAINT (seed IDB + load) — the instant pre-HELLO path. For tests that
   *  just need a populated list (mutations, messages, peer profile) without exercising the delta. */
  async function populate(items: ConversationItem[]): Promise<void> {
    const db = await webdb.db();
    const tx = db.transaction('threads', 'readwrite');
    for (const it of items) await tx.store.put(it);
    await tx.done;
    await repo.load();
  }

  // ── eager cache-paint (load — the instant pre-HELLO boot path) ─────────────────────────────────

  it('load() eager-paints the IDB cache INSTANTLY (pre-HELLO) + flips READY', async () => {
    await seedCachedThread(p2p(1, 11));
    await seedCachedThread(p2p(2, 22));
    repo.load();
    await flush(20);
    expect(
      repo
        .items()
        .map((t) => t.threadId)
        .sort(),
    ).toEqual([1, 2]);
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
    emitHello({ stateFeedEndId: 0 }); // no userId → onHello bails before establishing the session
    await flush(20);
    expect(establishSessionSpy).not.toHaveBeenCalled();
    expect(queryStateFeedSpy).not.toHaveBeenCalled();
  });

  it('HELLO always reconciles the durable message feed', async () => {
    const missed = TestBed.inject(ThreadCatchUpService) as unknown as {
      catchUp: Mock;
    };
    emitHello({ userId: 1, stateFeedEndId: 5 });
    await flush(700);
    expect(missed.catchUp).toHaveBeenCalledWith(0, undefined);
  });

  it('HELLO drains catch-up and durably commits its integer feed cursor', async () => {
    const missed = TestBed.inject(ThreadCatchUpService) as unknown as {
      catchUp: Mock;
    };
    await seedCachedThread(p2p(1, 77));
    await seedMessage(1, 5, 'hello world', 77);
    missed.catchUp.mockResolvedValue({
      items: [
        {
          threadId: 1,
          type: 'P2P',
          displayName: 'User 77',
          unreadCount: 0,
          muted: false,
          senderAvatarUrl: '',
          senderUserId: 77,
          latestMessage: {
            threadId: 1,
            seq: 5,
            contentType: 'PURE_TEXT',
            content: JSON.stringify({ text: 'hello world' }),
            creator: 77,
            createdAt: 1000,
            mediaStatus: 'ready',
            sv: 5,
          },
        },
      ],
      hasMore: false,
      scannedThrough: 1,
      messageFeedEndId: 1,
    });
    emitHello({
      userId: 1,
      stateFeedEndId: 5,
    });
    await flush(700);
    expect(missed.catchUp).toHaveBeenCalledWith(0, undefined);
    expect(await webdb.getMeta('messageFeedCursor')).toBe(1);
  });

  // ── reconnect (the SSE stream re-pushes HELLO → onHello re-runs; no separate reconnect wiring) ──

  it('session-end (sessionUserId→null) drops the cached list + re-arms LOADING', async () => {
    sessionUserId.set(1); // simulate HELLO→establishSession activating the session (populate is cache-only)
    await populate([p2p(1, 11), p2p(2, 22)]);
    expect(repo.items().length).toBe(2);
    expect(repo.status()).toBe('READY');

    // UserService.clearSession sets sessionUserId→null → the repo's session-end effect fires reset():
    // drops the IN-MEMORY list + flips status back to LOADING. (The IDB wipe + cursor reset are
    // clearSession's own job — the repo owns only in-memory state.)
    sessionUserId.set(null);
    TestBed.tick();
    await flush(20);
    expect(repo.items()).toEqual([]);
    expect(repo.status()).toBe('LOADING');
    expect(repo.error()).toBe('');
  });

  // ── live NEW_MESSAGE (identity-only signal — no body) ─────────────────────────────────────────

  it('onNewMessage reorders to the tier head but does not bump unread (server-authoritative)', async () => {
    await populate([
      p2p(1, 11, { lastMessageAt: 100 }),
      p2p(2, 22, { lastMessageAt: 200 }),
    ]);

    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 100, ts: 300 },
    });
    await flush(20);

    const items = repo.items();
    expect(items[0].threadId).toBe(1); // moved to the head of the unpinned tier (lastMessageAt 300)
    expect(repo.latestSeq(1)).toBe(100);
    expect(items[0].lastMessageSeq).toBe(100);
    // unreadCount is NOT bumped — it is server-authoritative, applied by the missed-summary pull.
    expect(items[0].unreadCount).toBe(0);
    const rec = await (await webdb.db()).get('threads', 1);
    expect(rec?.unreadCount).toBe(0);
    expect(rec?.lastMessageSeq).toBe(100);
  });

  it('buffers only the newest NEW_MESSAGE while a read commit is pending, then replays it', async () => {
    await populate([p2p(1, 11, { lastMessageSeq: 4, lastMessageAt: 100 })]);
    repo.beginReadCommit(1);

    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 5, ts: 200 },
    });
    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 7, ts: 300 },
    });
    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 6, ts: 250 },
    });
    expect(repo.items()[0].lastMessageSeq).toBe(4);
    expect(repo.readCommitPending().has(1)).toBe(true);

    repo.finishReadCommit(1);

    expect(repo.readCommitPending().has(1)).toBe(false);
    expect(repo.items()[0]).toEqual(
      expect.objectContaining({
        lastMessageSeq: 7,
        lastMessageAt: 300,
      }),
    );
  });

  it('drains a trailing missed-summary pull when messages arrive during an in-flight pull', async () => {
    const missed = TestBed.inject(ThreadCatchUpService) as unknown as {
      catchUp: Mock;
    };
    let resolveFirst!: (value: {
      items: never[];
      hasMore: boolean;
      scannedThrough: number;
      messageFeedEndId: number;
    }) => void;
    const first = new Promise<{
      items: never[];
      hasMore: boolean;
      scannedThrough: number;
      messageFeedEndId: number;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    missed.catchUp.mockReturnValueOnce(first).mockReturnValueOnce(
      Promise.resolve({
        items: [],
        hasMore: false,
        scannedThrough: 2,
        messageFeedEndId: 2,
      }),
    );
    await populate([p2p(1, 11)]);

    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 1, ts: 100 },
    });
    await flush(250); // first debounced pull is now in flight
    expect(missed.catchUp).toHaveBeenCalledTimes(1);
    expect(missed.catchUp).toHaveBeenCalledWith(0, undefined);

    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 3, ts: 300 },
    });
    await flush(350); // trailing debounce fires while the first request is unresolved
    resolveFirst({
      items: [],
      hasMore: false,
      scannedThrough: 1,
      messageFeedEndId: 1,
    });
    await flush(50);

    expect(vi.mocked(missed.catchUp).mock.calls.length).toBe(2);
    expect(vi.mocked(missed.catchUp).mock.lastCall).toEqual([1, undefined]);
  });

  it('onNewMessage does not badge the open thread', async () => {
    await populate([p2p(1, 11)]);
    repo.setOpenThread(1);
    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 100, ts: 300 },
    });
    await flush();
    expect(repo.items()[0].unreadCount).toBe(0);
  });

  it('onNewMessage discards an out-of-order/redelivered seq (per-thread HWM guard)', async () => {
    await populate([p2p(1, 11, { lastMessageAt: 100 })]);
    // A newer seq advances lastMessageAt...
    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 100, ts: 300 },
    });
    await flush();
    expect(repo.items()[0].lastMessageAt).toBe(300);
    // ...an older seq is discarded by the HWM guard — no regression of recency.
    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 50, ts: 999 },
    });
    await flush();
    expect(repo.items()[0].lastMessageAt).toBe(300);
  });

  it('actively hydrates an unknown thread and coalesces messages behind one request', async () => {
    await populate([p2p(1, 11)]);
    const response = new Subject<{
      code: number;
      data?: ConversationItem;
    }>();
    getThreadInfoSpy.mockReturnValue(response);

    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 2, seq: 5, ts: 200 },
    });
    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 2, seq: 7, ts: 300 },
    });

    expect(getThreadInfoSpy).toHaveBeenCalledTimes(1);

    expect(getThreadInfoSpy).toHaveBeenCalledWith({ threadId: 2 });
    response.next({
      code: 0,
      data: p2p(2, 22, { lastMessageSeq: 5, lastMessageAt: 200 }),
    });
    response.complete();
    await flush(20);

    expect(repo.items()[0]).toEqual(
      expect.objectContaining({
        threadId: 2,
        lastMessageSeq: 7,
        lastMessageAt: 300,
      }),
    );
    expect(await (await webdb.db()).get('threads', 2)).toEqual(
      expect.objectContaining({ lastMessageSeq: 7 }),
    );
  });

  // ── mutations (each writes through to IDB + emits a fine-grained signal update) ───────────────

  it('applyThreadMeta patches the row, re-sorts (pin), and writes through to IDB', async () => {
    await populate([
      p2p(1, 11, { lastMessageAt: 100 }),
      p2p(2, 22, { lastMessageAt: 200 }),
    ]);
    repo.applyThreadMeta(1, { pinned: true, pinnedAt: 500 });
    await flush();

    const items = repo.items();
    expect(items[0].threadId).toBe(1); // pinned → top
    expect(items[0].pinned).toBe(true);
    const rec = await (await webdb.db()).get('threads', 1);
    expect(rec?.pinned).toBe(true);
  });

  it('applyThreadMeta keeps display-only metadata changes at the current list position', async () => {
    await populate([
      p2p(1, 11, { lastMessageAt: 200 }),
      p2p(2, 22, { lastMessageAt: 100 }),
    ]);
    expect(repo.items().map((t) => t.threadId)).toEqual([1, 2]);

    repo.applyThreadMeta(2, {
      muted: true,
      blocked: true,
      alias: 'Quiet',
    });
    await flush();

    expect(repo.items().map((t) => t.threadId)).toEqual([1, 2]);
    expect(repo.items()[1]).toEqual(
      expect.objectContaining({ muted: true, blocked: true, alias: 'Quiet' }),
    );
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
    await seedMessage(1, 1);
    await seedMessage(1, 2);
    await seedMessage(2, 1);

    const db = await webdb.messageDb();
    const msgCount = async (threadId: number): Promise<number> => {
      let n = 0;
      let cursor = await db
        .transaction('messages')
        .store.openCursor(
          IDBKeyRange.bound([threadId, -Infinity], [threadId, Infinity]),
        );
      while (cursor) {
        n++;
        cursor = await cursor.continue();
      }
      return n;
    };
    expect(await msgCount(1)).toBe(2); // pre-condition

    repo.removeThread(1);
    await flush();

    expect(await msgCount(1)).toBe(0); // thread 1's bodies purged via the message repo
    expect(await msgCount(2)).toBe(1); // thread 2's bodies untouched — the purge is scoped
  });

  // ── STATE_FEED_UPDATED delta (thread and profile state share one ordered stream) ──

  it('records a local HWM without guessing the unread badge', async () => {
    await populate([
      p2p(1, 11, {
        lastReadSeq: 5,
        lastMessageSeq: 8,
        unreadCount: 3,
        mentionUnread: ['me'],
      }),
    ]);

    expect(repo.commitLocalRead(1, 7)).toBe(true);
    expect(repo.items()[0]).toEqual(
      expect.objectContaining({
        lastReadSeq: 5,
        unreadCount: 3,
        mentionUnread: ['me'],
      }),
    );
    expect(repo.commitLocalRead(1, 7)).toBe(false);
  });

  it('atomically applies the server read state', async () => {
    await populate([p2p(1, 11, { lastReadSeq: 5, unreadCount: 3 })]);
    repo.commitLocalRead(1, 7);

    repo.applyReadState({
      threadId: 1,
      lastReadSeq: 7,
      readRevision: 1,
      unreadCount: 1,
      mentionUnread: ['all'],
    });

    expect(repo.items()[0]).toEqual(
      expect.objectContaining({
        lastReadSeq: 7,
        unreadCount: 1,
        mentionUnread: ['all'],
      }),
    );
  });

  it('pulls read delta when HELLO exposes a revision gap', async () => {
    await populate([p2p(1, 11, { lastReadSeq: 2, unreadCount: 4 })]);
    await webdb.putMeta('readRevision', 2);
    queryReadDeltaSpy.mockReturnValue(
      of({
        code: 0,
        data: {
          readRevision: 5,
          items: [
            {
              threadId: 1,
              lastReadSeq: 6,
              readRevision: 5,
              unreadCount: 0,
              mentionUnread: [],
            },
          ],
        },
      }),
    );

    emitHello({ userId: 1, stateFeedEndId: 0, readRevision: 5 });
    await flush(20);

    expect(queryReadDeltaSpy).toHaveBeenCalledWith({
      fromRevision: 2,
      toRevision: 5,
    });
    expect(repo.items()[0]).toEqual(
      expect.objectContaining({ lastReadSeq: 6, unreadCount: 0 }),
    );
    expect(await webdb.getMeta('readRevision')).toBe(5);
  });

  it('treats attention SSE as a cursor-only wake-up and pulls its projection', async () => {
    await populate([p2p(1, 11, { lastReadSeq: 2, unreadCount: 4 })]);
    await webdb.putMeta('readRevision', 2);
    emitHello({ userId: 1, stateFeedEndId: 0, readRevision: 2 });
    await flush(20);
    queryReadDeltaSpy.mockClear();
    queryReadDeltaSpy.mockReturnValue(
      of({
        code: 0,
        data: {
          readRevision: 3,
          items: [
            {
              threadId: 1,
              lastReadSeq: 7,
              readRevision: 3,
              unreadCount: 0,
              mentionUnread: [],
            },
          ],
        },
      }),
    );

    eventSubject.next({
      event: 'ATTENTION_REV_UPDATED',
      data: { attentionRevision: 3 },
    });
    await flush(20);

    expect(queryReadDeltaSpy).toHaveBeenCalledWith({
      fromRevision: 2,
      toRevision: 3,
    });
    expect(repo.items()[0]).toEqual(
      expect.objectContaining({ lastReadSeq: 7, unreadCount: 0 }),
    );
  });

  it('catch-up applies the authoritative per-thread unreadCount', async () => {
    const fetchSpy = (
      TestBed.inject(ThreadCatchUpService) as unknown as {
        catchUp: Mock;
      }
    ).catchUp;
    fetchSpy.mockResolvedValue({
      items: [
        {
          threadId: 1,
          type: 'P2P',
          displayName: 'A',
          unreadCount: 7,
          muted: false,
          lastReadSeq: 3,
          senderAvatarUrl: '',
          senderUserId: 11,
          latestMessage: null,
        },
      ],
      hasMore: false,
      scannedThrough: 0,
      messageFeedEndId: 0,
    });
    await populate([p2p(1, 11, { lastReadSeq: 3, unreadCount: 0 })]);
    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 12, ts: 1000 },
    });
    await flush(300); // past the 200ms pull debounce

    const item = repo.items().find((t) => t.threadId === 1)!;
    expect(item.unreadCount).toBe(7); // authoritative server value applied
  });

  it('catch-up refreshes preview/read state but preserves unread for the open thread', async () => {
    const fetchSpy = (
      TestBed.inject(ThreadCatchUpService) as unknown as {
        catchUp: Mock;
      }
    ).catchUp;
    fetchSpy.mockResolvedValue({
      items: [
        {
          threadId: 1,
          type: 'P2P',
          displayName: 'A',
          unreadCount: 0,
          mentionUnread: [],
          muted: false,
          lastReadSeq: 12,
          senderAvatarUrl: '',
          senderUserId: 1,
          latestMessage: {
            threadId: 1,
            seq: 12,
            contentType: 'PURE_TEXT',
            content: JSON.stringify({ text: 'sent from the open thread' }),
            creator: 1,
            createdAt: 1000,
            mediaStatus: 'ready',
            sv: 0,
          },
        },
      ],
      hasMore: false,
      scannedThrough: 0,
      messageFeedEndId: 0,
    });
    await populate([
      p2p(1, 11, {
        lastReadSeq: 10,
        unreadCount: 2,
        lastMessagePreview: 'old preview',
      }),
    ]);
    repo.setOpenThread(1);

    const applied = firstValueFrom(repo.catchUpApplied$);
    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 12, ts: 1000 },
    });
    await applied;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(repo.items()[0]).toEqual(
      expect.objectContaining({
        lastMessagePreview: 'sent from the open thread',
        lastMessageSenderId: 1,
        lastReadSeq: 12,
        unreadCount: 2,
      }),
    );
  });

  // ── per-thread dismiss-HWM (the away-notification per-thread grouping state) ─────────────────

  it('recordThreadDismiss advances a thread HWM + persists the map to IDB', async () => {
    repo.recordThreadDismiss({ threadId: 7, seq: 3 });
    await flush();
    expect(repo.threadHwms()).toEqual({ 7: 3 });
    expect(await webdb.getMeta('threadHwms')).toEqual({ 7: 3 });
  });

  it('recordThreadDismiss merges per-thread and never regresses (monotonic)', async () => {
    repo.recordThreadDismiss({ threadId: 7, seq: 5 });
    repo.recordThreadDismiss({ threadId: 9, seq: 2 });
    repo.recordThreadDismiss({ threadId: 7, seq: 3 }); // stale / lower → ignored
    await flush();
    expect(repo.threadHwms()).toEqual({ 7: 5, 9: 2 });
  });

  it('clearThreadDismiss resets the map to empty + persists {}', async () => {
    repo.recordThreadDismiss({ threadId: 7, seq: 5 });
    await flush();
    repo.clearThreadDismiss();
    await flush();
    expect(repo.threadHwms()).toEqual({});
    expect(await webdb.getMeta('threadHwms')).toEqual({});
  });

  it('clearThreadDismiss is a no-op when already empty', async () => {
    repo.clearThreadDismiss();
    await flush();
    expect(repo.threadHwms()).toEqual({});
    expect(await webdb.getMeta('threadHwms')).toBeUndefined();
  });

  it('loadThreadHwms hydrates from IDB on HELLO (boot restore of a persisted map)', async () => {
    await webdb.putMeta('threadHwms', { 7: 5, 9: 2 });
    emitHello({ userId: 1, stateFeedEndId: 5 });
    await flush(20);
    expect(repo.threadHwms()).toEqual({ 7: 5, 9: 2 });
  });

  it('session-end reset (logout) clears the thread HWMs', async () => {
    sessionUserId.set(1);
    repo.recordThreadDismiss({ threadId: 7, seq: 5 });
    await flush();
    expect(repo.threadHwms()).toEqual({ 7: 5 });
    sessionUserId.set(null); // logout → reset()
    await flush(20);
    expect(repo.threadHwms()).toEqual({});
  });
});

describe('rawPreview', () => {
  it('renders a link card title instead of leaking its JSON envelope', () => {
    expect(
      rawPreview(
        'LINK',
        JSON.stringify({
          url: 'https://example.com/article',
          title: '  An example\narticle  ',
          description: 'Description',
        }),
      ),
    ).toBe('An example article');
  });

  it('falls back to the link URL when the card has no title', () => {
    expect(
      rawPreview(
        'LINK',
        JSON.stringify({ url: 'https://example.com/article', title: '  ' }),
      ),
    ).toBe('https://example.com/article');
  });

  it('uses a link description before the URL when the provider has no title', () => {
    expect(
      rawPreview(
        'LINK',
        JSON.stringify({
          url: 'https://v.douyin.com/example',
          title: '',
          description: '  Douyin video\ncaption  ',
        }),
      ),
    ).toBe('Douyin video caption');
  });

  it('renders semantic mentions as readable labels instead of leaking the storage URI', () => {
    expect(
      rawPreview(
        'PURE_TEXT',
        JSON.stringify({
          text: '你好 [@张三](socfp://user/zhangsan%40example.com)',
          quote: {
            seq: 7,
            author: '李四',
            body: '不应进入会话摘要',
          },
        }),
      ),
    ).toBe('你好 @张三');
  });

  it('renders a forwarded bundle as a readable summary instead of raw JSON', () => {
    expect(
      rawPreview(
        'FORWARD',
        JSON.stringify({
          bundleId: 'bundle-1',
          summaryLines: ['王涛：[图片]', '李雷：你好'],
        }),
      ),
    ).toBe('[Chat history] 王涛：[图片]');
  });

  it('falls back to the forward marker for malformed bundle content', () => {
    expect(rawPreview('FORWARD', '{')).toBe('[Chat history]');
  });

  it('renders an all-file gallery as a file-set summary instead of raw JSON', () => {
    expect(
      rawPreview(
        'GALLERY',
        JSON.stringify({ items: [{ kind: 'FILE' }, { kind: 'FILE' }] }),
      ),
    ).toBe('[File set · 2]');
  });

  it('renders a mixed file set with its item count and safely handles malformed content', () => {
    expect(
      rawPreview(
        'GALLERY',
        JSON.stringify({ items: [{ kind: 'IMAGE' }, { kind: 'VIDEO' }] }),
      ),
    ).toBe('[File set · 2]');
    expect(rawPreview('GALLERY', '{')).toBe('[File set]');
  });
});
