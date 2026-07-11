/**
 * HttpItemSource unit tests — production data layer, signal-only SSE contract (no DOM, no kernel).
 *
 * The SSE NEW_MESSAGE frame is treated purely as a SIGNAL ("newer data exists for this thread"); the body is
 * NOT shaped or cached here (the conversation-list preview reads the body in its own subscriber). The kernel
 * pulls from the DB on the next onMessageSignal via getNewer / init(-1), and rawToItems registers ids ONCE —
 * at pull time. This is what keeps a self-send echo / incoming reply on an empty (just-added-friend) thread
 * from being deduped away (the old shape-at-SSE-time pre-registered the id, then init(-1)'s rawToItems dropped
 * it → optimistic bubble stuck "sending", replies never mounted).
 *
 * MsgService is stubbed (HttpItemSource only calls queryMessageLog); UserService is stubbed (ensureProfiles).
 * The SSE path is driven through the real onSseEvent subscription so the signal-only contract is exercised
 * exactly as in production.
 */
import { Subject } from 'rxjs';
import { of } from 'rxjs';
import { HttpItemSource } from './http-item-source';
import { MsgService } from '../../services/message.service';
import { UserService } from '../../services/user.service';
import { WebsocketService, type StandardMessage } from '../../services/websocket.service';
import type { ConversationItem, Message, User, StandardResponse } from '../../services/model';

/** A P2P ConversationItem fixture (only threadId is read by HttpItemSource). */
function conv(threadId: number): ConversationItem {
  return { threadId, id: 1, type: 'P2P', lastReadMsgId: '0', role: null, unreadCount: 0,
    lastMessagePreview: null, lastMessageAt: null } as unknown as ConversationItem;
}

/** A minimal Message row. The item id HttpItemSource produces is the numeric `seq` (the old BigInt wire `id`
 *  field is gone — Message.seq is now the seq cursor rawToItems reads). */
function row(seq: number, creator: number, clientMessageId?: string): Message {
  return {
    seq, contentType: 'PURE_TEXT', content: 'hi', threadId: 42, creator,
    createdAt: 1700000000000, updatedAt: 1700000000000, isDeleted: false,
    ...(clientMessageId !== undefined ? { clientMessageId } : {}),
  } as unknown as Message;
}

