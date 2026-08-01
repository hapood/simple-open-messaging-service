/**
 * HttpItemSource unit tests — production data layer, signal-only live contract (no DOM, no kernel).
 *
 * The DB-layer {@link MessageRepository} owns the identity-only NEW_MESSAGE SSE and emits `liveSignal$`;
 * this source filters that signal to its thread and treats it as "newer data exists, go pull." The kernel
 * pulls the body via queryMessages (IDB cache hit or backend gap-fill) on the next
 * onMessageSignal, and rawToItems shapes messages only at pull time. This is what keeps a self-send echo /
 * incoming reply on an empty (just-added-friend) thread mountable.
 *
 * The repository is stubbed (HttpItemSource only calls queryMessages + liveSignal$); UserService is stubbed
 * (ensureProfiles). The cache-first/gap-fill logic lives in MessageRepository and is tested in its own spec
 * — here the repo is a simple canned data source so this spec stays focused on the source's shaping,
 * boundary, remounting, and optimistic-pending reconcile.
 */
import { Subject, of } from 'rxjs';
import { HttpItemSource } from './http-item-source';
import { MessageRepository } from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import type {
  ConversationItem,
  Message,
  User,
  StandardResponse,
} from '../../services/model';
import type { MediaStatus } from '../message-cards/chat-item';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';

/** A P2P ConversationItem fixture (only threadId is read by HttpItemSource). */
function conv(threadId: number): ConversationItem {
  return {
    threadId,
    id: 1,
    type: 'P2P',
    lastReadSeq: null,
    role: null,
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageAt: null,
  } as unknown as ConversationItem;
}

/** A minimal Message row. The item id HttpItemSource produces is the numeric `seq`. */
function row(seq: number, creator: number, clientMessageId?: string): Message {
  return {
    seq,
    contentType: 'PURE_TEXT',
    content: 'hi',
    threadId: 42,
    creator,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    isDeleted: false,
    ...(clientMessageId !== undefined ? { clientMessageId } : {}),
  } as unknown as Message;
}

/** A pending (optimistic, status:'sending') self-text send keyed by `cid`. Mirrors makeOptimisticItem's shape. */
function pendingItem(cid: string, id = -1) {
  return {
    id,
    data: {
      type: 'msg',
      msgId: id,
      creator: 1,
      isSelf: true,
      name: 'Me',
      text: 'hi',
      time: '09:00',
      contentType: 'PURE_TEXT',
      images: null,
      file: null,
      createdAtMs: 0,
      status: 'sending',
      kind: 'pending',
    } as never,
    clientMessageId: cid,
  };
}

