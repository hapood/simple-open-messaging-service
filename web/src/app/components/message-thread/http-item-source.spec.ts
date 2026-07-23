/**
 * HttpItemSource unit tests — production data layer, signal-only live contract (no DOM, no kernel).
 *
 * The DB-layer {@link MessageRepository} owns the NEW_MESSAGE SSE (caches the body, then emits
 * `liveSignal$`); this source filters that signal to its thread and treats it as "newer data exists, go
 * pull." The kernel pulls the cached body via queryMessages (init(-1) / getNewer) on the next
 * onMessageSignal, and rawToItems registers seqs ONCE — at pull time. This is what keeps a self-send echo
 * / incoming reply on an empty (just-added-friend) thread from being deduped away (the old shape-at-
 * SSE-time pre-registered the id, then init(-1)'s rawToItems dropped it → optimistic bubble stuck
 * "sending", replies never mounted).
 *
 * The repository is stubbed (HttpItemSource only calls queryMessages + liveSignal$); UserService is stubbed
 * (ensureProfiles). The cache-first/gap-fill logic lives in MessageRepository and is tested in its own spec
 * — here the repo is a simple canned data source so this spec stays focused on the source's shaping,
 * boundary, dedup, and optimistic-pending reconcile.
 */
import { Subject, of } from 'rxjs';
import { HttpItemSource } from './http-item-source';
import { MessageRepository } from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import type { ConversationItem, Message, User, StandardResponse } from '../../services/model';
import type { MediaStatus } from '../message-cards/chat-item';

/** A P2P ConversationItem fixture (only threadId is read by HttpItemSource). */
function conv(threadId: number): ConversationItem {
  return { threadId, id: 1, type: 'P2P', lastReadSeq: null, role: null, unreadCount: 0,
    lastMessagePreview: null, lastMessageAt: null } as unknown as ConversationItem;
}

/** A minimal Message row. The item id HttpItemSource produces is the numeric `seq`. */
function row(seq: number, creator: number, clientMessageId?: string): Message {
  return {
    seq, contentType: 'PURE_TEXT', content: 'hi', threadId: 42, creator,
    createdAt: 1700000000000, updatedAt: 1700000000000, isDeleted: false,
    ...(clientMessageId !== undefined ? { clientMessageId } : {}),
  } as unknown as Message;
}

/** A pending (optimistic, status:'sending') self-text send keyed by `cid`. Mirrors makeOptimisticItem's shape. */
function pendingItem(cid: string, id = -1) {
  return {
    id,
    data: {
      type: 'msg', msgId: id, creator: 1, isSelf: true, name: 'Me',
      text: 'hi', time: '09:00', contentType: 'PURE_TEXT', images: null, file: null, createdAtMs: 0,
      status: 'sending', kind: 'pending',
    } as never,
    clientMessageId: cid,
  };
}

