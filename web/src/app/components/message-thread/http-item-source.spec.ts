/**
 * HttpItemSource unit tests — production data layer, signal-only live contract (no DOM, no kernel).
 *
 * The DB-layer {@link MessageRepository} owns the identity-only NEW_MESSAGE SSE and emits `liveSignal$`;
 * this source filters that signal to its thread and treats it as "newer data exists, go pull." The kernel
 * pulls the body via queryMessages (IDB cache hit or backend gap-fill) on the next
 * source demand, and rawToItems shapes messages only at pull time. This is what keeps a self-send echo /
 * incoming reply on an empty (just-added-friend) thread mountable.
 *
 * The repository is stubbed (HttpItemSource only calls queryMessages + liveSignal$); UserService is stubbed
 * (ensureProfiles). The cache-first/gap-fill logic lives in MessageRepository and is tested in its own spec
 * — here the repo is a simple canned data source so this spec stays focused on the source's shaping,
 * boundary, remounting, and optimistic-pending reconcile.
 */
import { firstValueFrom, Subject, of } from 'rxjs';
import { HttpItemSource } from './http-item-source';
import { MessageRepository } from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
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
    content: JSON.stringify({ text: 'hi' }),
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

describe('HttpItemSource (source-owned live demand over MessageRepository)', () => {
  /** Build a source whose repository returns `dbResult` for every queryMessages call, with a drivable liveSignal$. */
  function setup(
    dbResult: StandardResponse<Message[]>,
    tid = 42,
    outbox = new ThreadSendOutbox(),
  ) {
    const liveSignal$ = new Subject<{ threadId: number; seq: number }>();
    const reconnectSignal$ = new Subject<void>();
    let truncateSeq: number | undefined;
    liveSignal$.subscribe((signal) => {
      if (signal.threadId === tid)
        truncateSeq = Math.max(truncateSeq ?? -1, signal.seq);
    });
    reconnectSignal$.subscribe(() => (truncateSeq = undefined));
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
      reconnectSignal$,
      mediaStatusLive$,
      retainCoverage: jasmine.createSpy('retainCoverage'),
      releaseCoverage: jasmine.createSpy('releaseCoverage'),
      getNewerTruncateSeq: () => truncateSeq,
      retainNewestSeq: jasmine
        .createSpy('retainNewestSeq')
        .and.callFake((_threadId: number, seq: number) => {
          truncateSeq = Math.max(truncateSeq ?? -1, seq);
        }),
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
    const profiles = jasmine.createSpy('onProfile');
    const newerAvailable = jasmine.createSpy('onNewerAvailable');
    const src = new HttpItemSource(conv(tid), repo, userService, outbox, {
      onProfile: profiles,
      onNewerAvailable: newerAvailable,
    });
    return {
      src,
      repo,
      liveSignal$,
      reconnectSignal$,
      mediaStatusLive$,
      profiles,
      newerAvailable,
      outbox,
      queryUserInfo,
    };
  }

  it('retains coverage for the chatbox lifetime and releases it exactly once', () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    expect(repo.retainCoverage).toHaveBeenCalledTimes(1);
    expect(repo.retainCoverage).toHaveBeenCalledWith(42, undefined);
    src.destroy();
    src.destroy();
    expect(repo.releaseCoverage).toHaveBeenCalledTimes(1);
    expect(repo.releaseCoverage).toHaveBeenCalledWith(42);
  });

  it('liveSignal$ does not issue HTTP when no newer demand is mounted', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    src.finishLocalInit(undefined);

    liveSignal$.next({ threadId: 99, seq: 100 }); // different thread → ignored
    liveSignal$.next({ threadId: 42, seq: 100 });
    await Promise.resolve();
    expect((repo.queryMessages as jasmine.Spy).calls.count()).toBe(0);
  });

  it('keeps a newer demand pending at newest and resolves it after source data updates', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    src.finishLocalInit(undefined);
    const queryMessages = repo.queryMessages as jasmine.Spy;
    const demand = src.requestNewer(100, 50);
    let settled = false;
    const resultPromise = firstValueFrom(demand).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeFalse();

    queryMessages.and.resolveTo({
      data: [row(101, 2)],
      hasMore: false,
    });
    liveSignal$.next({ threadId: 42, seq: 101 });

    const result = await resultPromise;
    expect(result.kind).toBe('items');
    expect(
      result.kind === 'items' ? result.items.map((item) => item.id) : [],
    ).toEqual([101]);
  });

  it('cancels a pending newer demand without waiting for source data', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    src.finishLocalInit(undefined);
    const subscription = src.requestNewer(100, 50).subscribe();
    subscription.unsubscribe();
    const calls = (repo.queryMessages as jasmine.Spy).calls.count();
    liveSignal$.next({ threadId: 42, seq: 101 });
    await Promise.resolve();
    expect((repo.queryMessages as jasmine.Spy).calls.count()).toBe(calls);
  });

  it('emits an error result for a failed newer demand and SSE does not implicitly retry it', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [],
    });
    src.finishLocalInit(undefined);
    const queryMessages = repo.queryMessages as jasmine.Spy;
    queryMessages.and.resolveTo({ data: [], hasMore: true, failed: true });

    expect((await firstValueFrom(src.requestNewer(100, 50))).kind).toBe(
      'error',
    );
    const failedCalls = queryMessages.calls.count();
    liveSignal$.next({ threadId: 42, seq: 101 });
    await Promise.resolve();
    expect(queryMessages.calls.count()).toBe(failedCalls);

    queryMessages.and.resolveTo({ data: [row(101, 2)], hasMore: false });
    const retried = await firstValueFrom(src.requestNewer(100, 50));
    expect(
      retried.kind === 'items' ? retried.items.map((item) => item.id) : [],
    ).toEqual([101]);
  });

  it('ignores live seqs during DB init and reconciles the global HWM after init', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [row(10, 2)],
      hasMore: false,
    });

    liveSignal$.next({ threadId: 42, seq: 12 });
    await src.init(-1, 50, 0);
    (repo.queryMessages as jasmine.Spy).and.resolveTo({
      data: [],
      hasMore: false,
    });
    const subscription = src.requestNewer(10, 50).subscribe();
    src.finishLocalInit(12);
    await Promise.resolve();
    expect(
      (repo.queryMessages as jasmine.Spy).calls.mostRecent().args[1],
    ).toEqual({
      skip: 1,
      take: 50,
      lastSeq: 10,
      orderBy: 'asc',
    });
    subscription.unsubscribe();
  });

  it('signals a backend fill when durable thread metadata leads an empty local messages cache', async () => {
    const { src, repo, newerAvailable } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });

    await src.init(-1, 50, 0);
    const before = (repo.queryMessages as jasmine.Spy).calls.count();
    const subscription = src.requestNewer(-1, 50).subscribe();
    src.finishLocalInit(undefined, 258);
    await Promise.resolve();
    expect(newerAvailable).toHaveBeenCalledOnceWith(258);
    expect((repo.queryMessages as jasmine.Spy).calls.count()).toBeGreaterThan(
      before,
    );
    subscription.unsubscribe();
  });

  it('reconciles against the greater of the durable thread seq and live-session HWM', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [row(10, 2)],
      hasMore: false,
    });

    await src.init(-1, 50, 0);
    (repo.queryMessages as jasmine.Spy).and.resolveTo({
      data: [],
      hasMore: false,
    });
    const subscription = src.requestNewer(10, 50).subscribe();
    src.finishLocalInit(12, 11);
    await Promise.resolve();
    expect(
      (repo.queryMessages as jasmine.Spy).calls.mostRecent().args[1],
    ).toEqual({
      skip: 1,
      take: 50,
      lastSeq: 10,
      orderBy: 'asc',
    });
    subscription.unsubscribe();
  });

  it('keeps the right-edge HTTP walk unbounded when the HWM is ahead', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [row(11, 2)],
      hasMore: false,
    });
    const queryMessages = repo.queryMessages as jasmine.Spy;

    await src.init(-1, 50, 0);
    src.finishLocalInit(undefined, 20);
    await src.getNewer(11, 50);

    expect(queryMessages.calls.mostRecent().args[1]).toEqual({
      skip: 1,
      take: 50,
      lastSeq: 11,
      orderBy: 'asc',
    });
  });

  it('keeps the newer demand pending without querying when its cursor is already newest', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [row(50, 2)],
      hasMore: false,
    });
    const queryMessages = repo.queryMessages as jasmine.Spy;

    await src.init(-1, 50, 0);
    src.finishLocalInit(undefined, 50);
    liveSignal$.next({ threadId: 42, seq: 50 });
    const callsAfterInit = queryMessages.calls.count();
    const subscription = src.requestNewer(50, 50).subscribe();
    await Promise.resolve();

    expect(queryMessages.calls.count()).toBe(callsAfterInit);

    queryMessages.and.resolveTo({ data: [row(51, 2)], hasMore: false });
    liveSignal$.next({ threadId: 42, seq: 51 });
    await Promise.resolve();
    expect(queryMessages.calls.count()).toBe(callsAfterInit + 1);
    subscription.unsubscribe();
  });

  it('uses the shared HWM only to decide whether a newer request is needed', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    const queryMessages = repo.queryMessages as jasmine.Spy;

    src.finishLocalInit(undefined, 20);
    await src.getNewer(10, 50);
    liveSignal$.next({ threadId: 42, seq: 25 });
    await src.getNewer(20, 50);

    expect(
      queryMessages.calls
        .allArgs()
        .slice(-2)
        .map((args) => args[1]),
    ).toEqual([
      { skip: 1, take: 50, lastSeq: 10, orderBy: 'asc' },
      { skip: 1, take: 50, lastSeq: 20, orderBy: 'asc' },
    ]);
  });

  it('uses an unbounded newer walk after the repository reconnects', async () => {
    const { src, repo, reconnectSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    const queryMessages = repo.queryMessages as jasmine.Spy;

    src.finishLocalInit(undefined, 20);
    reconnectSignal$.next();
    await src.getNewer(10, 50);

    expect(queryMessages.calls.mostRecent().args[1]).toEqual({
      skip: 1,
      take: 50,
      lastSeq: 10,
      orderBy: 'asc',
    });
  });

  it('does not signal when the local DB tail already reaches both remote ceilings', async () => {
    const { src } = setup({
      code: 0,
      message: 'ok',
      data: [row(12, 2)],
      hasMore: false,
    });

    await src.init(-1, 50, 0);
    src.finishLocalInit(12, 11);
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

  it('preserves a forward card descriptor when shaping a message', async () => {
    const content = JSON.stringify({
      version: 1,
      bundleId: 'bundle-1',
      summaryLines: ['Alice：hello'],
      messageCount: 1,
      assetCount: 0,
    });
    const forwarded = {
      ...row(13, 2),
      contentType: 'FORWARD',
      content,
    } as Message;
    const { src } = setup({
      code: 0,
      message: 'ok',
      data: [forwarded],
      hasMore: false,
    });

    const items = await src.init(-1, 50, 0);

    expect(items[0].data.text).toBe(content);
  });

  it('init(-1) returns the server echo confirming an optimistic send and drops the pending entry (empty-thread first message)', async () => {
    // The FIRST send into a fresh (empty) friend thread: the optimistic is mounted alone, the kernel's
    // loadNewer falls back to init(-1). The repo cached the echo's body + fired liveSignal$ (no id
    // pre-registered), so init's rawToItems registers the seq NOW and returns the real — the bubble
    // reconciles instead of sticking "sending".
    const cid = 'b3f4a1e2-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
    const echo = row(100, 1, cid);
    const { src, liveSignal$ } = setup({
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

  it('does not lock an edge when the repository reports a retryable page failure', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [row(10, 2)],
      hasMore: true,
    });
    const queryMessages = repo.queryMessages as jasmine.Spy;
    await src.init(-1, 50, 0);
    queryMessages.and.resolveTo({ data: [], hasMore: true, failed: true });

    await expectAsync(src.getOlder(10, 50)).toBeRejected();
    await expectAsync(src.getOlder(10, 50)).toBeRejected();
    expect(queryMessages.calls.count()).toBe(3); // init + both retries; noOlder was never poisoned
  });

  it('does not turn a failed cold init into an empty-thread boundary', async () => {
    const { src, repo } = setup({ code: 0, message: 'ok', data: [] });
    const queryMessages = repo.queryMessages as jasmine.Spy;
    queryMessages.and.resolveTo({ data: [], hasMore: true, failed: true });

    await expectAsync(src.init(-1, 50, 0)).toBeRejected();
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
      partId: 'part-native',
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
      partId: 'part-discard',
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

  it('rawToItems preserves the server-authored structured reply and jump target', async () => {
    const quoted = {
      ...row(101, 2),
      content: JSON.stringify({
        text: 'reply',
        quote: {
          seq: 44,
          author: 'Alice',
          body: 'original message',
          contentType: 'PURE_TEXT',
        },
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
      author: 'Alice',
      body: 'original message',
      contentType: 'PURE_TEXT',
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

    expect(items[0].data.quote).toEqual({ seq: 44 });
  });

  it('restores a persisted AUDIO message as a playable voice card after reopening the thread', async () => {
    const audio = {
      ...row(101, 1),
      contentType: 'AUDIO',
      content: JSON.stringify({
        url: '/uploads/cas/aa/bb/voice.webm',
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
        src: '/uploads/cas/aa/bb/voice.webm',
        duration: 7.5,
        msgId: 101,
      }),
    );
  });
});