describe('HttpItemSource (signal-only live contract over MessageRepository)', () => {
  /** Build a source whose repository returns `dbResult` for every queryMessages call, with a drivable
   *  liveSignal$. `onSignal` is captured. */
  function setup(
    dbResult: StandardResponse<Message[]>,
    tid = 42,
    outbox = new ThreadSendOutbox(),
  ) {
    const liveSignal$ = new Subject<{ threadId: number; seq: number }>();
    // The constructor also subscribes to repo.mediaStatusLive$ (a MEDIA_STATUS re-render signal); the stub
    // must expose it or new HttpItemSource throws "Cannot read properties of undefined (reading 'pipe')".
    const mediaStatusLive$ = new Subject<{
      threadId: number;
      seq: number;
      status: MediaStatus;
    }>();
    const queryMessages = jasmine.createSpy('queryMessages').and.resolveTo({
      data: dbResult.data ?? [],
      hasMore: dbResult.hasMore ?? false,
    });
    const repo = {
      queryMessages,
      liveSignal$,
      mediaStatusLive$,
    } as unknown as MessageRepository;
    const users: User[] = [
      {
        id: 1,
        account: 'Me',
        name: 'Me',
        avatar: '',
        bio: '',
        isForeigner: false,
        domain: '',
        createdAt: 0,
        updatedAt: 0,
        isDeleted: false,
      } as unknown as User,
      {
        id: 2,
        account: 'Alice',
        name: 'Alice',
        avatar: '',
        bio: '',
        isForeigner: false,
        domain: '',
        createdAt: 0,
        updatedAt: 0,
        isDeleted: false,
      } as unknown as User,
    ];
    const queryUserInfo = jasmine
      .createSpy('queryUserInfo')
      .and.returnValue(
        of<StandardResponse<User[]>>({ code: 0, message: 'ok', data: users }),
      );
    const userService = {
      queryUserInfo,
      // The source resolves the self id LIVE from sessionUserId() at shape time (not a constructor arg), so
      // the stub must expose it — user 1 is "Me" in the fixtures above.
      sessionUserId: () => 1,
      sessionProfile: () => ({ id: 1, account: 'me@example.com' }),
    } as unknown as UserService;
    const ws = {
      reconnect$: new Subject<void>(),
    } as unknown as WebsocketService;
    const signals = jasmine.createSpy('onSignal');
    const profiles = jasmine.createSpy('onProfile');
    const src = new HttpItemSource(conv(tid), repo, userService, ws, outbox, {
      onSignal: signals,
      onProfile: profiles,
    });
    return {
      src,
      repo,
      liveSignal$,
      mediaStatusLive$,
      signals,
      profiles,
      outbox,
      queryUserInfo,
    };
  }

  it('liveSignal$ fires onSignal only for THIS thread (the repo already filtered NEW_MESSAGE)', () => {
    const { src, liveSignal$, signals } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    src.finishLocalInit(undefined);

    liveSignal$.next({ threadId: 99, seq: 100 }); // different thread → ignored
    expect(signals.calls.count()).toBe(0);

    liveSignal$.next({ threadId: 42, seq: 100 }); // THIS thread → signal
    expect(signals.calls.count()).toBe(1);
  });

  it('ignores live seqs during DB init and reconciles the global HWM after init', async () => {
    const { src, liveSignal$, signals } = setup({
      code: 0,
      message: 'ok',
      data: [row(10, 2)],
      hasMore: false,
    });

    liveSignal$.next({ threadId: 42, seq: 12 });
    expect(signals).not.toHaveBeenCalled();

    await src.init(-1, 50, 0);
    src.finishLocalInit(12);

    expect(signals).toHaveBeenCalledOnceWith(12);
  });

  it('signals a backend fill when durable thread metadata leads an empty local messages cache', async () => {
    const { src, signals } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });

    await src.init(-1, 50, 0);
    src.finishLocalInit(undefined, 258);

    expect(signals).toHaveBeenCalledOnceWith(258);
  });

  it('reconciles against the greater of the durable thread seq and live-session HWM', async () => {
    const { src, signals } = setup({
      code: 0,
      message: 'ok',
      data: [row(10, 2)],
      hasMore: false,
    });

    await src.init(-1, 50, 0);
    src.finishLocalInit(12, 11);

    expect(signals).toHaveBeenCalledOnceWith(12);
  });

  it('does not signal when the local DB tail already reaches both remote ceilings', async () => {
    const { src, signals } = setup({
      code: 0,
      message: 'ok',
      data: [row(12, 2)],
      hasMore: false,
    });

    await src.init(-1, 50, 0);
    src.finishLocalInit(12, 11);

    expect(signals).not.toHaveBeenCalled();
  });

  it('allows a post-ready getOlder top-up to backfill a one-row local cache from the backend', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [row(10, 2)],
      hasMore: true,
    });
    const queryMessages = repo.queryMessages as jasmine.Spy;

    await src.init(-1, 50, 0);
    src.finishLocalInit(undefined);
    await src.getOlder(10, 50);

    expect(queryMessages.calls.mostRecent().args).toEqual([
      42,
      { skip: 1, take: 50, lastSeq: 10, orderBy: 'desc' },
      undefined,
      false,
    ]);
  });

  it('reshapes previously seen messages when a trimmed newer edge is loaded again', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [row(12, 2), row(11, 2)],
      hasMore: false,
    });
    const queryMessages = repo.queryMessages as jasmine.Spy;

    const initial = await src.init(-1, 50, 0);
    expect(initial.map((item) => item.id)).toEqual([11, 12]);

    // Model the virtual-list lifecycle: the kernel trims these rows after the user scrolls upward,
    // then asks the source for them again while scrolling down. IDB legitimately returns ids already
    // shaped earlier in this source session; they must not be filtered by a lifetime seen-id set.
    queryMessages.and.resolveTo({
      data: [row(11, 2), row(12, 2)],
      hasMore: false,
    });
    const remounted = await src.getNewer(10, 50);

    expect(remounted.map((item) => item.id)).toEqual([11, 12]);
    expect(remounted[1].boundary).toBe('newest');
  });

  it('init(-1) returns the server echo confirming an optimistic send and drops the pending entry (empty-thread first message)', async () => {
    // The FIRST send into a fresh (empty) friend thread: the optimistic is mounted alone, the kernel's
    // loadNewer falls back to init(-1). The repo cached the echo's body + fired liveSignal$ (no id
    // pre-registered), so init's rawToItems registers the seq NOW and returns the real — the bubble
    // reconciles instead of sticking "sending".
    const cid = 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
    const echo = row(100, 1, cid);
    const { src, liveSignal$, signals } = setup({
      code: 0,
      message: 'ok',
      data: [echo],
      hasMore: false,
    });

    src.addPending({
      id: -1,
      data: {
        type: 'msg',
        msgId: -1,
        creator: 1,
        isSelf: true,
        name: 'Me',
        text: 'hi',
        time: '09:00',
        contentType: 'PURE_TEXT',
        images: null,
        file: null,
        createdAtMs: 0,
        status: 'sending',
        kind: 'pending',
      } as never,
      clientMessageId: cid,
    });
    expect(src.getPending().length).toBe(1);

    liveSignal$.next({ threadId: 42, seq: 100 }); // repo cached the echo body → signal (no shaping here)
    expect(signals).not.toHaveBeenCalled(); // DB-init signals are intentionally ignored; HWM reconciles after init
    expect(src.getPending().length).toBe(1); // pending NOT touched by the signal — only init reconciles

    const items = await src.init(-1, 50, 0); // kernel pulls the cached body via the repo
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(100);
    expect(items[0].clientMessageId).toBe(cid); // preserved so the kernel pairs it with the optimistic bubble
    expect(items[0].boundary).toBe('both'); // sole item spanning both edges of an empty thread
    expect(src.getPending().length).toBe(0); // reconcilePending dropped the confirmed optimistic
  });

  it('offline init mounts cached messages without waiting for profile hydration', async () => {
    const offline = spyOnProperty(navigator, 'onLine', 'get').and.returnValue(
      false,
    );
    const { src, queryUserInfo } = setup({
      code: 0,
      message: 'ok',
      data: [row(100, 2)],
      hasMore: false,
    });

    const items = await src.init(-1, 50, 0);
    src.finishLocalInit(undefined);

    expect(items.map((item) => item.id)).toEqual([100]);
    expect(queryUserInfo).not.toHaveBeenCalled();
    offline.and.callThrough();
  });

  it('online init does not wait for profile hydration and patches the shaped row later', async () => {
    const profile$ = new Subject<StandardResponse<User[]>>();
    const { src, queryUserInfo, profiles } = setup({
      code: 0,
      message: 'ok',
      data: [row(100, 2)],
      hasMore: false,
    });
    queryUserInfo.and.returnValue(profile$);

    const items = await src.init(-1, 50, 0);
    src.finishLocalInit(undefined);

    expect(items.map((item) => item.id)).toEqual([100]);
    expect(items[0].data.name).toBe('');
    expect(profiles).not.toHaveBeenCalled();

    profile$.next({
      code: 0,
      message: 'ok',
      data: [
        {
          id: 2,
          name: 'Alice',
        } as User,
      ],
    });
    profile$.complete();
    await Promise.resolve();

    expect(profiles).toHaveBeenCalledOnceWith(100, {
      name: 'Alice',
      avatar: '',
      avatarIdentityId: 2,
      isSelf: false,
    });
  });

  it('getNewer pulls newer messages from the DB past the "at newest" state (incoming reply mounts)', async () => {
    // After the confirm above the kernel sits at noNewer=true. A plain incoming reply fires liveSignal$;
    // the kernel's loadNewer(forced) calls getNewer, which must read through the repo despite noNewer (a
    // signal MEANS new data exists). The redundant noNewer guard was removed — the kernel's loadNewer
    // guards it for the scroll case; for the forced/signal case getNewer always queries.
    const reply = row(200, 2);
    const { src, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [reply],
      hasMore: false,
    });

    liveSignal$.next({ threadId: 42, seq: 200 }); // reply arrives → signal (kernel will pull)

    const items = await src.getNewer(100, 50); // kernel: newer-than-mounted cursor 100
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(200);
    expect(items[0].boundary).toBe('newest'); // reached the DB ceiling (hasMore false)
  });

  it('pushLive is a no-op (signal-only path caches nothing; satisfies the CbSource interface)', () => {
    const { src } = setup({ code: 0, message: 'ok', data: [], hasMore: false });
    expect(() => src.pushLive([{ id: -1, data: {} as never }])).not.toThrow();
  });

  it('restores a thread pending outbox when its HttpItemSource is recreated', () => {
    const outbox = new ThreadSendOutbox();
    const first = setup(
      { code: 0, message: 'ok', data: [], hasMore: false },
      42,
      outbox,
    ).src;
    first.addPending(pendingItem('cid-restored'));
    first.destroy();

    const reopened = setup(
      { code: 0, message: 'ok', data: [], hasMore: false },
      42,
      outbox,
    ).src;
    expect(reopened.getPending()).toEqual([
      jasmine.objectContaining({ clientMessageId: 'cid-restored' }),
    ]);
  });

  it('isolates pending outboxes by thread', () => {
    const outbox = new ThreadSendOutbox();
    setup(
      { code: 0, message: 'ok', data: [], hasMore: false },
      42,
      outbox,
    ).src.addPending(pendingItem('cid-thread-42'));

    const other = setup(
      { code: 0, message: 'ok', data: [], hasMore: false },
      99,
      outbox,
    ).src;
    expect(other.getPending()).toEqual([]);
  });

  // ---- send-success confirmation: markPendingSent + the rawToItems single-trigger "lock" ----

  it('markPendingSent flips a pending entry sending→sent IN PLACE (keeps position) and returns false when absent', () => {
    const { src } = setup({ code: 0, message: 'ok', data: [], hasMore: false });
    src.addPending(pendingItem('cid-keep-1', -1));
    src.addPending(pendingItem('cid-keep-2', -2));

    expect(src.markPendingSent('cid-keep-1')).toBe(true);
    const pending = src.getPending();
    expect(pending.length).toBe(2);
    expect(pending[0].clientMessageId).toBe('cid-keep-1'); // position KEPT (unlike failPending, which sinks to tail)
    expect(pending[0].data.status).toBe('sent');
    expect(pending[0].data.kind).toBeUndefined();
    expect(pending[1].clientMessageId).toBe('cid-keep-2'); // sibling untouched
    expect(pending[1].data.status).toBe('sending');

    expect(src.markPendingSent('no-such-cid')).toBe(false); // echo already dropped it → false (self-heal)
  });

  it('keeps attachment pending entries reconcilable without exposing duplicate per-file bubbles', () => {
    const { src } = setup({ code: 0, message: 'ok', data: [], hasMore: false });
    const image = pendingItem('cid-image');
    (image as unknown as { data: { contentType: string } }).data.contentType =
      'IMAGE';

    src.addPending(image);

    expect(src.getPending()).toEqual([]);
    expect(src.markPendingSent('cid-image')).toBe(true);
  });

  it('rawToItems: a real whose cid matches a still-sending pending entry carries status sent (SSE-first → real owns the choreography)', async () => {
    const cid = 'sse-first-cid';
    const echo = row(100, 1, cid);
    const { src, liveSignal$, outbox } = setup({
      code: 0,
      message: 'ok',
      data: [echo],
      hasMore: false,
    });
    const dispose = jasmine.createSpy('dispose');
    src.addPending(pendingItem(cid)); // HTTP 200 has NOT fired yet → still 'sending'
    outbox.retainResource(cid, {
      type: 'native-attachment',
      selection: {} as never,
      release: dispose,
      discard: jasmine.createSpy('discard'),
    });
    liveSignal$.next({ threadId: 42, seq: 100 }); // SSE echo wins the race → signal

    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBe('sent'); // SSE-first → the real carries the choreography
    expect(src.getPending().length).toBe(0); // fulfilled pending dropped
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('releases retained resources on explicit discard, but not on retryable failure', () => {
    const { src, outbox } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    const dispose = jasmine.createSpy('dispose');
    src.addPending(pendingItem('cid-discard'));
    outbox.retainResource('cid-discard', {
      type: 'native-attachment',
      selection: {} as never,
      release: jasmine.createSpy('release'),
      discard: dispose,
    });

    expect(src.failPending('cid-discard')).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    expect(src.discardPending('cid-discard')).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(outbox.resource('cid-discard')).toBeUndefined();
  });

  it('rawToItems: a real whose cid matches a sent pending entry (HTTP 200 already fired) mounts SILENT → choreography plays once', async () => {
    const cid = 'http-first-cid';
    const echo = row(100, 1, cid);
    const { src, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [echo],
      hasMore: false,
    });
    src.addPending(pendingItem(cid));
    expect(src.markPendingSent(cid)).toBe(true); // HTTP 200 won the race → pending now 'sent'

    liveSignal$.next({ threadId: 42, seq: 100 }); // SSE echo arrives after — the optimistic already played it
    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBeUndefined(); // real mounts silent → cb-confirmed is inert (play once)
  });

  it('rawToItems: a history message (no pending match) never carries a status tick', async () => {
    const echo = row(100, 1); // no clientMessageId → not an in-flight send
    const { src, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [echo],
      hasMore: false,
    });
    liveSignal$.next({ threadId: 42, seq: 100 });
    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBeUndefined();
  });

  it('rawToItems preserves the server-authored quote preview and jump target', async () => {
    const quoted = {
      ...row(101, 2),
      content: JSON.stringify({
        text: 'reply',
        quote: { seq: 44, preview: 'Alice：original message' },
      }),
    };
    const { src } = setup({
      code: 0,
      message: 'ok',
      data: [quoted],
      hasMore: false,
    });

    const items = await src.init(-1, 50, 0);

    expect(items[0].data.quote).toEqual({
      seq: 44,
      preview: 'Alice：original message',
    });
  });

  it('rejects legacy raw text instead of silently rendering or hiding it', async () => {
    const legacy = {
      ...row(101, 2),
      content: 'legacy raw message',
    };
    const { src } = setup({
      code: 0,
      message: 'ok',
      data: [legacy],
      hasMore: false,
    });

    await expectAsync(src.init(-1, 50, 0)).toBeRejectedWithError(
      'invalid PURE_TEXT message envelope',
    );
  });

  it('keeps an unavailable quote jump target with an empty preview for localized fallback', async () => {
    const quoted = {
      ...row(101, 2),
      content: JSON.stringify({ text: 'reply', quote: { seq: 44 } }),
    };
    const { src } = setup({
      code: 0,
      message: 'ok',
      data: [quoted],
      hasMore: false,
    });

    const items = await src.init(-1, 50, 0);

    expect(items[0].data.quote).toEqual({ seq: 44, preview: '' });
  });

  it('restores a persisted AUDIO message as a playable voice card after reopening the thread', async () => {
    const audio = {
      ...row(101, 1),
      contentType: 'AUDIO',
      content: JSON.stringify({
        url: '/uploads/shards/aa/bb/voice.webm',
        name: 'voice.webm',
        size: 1234,
        mimeType: 'audio/webm',
        duration: 7.5,
      }),
      mediaStatus: 'ready',
    } as unknown as Message;
    const { src } = setup({
      code: 0,
      message: 'ok',
      data: [audio],
      hasMore: false,
    });

    const items = await src.init(-1, 50, 0);

    expect(items.length).toBe(1);
    expect(items[0].data.contentType).toBe('AUDIO');
    expect(items[0].data.images?.[0]).toEqual(
      jasmine.objectContaining({
        kind: 'audio',
        src: '/uploads/shards/aa/bb/voice.webm',
        duration: 7.5,
        msgId: 101,
      }),
    );
  });
});