describe('HttpItemSource (signal-only live contract over MessageRepository)', () => {
  /** Build a source whose repository returns `dbResult` for every queryMessages call, with a drivable
   *  liveSignal$. `onSignal` is captured. */
  function setup(dbResult: StandardResponse<Message[]>, tid = 42) {
    const liveSignal$ = new Subject<{ threadId: number; seq: number }>();
    // The constructor also subscribes to repo.mediaStatusLive$ (a MEDIA_STATUS re-render signal); the stub
    // must expose it or new HttpItemSource throws "Cannot read properties of undefined (reading 'pipe')".
    const mediaStatusLive$ = new Subject<{ threadId: number; seq: number; status: MediaStatus }>();
    const queryMessages = jasmine.createSpy('queryMessages').and.resolveTo({
      data: dbResult.data ?? [],
      hasMore: dbResult.hasMore ?? false,
    });
    const repo = { queryMessages, liveSignal$, mediaStatusLive$ } as unknown as MessageRepository;
    const users: User[] = [
      { id: 1, account: 'Me', name: 'Me', avatar: '', bio: '', isForeigner: false, domain: '', createdAt: 0, updatedAt: 0, isDeleted: false } as unknown as User,
      { id: 2, account: 'Alice', name: 'Alice', avatar: '', bio: '', isForeigner: false, domain: '', createdAt: 0, updatedAt: 0, isDeleted: false } as unknown as User,
    ];
    const userService = {
      queryUserInfo: jasmine.createSpy('queryUserInfo').and.returnValue(of<StandardResponse<User[]>>({ code: 0, message: 'ok', data: users })),
      // The source resolves the self id LIVE from sessionUserId() at shape time (not a constructor arg), so
      // the stub must expose it — user 1 is "Me" in the fixtures above.
      sessionUserId: () => 1,
    } as unknown as UserService;
    const ws = { reconnect$: new Subject<void>() } as unknown as WebsocketService;
    const signals = jasmine.createSpy('onSignal');
    const src = new HttpItemSource(conv(tid), repo, userService, ws, { onSignal: signals });
    return { src, repo, liveSignal$, mediaStatusLive$, signals };
  }

  it('liveSignal$ fires onSignal only for THIS thread (the repo already filtered NEW_MESSAGE)', () => {
    const { liveSignal$, signals } = setup({ code: 0, message: 'ok', data: [], hasMore: false });

    liveSignal$.next({ threadId: 99, seq: 100 }); // different thread → ignored
    expect(signals.calls.count()).toBe(0);

    liveSignal$.next({ threadId: 42, seq: 100 }); // THIS thread → signal
    expect(signals.calls.count()).toBe(1);
  });

  it('init(-1) returns the server echo confirming an optimistic send and drops the pending entry (empty-thread first message)', async () => {
    // The FIRST send into a fresh (empty) friend thread: the optimistic is mounted alone, the kernel's
    // loadNewer falls back to init(-1). The repo cached the echo's body + fired liveSignal$ (no id
    // pre-registered), so init's rawToItems registers the seq NOW and returns the real — the bubble
    // reconciles instead of sticking "sending".
    const cid = 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
    const echo = row(100, 1, cid);
    const { src, liveSignal$, signals } = setup({ code: 0, message: 'ok', data: [echo], hasMore: false });

    src.addPending({ id: -1, data: { type: 'msg', msgId: -1, creator: 1, isSelf: true, name: 'Me',
      text: 'hi', time: '09:00', contentType: 'PURE_TEXT', images: null, file: null, createdAtMs: 0,
      status: 'sending', kind: 'pending' } as never, clientMessageId: cid });
    expect(src.getPending().length).toBe(1);

    liveSignal$.next({ threadId: 42, seq: 100 });   // repo cached the echo body → signal (no shaping here)
    expect(signals).toHaveBeenCalled();
    expect(src.getPending().length).toBe(1);    // pending NOT touched by the signal — only init reconciles

    const items = await src.init(-1, 50, 0);    // kernel pulls the cached body via the repo
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(100);
    expect(items[0].clientMessageId).toBe(cid); // preserved so the kernel pairs it with the optimistic bubble
    expect(items[0].boundary).toBe('both');      // sole item spanning both edges of an empty thread
    expect(src.getPending().length).toBe(0);     // reconcilePending dropped the confirmed optimistic
  });

  it('getNewer pulls newer messages from the DB past the "at newest" state (incoming reply mounts)', async () => {
    // After the confirm above the kernel sits at noNewer=true. A plain incoming reply fires liveSignal$;
    // the kernel's loadNewer(forced) calls getNewer, which must read through the repo despite noNewer (a
    // signal MEANS new data exists). The redundant noNewer guard was removed — the kernel's loadNewer
    // guards it for the scroll case; for the forced/signal case getNewer always queries.
    const reply = row(200, 2);
    const { src, liveSignal$ } = setup({ code: 0, message: 'ok', data: [reply], hasMore: false });

    liveSignal$.next({ threadId: 42, seq: 200 });   // reply arrives → signal (kernel will pull)

    const items = await src.getNewer(100, 50); // kernel: newer-than-mounted cursor 100
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(200);
    expect(items[0].boundary).toBe('newest');    // reached the DB ceiling (hasMore false)
  });

  it('pushLive is a no-op (signal-only path caches nothing; satisfies the CbSource interface)', () => {
    const { src } = setup({ code: 0, message: 'ok', data: [], hasMore: false });
    expect(() => src.pushLive([{ id: -1, data: {} as never }])).not.toThrow();
  });

  // ---- send-success confirmation: markPendingSent + the rawToItems single-trigger "lock" ----

  it('markPendingSent flips a pending entry sending→sent IN PLACE (keeps position) and returns false when absent', () => {
    const { src } = setup({ code: 0, message: 'ok', data: [], hasMore: false });
    src.addPending(pendingItem('cid-keep-1', -1));
    src.addPending(pendingItem('cid-keep-2', -2));

    expect(src.markPendingSent('cid-keep-1')).toBe(true);
    const pending = src.getPending();
    expect(pending.length).toBe(2);
    expect(pending[0].clientMessageId).toBe('cid-keep-1');        // position KEPT (unlike failPending, which sinks to tail)
    expect(pending[0].data.status).toBe('sent');
    expect(pending[0].data.kind).toBeUndefined();
    expect(pending[1].clientMessageId).toBe('cid-keep-2');        // sibling untouched
    expect(pending[1].data.status).toBe('sending');

    expect(src.markPendingSent('no-such-cid')).toBe(false);       // echo already dropped it → false (self-heal)
  });

  it('rawToItems: a real whose cid matches a still-sending pending entry carries status sent (SSE-first → real owns the choreography)', async () => {
    const cid = 'sse-first-cid';
    const echo = row(100, 1, cid);
    const { src, liveSignal$ } = setup({ code: 0, message: 'ok', data: [echo], hasMore: false });
    src.addPending(pendingItem(cid));                              // HTTP 200 has NOT fired yet → still 'sending'
    liveSignal$.next({ threadId: 42, seq: 100 });                  // SSE echo wins the race → signal

    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBe('sent');                    // SSE-first → the real carries the choreography
    expect(src.getPending().length).toBe(0);                      // fulfilled pending dropped
  });

  it('rawToItems: a real whose cid matches a sent pending entry (HTTP 200 already fired) mounts SILENT → choreography plays once', async () => {
    const cid = 'http-first-cid';
    const echo = row(100, 1, cid);
    const { src, liveSignal$ } = setup({ code: 0, message: 'ok', data: [echo], hasMore: false });
    src.addPending(pendingItem(cid));
    expect(src.markPendingSent(cid)).toBe(true);                  // HTTP 200 won the race → pending now 'sent'

    liveSignal$.next({ threadId: 42, seq: 100 });                  // SSE echo arrives after — the optimistic already played it
    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBeUndefined();                 // real mounts silent → cb-confirmed is inert (play once)
  });

  it('rawToItems: a history message (no pending match) never carries a status tick', async () => {
    const echo = row(100, 1);                                      // no clientMessageId → not an in-flight send
    const { src, liveSignal$ } = setup({ code: 0, message: 'ok', data: [echo], hasMore: false });
    liveSignal$.next({ threadId: 42, seq: 100 });
    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBeUndefined();
  });
});
