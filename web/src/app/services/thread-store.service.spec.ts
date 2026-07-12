import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import { WebdbService } from './webdb.service';
import { ThreadRepository } from './thread-store.service';
import { ProfileRepository } from './profile-store.service';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { ConversationItem, User } from './model';

/** Flush the microtask + macrotask queue so the async boot (IDB read + Observable awaits) settles. */
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
    lastMessageSenderName: null,
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

describe('ThreadRepository', () => {
  let repo: ThreadRepository;
  let webdb: WebdbService;
  let eventSubject: Subject<{ event: string; data?: unknown }>;
  let reconnect$: Subject<void>;
  let sessionProfile: ReturnType<typeof signal<User | undefined>>;
  let queryAllUserThreadsSpy: jasmine.Spy;
  let queryThreadDeltaSpy: jasmine.Spy;
  let getThreadInfoSpy: jasmine.Spy;
  let advanceCursorSpy: jasmine.Spy;
  let cursorSignal: ReturnType<typeof signal<number | undefined>>;
  let putProfileSpy: jasmine.Spy;

  beforeEach(async () => {
    eventSubject = new Subject();
    reconnect$ = new Subject();
    sessionProfile = signal<User | undefined>({ id: 1 } as User);
    cursorSignal = signal<number | undefined>(10);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ThreadRepository,
        WebdbService,
        {
          provide: ProfileRepository,
          useValue: { putProfile: jasmine.createSpy('putProfile').and.resolveTo(undefined) },
        },
        {
          provide: WebsocketService,
          useValue: { eventSubject, reconnect$ },
        },
        {
          provide: UserService,
          useValue: {
            sessionProfile,
            ensureProfile: () => of({ id: 1, threadRevision: 10 } as User),
            queryAllUserThreads: (queryAllUserThreadsSpy = jasmine.createSpy('queryAllUserThreads')),
            queryThreadDelta: (queryThreadDeltaSpy = jasmine.createSpy('queryThreadDelta')),
            getThreadInfo: (getThreadInfoSpy = jasmine.createSpy('getThreadInfo')),
            syncPeerProfile: () => of({ code: 0 }),
            markRead: () => of({ code: 0 }),
            threadRevCursor: () => cursorSignal(),
            advanceThreadRevCursor: (advanceCursorSpy = jasmine.createSpy('advanceThreadRevCursor').and.callFake((r: number) => cursorSignal.set(r))),
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

  it('boot reads cached items from IDB and keeps them when the refresh snapshot fails', async () => {
    // First boot (force): snapshot [7, 8] → painted + persisted to IDB (write-through).
    queryAllUserThreadsSpy.and.returnValue(of([p2p(7, 77), p2p(8, 88)]));
    repo.load({ force: true });
    await flush(20);
    expect(repo.items().map((t) => t.threadId).sort()).toEqual([7, 8]);
    expect((await (await webdb.db()).getAll('threads')).map((t) => t.threadId).sort()).toEqual([7, 8]);

    // Second boot (non-force): reads the cache (paints [7, 8]), then the refresh snapshot FAILS — the
    // cached paint must survive (boot-from-cache keeps the list usable on a transient outage).
    queryAllUserThreadsSpy.and.returnValue(throwError(() => new Error('net')));
    repo.load(); // non-force: status is READY → proceeds → reads cache
    await flush(20);
    expect(repo.items().map((t) => t.threadId).sort()).toEqual([7, 8]);
    expect(repo.status()).toBe('READY');
  });

  it('boot with no cache loads the snapshot and sets READY', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11), p2p(2, 22)]));
    repo.load({ force: true });
    await flush(20);
    expect(repo.items().map((t) => t.threadId).sort()).toEqual([1, 2]);
    expect(repo.status()).toBe('READY');
  });

  it('onNewMessage bumps unread (closed thread, someone else) and reorders to the tier head', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11, { lastMessageAt: 100 }), p2p(2, 22, { lastMessageAt: 200 })]));
    repo.load({ force: true });
    await flush(20);

    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 100, contentType: 'PURE_TEXT', content: 'hello', creator: 11, createdAt: 300 },
    });
    await flush(); // let the IDB write-through settle

    const items = repo.items();
    expect(items[0].threadId).toBe(1); // bumped to the head of the unpinned tier
    expect(items[0].unreadCount).toBe(1);
    expect(items[0].lastMessagePreview).toBe('hello');
    // Write-through: the IDB record carries the new preview + unread.
    const rec = await (await webdb.db()).get('threads', 1);
    expect(rec?.lastMessagePreview).toBe('hello');
    expect(rec?.unreadCount).toBe(1);
  });

  it('onNewMessage does not badge the open thread', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11)]));
    repo.load({ force: true });
    await flush(20);
    repo.setOpenThread(1);

    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 100, contentType: 'PURE_TEXT', content: 'hi', creator: 11, createdAt: 300 },
    });
    await flush();
    expect(repo.items()[0].unreadCount).toBe(0);
  });

  it('onNewMessage does not badge the sender\'s own message', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11, { unreadCount: 2 })]));
    repo.load({ force: true });
    await flush(20);

    eventSubject.next({
      event: 'NEW_MESSAGE',
      data: { threadId: 1, seq: 100, contentType: 'PURE_TEXT', content: 'me', creator: 1, createdAt: 300 },
    });
    await flush();
    expect(repo.items()[0].unreadCount).toBe(2); // unchanged
  });

  it('onNewMessage dedupes a redelivered frame (same seq)', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11)]));
    repo.load({ force: true });
    await flush(20);

    const frame = { threadId: 1, seq: 100, contentType: 'PURE_TEXT', content: 'x', creator: 11, createdAt: 300 };
    eventSubject.next({ event: 'NEW_MESSAGE', data: frame });
    await flush();
    eventSubject.next({ event: 'NEW_MESSAGE', data: frame }); // redelivery
    await flush();
    expect(repo.items()[0].unreadCount).toBe(1); // bumped once, not twice
  });

  it('applyThreadMeta patches the row, re-sorts (pin), and writes through to IDB', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11, { lastMessageAt: 100 }), p2p(2, 22, { lastMessageAt: 200 })]));
    repo.load({ force: true });
    await flush(20);

    repo.applyThreadMeta(1, { pinned: true, pinnedAt: 500 });
    await flush();

    const items = repo.items();
    expect(items[0].threadId).toBe(1); // pinned → top
    expect(items[0].pinned).toBe(true);
    const rec = await (await webdb.db()).get('threads', 1);
    expect(rec?.pinned).toBe(true);
  });

  it('removeThread drops the item from the list AND IDB', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11), p2p(2, 22)]));
    repo.load({ force: true });
    await flush(20);

    repo.removeThread(1);
    await flush();
    expect(repo.items().map((t) => t.threadId)).toEqual([2]);
    expect(await (await webdb.db()).get('threads', 1)).toBeUndefined();
  });

  it('THREAD_REVISION_UPDATED delta: DELETE removes locally, ADD fetches + inserts, cursor advances', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11), p2p(2, 22)]));
    repo.load({ force: true });
    await flush(20);

    // Delta: delete thread 1, add thread 3 (fetched via getThreadInfo).
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [
      { threadId: 1, direction: 'DELETE', revision: 11 },
      { threadId: 3, direction: 'ADD', revision: 12 },
    ] }));
    getThreadInfoSpy.and.returnValue(of({ code: 0, data: p2p(3, 33) }));

    eventSubject.next({ event: 'THREAD_REVISION_UPDATED', data: { revision: 12 } });
    await flush(20);

    expect(repo.items().map((t) => t.threadId).sort()).toEqual([2, 3]);
    expect(advanceCursorSpy).toHaveBeenCalledWith(12);
    // The added thread is persisted; the deleted one is gone from IDB.
    expect(await (await webdb.db()).get('threads', 3)).toBeDefined();
    expect(await (await webdb.db()).get('threads', 1)).toBeUndefined();
  });

  it('THREAD_REVISION_UPDATED is dropped while the cursor is unseeded (boot not complete)', async () => {
    cursorSignal.set(undefined);
    queryThreadDeltaSpy.and.returnValue(of({ code: 0, data: [] }));
    eventSubject.next({ event: 'THREAD_REVISION_UPDATED', data: { revision: 12 } });
    await flush(20);
    expect(queryThreadDeltaSpy).not.toHaveBeenCalled();
  });

  it('PEER_PROFILE_UPDATED patches the matching P2P row by peerUser.id and writes the profile through', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11, { peerUser: { id: 11, name: 'Old', account: 'u11', avatar: '/old.webp', bio: '', isForeigner: false, domain: '', createdAt: 0, updatedAt: 0, isDeleted: false } as User })]));
    repo.load({ force: true });
    await flush(20);

    eventSubject.next({
      event: 'PEER_PROFILE_UPDATED',
      data: { id: 11, name: 'New', account: 'u11', avatar: '/new.webp', bio: 'b', isForeigner: false, domain: '', createdAt: 0, updatedAt: 0, isDeleted: false },
    });
    await flush();

    expect(repo.items()[0].peerUser.name).toBe('New');
    // Profile write-through fires for the embedded peer profile.
    expect(putProfileSpy).toHaveBeenCalledWith('u11', 'user', jasmine.objectContaining({ name: 'New' }));
  });

  it('reconnect triggers a force boot (snapshot refresh)', async () => {
    queryAllUserThreadsSpy.and.returnValue(of([p2p(1, 11)]));
    repo.load({ force: true });
    await flush(20);
    queryAllUserThreadsSpy.calls.reset();

    reconnect$.next();
    await flush(20);
    expect(queryAllUserThreadsSpy).toHaveBeenCalled();
  });
});