/** A NEW_MESSAGE SSE frame for the given message, addressed to `tid`. */
function sseFrame(m: Message, tid: number): StandardMessage {
  return { event: 'NEW_MESSAGE', status: 0, message: 'ok', data: { ...m, threadId: tid } };
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

describe('HttpItemSource (signal-only SSE contract)', () => {
  /** Build a source whose MsgService returns `dbResult` for every query-messages call. `onSignal` is captured. */
  function setup(dbResult: StandardResponse<Message[]>, tid = 42) {
    const msgService = {
      queryMessageLog: jasmine.createSpy('queryMessageLog').and.returnValue(of(dbResult)),
    } as unknown as MsgService;
    const users: User[] = [
      { id: 1, account: 'Me', isForeigner: false, createdAt: 0, updatedAt: 0, isDeleted: false } as unknown as User,
      { id: 2, account: 'Alice', isForeigner: false, createdAt: 0, updatedAt: 0, isDeleted: false } as unknown as User,
    ];
    const userService = {
      queryUserInfo: jasmine.createSpy('queryUserInfo').and.returnValue(of<StandardResponse<User[]>>({ code: 0, message: 'ok', data: users })),
    } as unknown as UserService;
    const ws = { eventSubject: new Subject<StandardMessage>(), reconnect$: new Subject<void>() } as unknown as WebsocketService;
    const signals = jasmine.createSpy('onSignal');
    const src = new HttpItemSource(conv(tid), 1, msgService, userService, ws, { onSignal: signals });
    return { src, ws, signals, msgService };
  }

  it('onSseEvent fires onSignal for a NEW_MESSAGE on THIS thread, and ignores everything else', () => {
    const { ws, signals } = setup({ code: 0, message: 'ok', data: [], hasMore: false });

    ws.eventSubject.next({ event: 'PING', status: 0, message: '' });              // not NEW_MESSAGE → ignored
    ws.eventSubject.next(sseFrame(row(100, 2), 99));                              // different thread → ignored
    ws.eventSubject.next({ event: 'NEW_MESSAGE', status: 1, message: 'err' });    // non-zero status → ignored

    expect(signals.calls.count()).toBe(0);

    ws.eventSubject.next(sseFrame(row(100, 2), 42));                              // THIS thread → signal
    expect(signals.calls.count()).toBe(1);
  });

  it('init(-1) returns the server echo confirming an optimistic send and drops the pending entry (empty-thread first message)', async () => {
    // The FIRST send into a fresh (empty) friend thread: the optimistic is mounted alone, the kernel's
    // loadNewer falls back to init(-1). The SSE echo fired onSignal (no id pre-registered), so init's
    // rawToItems registers the id NOW and returns the real — the bubble reconciles instead of sticking "sending".
    const cid = 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
    const echo = row(100, 1, cid);
    const { src, ws, signals } = setup({ code: 0, message: 'ok', data: [echo], hasMore: false });

    src.addPending({ id: -1, data: { type: 'msg', msgId: -1, creator: 1, isSelf: true, name: 'Me',
      text: 'hi', time: '09:00', contentType: 'PURE_TEXT', images: null, file: null, createdAtMs: 0,
      status: 'sending', kind: 'pending' } as never, clientMessageId: cid });
    expect(src.getPending().length).toBe(1);

    ws.eventSubject.next(sseFrame(echo, 42));   // server echo → onSignal (no shaping, no caching)
    expect(signals).toHaveBeenCalled();
    expect(src.getPending().length).toBe(1);    // pending NOT touched by the signal — only init reconciles

    const items = await src.init(-1, 50, 0);    // kernel pulls from DB (the all-optimistic fallback)
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(100);
    expect(items[0].clientMessageId).toBe(cid); // preserved so the kernel pairs it with the optimistic bubble
    expect(items[0].boundary).toBe('both');      // sole item spanning both edges of an empty thread
    expect(src.getPending().length).toBe(0);     // reconcilePending dropped the confirmed optimistic
  });

  it('getNewer pulls newer messages from the DB past the "at newest" state (incoming reply mounts)', async () => {
    // After the confirm above the kernel sits at noNewer=true. A plain incoming reply fires onSignal; the
    // kernel's loadNewer(forced) calls getNewer, which must query the DB despite noNewer (a signal MEANS new
    // data exists). The redundant noNewer guard was removed — the kernel's loadNewer guards it for the scroll
    // case; for the forced/signal case getNewer always queries.
    const reply = row(200, 2);
    const { src, ws } = setup({ code: 0, message: 'ok', data: [reply], hasMore: false });

    ws.eventSubject.next(sseFrame(reply, 42));   // reply arrives → onSignal (kernel will pull)

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
    const { src, ws } = setup({ code: 0, message: 'ok', data: [echo], hasMore: false });
    src.addPending(pendingItem(cid));                              // HTTP 200 has NOT fired yet → still 'sending'
    ws.eventSubject.next(sseFrame(echo, 42));                      // SSE echo wins the race → onSignal

    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBe('sent');                    // SSE-first → the real carries the choreography
    expect(src.getPending().length).toBe(0);                      // fulfilled pending dropped
  });

  it('rawToItems: a real whose cid matches a sent pending entry (HTTP 200 already fired) mounts SILENT → choreography plays once', async () => {
    const cid = 'http-first-cid';
    const echo = row(100, 1, cid);
    const { src, ws } = setup({ code: 0, message: 'ok', data: [echo], hasMore: false });
    src.addPending(pendingItem(cid));
    expect(src.markPendingSent(cid)).toBe(true);                  // HTTP 200 won the race → pending now 'sent'

    ws.eventSubject.next(sseFrame(echo, 42));                      // SSE echo arrives after — the optimistic already played it
    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBeUndefined();                 // real mounts silent → cb-confirmed is inert (play once)
  });

  it('rawToItems: a history message (no pending match) never carries a status tick', async () => {
    const echo = row(100, 1);                                      // no clientMessageId → not an in-flight send
    const { src, ws } = setup({ code: 0, message: 'ok', data: [echo], hasMore: false });
    ws.eventSubject.next(sseFrame(echo, 42));
    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBeUndefined();
  });
});
