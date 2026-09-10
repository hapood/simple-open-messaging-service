import type { Mock } from 'vitest';
/**
 * HttpItemSource unit tests — production data layer, signal-only live contract (no DOM, no kernel).
 *
 * The DB-layer {@link MessageRepository} turns durable content heads into `liveSignal$` updates;
 * this source filters that signal to its thread and treats it as "newer data exists, go pull." The kernel
 * pulls the body through the repository history walker on the next source demand, and rawToItems shapes
 * messages only at pull time. This is what keeps a self-send echo /
 * incoming reply on an empty (just-added-friend) thread mountable.
 *
 * The repository walker and live signals are stubbed; UserService is stubbed
 * (ensureProfiles). The cache-first/gap-fill logic lives in MessageRepository and is tested in its own spec
 * — here the repo is a simple canned data source so this spec stays focused on the source's shaping,
 * boundary, remounting, and optimistic-pending reconcile.
 */
import { firstValueFrom, Subject, of } from 'rxjs';
import { HttpItemSource } from './http-item-source';
import { MessageRepository } from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import {
  ProfileResolutionService,
  type ResolvedProfile,
} from '../../services/profile-resolution.service';
import type {
  ConversationItem,
  Message,
  User,
  StandardResponse,
} from '../../services/model';
import type { MediaStatus } from '../message-cards/chat-item';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { ProfileRepository } from '../../services/profile-store.service';

/** A P2P ConversationItem fixture (only threadId is read by HttpItemSource). */
function conv(threadId: number): ConversationItem {
  return {
    threadId,
    authorityNamespaceId: 0,
    id: 1,
    type: 'P2P',
    lastReadSeq: null,
    role: null,
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageAt: null,
    peerUser: {
      id: 2,
      account: 'alice',
      name: 'Alice',
      domain: 'local',
      namespaceId: 0,
      avatar: '',
    },
  } as unknown as ConversationItem;
}

/** A minimal Message row. The item id HttpItemSource produces is the numeric `seq`. */
function row(seq: number, creator: number, clientMessageId?: string): Message {
  return {
    seq,
    contentType: 'PURE_TEXT',
    content: JSON.stringify({ text: 'hi' }),
    threadId: 42,
    creator:
      creator === 1
        ? { account: 'me', domain: 'local', namespaceId: 0 }
        : { account: 'alice', domain: 'local', namespaceId: 0 },
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
      creator: JSON.stringify([0, 'local', 'me']),
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
  /** Build a source whose repository walker returns `dbResult`, with a drivable liveSignal$. */
  function setup(
    dbResult: StandardResponse<Message[]>,
    tid = 42,
    outbox = new ThreadSendOutbox(),
    profileResolver?: ProfileResolutionService,
  ) {
    const liveSignal$ = new Subject<{
      threadId: number;
      seq: number;
    }>();
    const deletedLive$ = new Subject<{ threadId: number; seqs: number[] }>();
    const getDeletedMessageSeqs = vi.fn().mockResolvedValue([]);
    const onQuoteDeleted = vi.fn();
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
    const queryMessages = vi
      .fn()
      .mockName('queryMessages')
      .mockResolvedValue({
        data: dbResult.data ?? [],
        hasMore: dbResult.hasMore ?? false,
      });
    const queryNativeMessageHistory = vi
      .fn()
      .mockName('queryNativeMessageHistory')
      .mockResolvedValue({
        items: (dbResult.data ?? []).map((message) => ({
          kind: 'message' as const,
          message,
        })),
        hasOlder: dbResult.hasMore ?? false,
        hasNewer: false,
        failed: false,
      });
    const queryBrowserMessageHistory = vi
      .fn()
      .mockName('queryBrowserMessageHistory')
      .mockImplementation(
        async (
          _threadId: number,
          demand:
            | { kind: 'latest'; count: number }
            | {
                kind: 'around';
                anchor: number;
                olderCount: number;
                newerCount: number;
              }
            | { kind: 'older'; before: number; count: number }
            | { kind: 'newer'; after: number; count: number },
        ) => {
          const run = async (query: Record<string, unknown>) =>
            (queryMessages as Mock)(tid, query, undefined, true);
          if (demand.kind === 'around') {
            const [older, newer] = await Promise.all([
              run({
                skip: 0,
                take: demand.olderCount,
                lastSeq: demand.anchor,
                orderBy: 'desc',
              }),
              run({
                skip: 1,
                take: demand.newerCount,
                lastSeq: demand.anchor,
                orderBy: 'asc',
              }),
            ]);
            return {
              items: [
                ...(older.data ?? []).slice().reverse(),
                ...(newer.data ?? []),
              ].map((message: Message) => ({ kind: 'message', message })),
              hasOlder: older.hasMore ?? false,
              hasNewer: newer.hasMore ?? false,
              failed: older.failed === true || newer.failed === true,
            };
          }
          const orderBy = demand.kind === 'newer' ? 'asc' : 'desc';
          const page = await run({
            skip: demand.kind === 'latest' ? 0 : 1,
            take: demand.count,
            ...(demand.kind === 'older'
              ? { lastSeq: demand.before }
              : demand.kind === 'newer'
                ? { lastSeq: demand.after }
                : {}),
            orderBy,
          });
          const messages =
            orderBy === 'desc'
              ? (page.data ?? []).slice().reverse()
              : (page.data ?? []);
          return {
            items: messages.map((message: Message) => ({
              kind: 'message',
              message,
            })),
            hasOlder: demand.kind === 'newer' ? true : (page.hasMore ?? false),
            hasNewer: demand.kind === 'newer' ? (page.hasMore ?? false) : false,
            failed: page.failed === true,
          };
        },
      );
    const repo = {
      queryMessages,
      deletedLive$,
      getDeletedMessageSeqs,
      queryNativeMessageHistory,
      queryBrowserMessageHistory,
      liveSignal$,
      reconnectSignal$,
      mediaStatusLive$,
      syncDeleted: vi.fn().mockResolvedValue(undefined),
      retainNewestSeq: vi
        .fn()
        .mockName('retainNewestSeq')
        .mockImplementation((_threadId: number, seq: number) => {
          truncateSeq = Math.max(truncateSeq ?? -1, seq);
        }),
    } as unknown as MessageRepository & { queryMessages: Mock };
    const users: User[] = [
      {
        id: 1,
        account: 'Me',
        name: 'Me',
        avatar: '',
        bio: '',
        domain: 'local',
        namespaceId: 0,
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
        domain: 'local',
        namespaceId: 0,
        createdAt: 0,
        updatedAt: 0,
        isDeleted: false,
      } as unknown as User,
    ];
    const queryUserInfo = vi
      .fn()
      .mockName('queryUserInfo')
      .mockReturnValue(
        of<StandardResponse<User[]>>({ code: 0, message: 'ok', data: users }),
      );
    const userService = {
      queryUserInfo,
      // The source resolves the self id LIVE from sessionUserId() at shape time (not a constructor arg), so
      // the stub must expose it — user 1 is "Me" in the fixtures above.
      sessionUserId: () => 1,
      sessionProfile: () => ({ id: 1, account: 'me', domain: 'local' }),
    } as unknown as UserService;
    const profileRepo = {
      cacheProfile: vi.fn().mockResolvedValue(undefined),
      getProfile: vi
        .fn()
        .mockName('getProfile')
        .mockImplementation(
          async ({
            account,
            domain,
            namespaceId,
            profileRev,
          }: {
            account: string;
            domain: string;
            namespaceId: number;
            profileRev: number;
          }) => {
            if (profileResolver) return undefined;
            const user = users.find(
              (candidate) =>
                candidate.account.toLowerCase() === account &&
                candidate.domain === domain,
            );
            return user
              ? {
                  identity: JSON.stringify([namespaceId, domain, account]),
                  kind: 'user',
                  ...user,
                  profileRev,
                  account,
                }
              : undefined;
          },
        ),
    } as unknown as ProfileRepository;
    const profiles = vi.fn().mockName('onProfile');
    const newerAvailable = vi.fn().mockName('onNewerAvailable');
    const src = new HttpItemSource(
      conv(tid),
      repo,
      userService,
      outbox,
      {
        onQuoteDeleted,
        onProfile: profiles,
        onNewerAvailable: newerAvailable,
      },
      profileRepo,
      profileResolver,
    );
    return {
      src,
      deletedLive$,
      getDeletedMessageSeqs,
      onQuoteDeleted,
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

  it('includes an initially READY avatar in the first rendered message', async () => {
    const resolved = new Subject<ResolvedProfile>();
    let finish!: () => void;
    const resolver = {
      resolve: vi.fn(() => resolved),
      prepare: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    };
    const { src } = setup(
      { code: 0, message: 'ok', data: [row(10, 2)], hasMore: false },
      42,
      new ThreadSendOutbox(),
      resolver as unknown as ProfileResolutionService,
    );
    let painted = false;
    const initial = src.init(-1, 50, 0).then((items) => {
      painted = true;
      return items;
    });
    await vi.waitFor(() => expect(resolver.prepare).toHaveBeenCalledOnce());
    expect(painted).toBe(false);
    resolved.next({
      namespaceId: 0,
      account: 'peer',
      domain: 'local',
      rev: 3,
      name: 'Ready peer',
      bio: '',
      avatarBase64: 'aW1hZ2U=',
    });
    resolved.complete();
    finish();
    const items = await initial;
    expect(items[0].data).toMatchObject({
      name: 'Ready peer',
      avatar: 'data:image/webp;base64,aW1hZ2U=',
    });
  });

  it('renders on PENDING and resolves later messages from an already known sender', async () => {
    const pending = new Map<number, Subject<ResolvedProfile>>();
    const resolver = {
      resolve: vi.fn(({ messageSeq }: { messageSeq: number }) => {
        const result = new Subject<ResolvedProfile>();
        pending.set(messageSeq, result);
        return result;
      }),
      prepare: vi.fn(async () => {}),
    };
    const { src, profiles, repo } = setup(
      { code: 0, message: 'ok', data: [row(10, 2)], hasMore: true },
      42,
      new ThreadSendOutbox(),
      resolver as unknown as ProfileResolutionService,
    );
    expect(await src.init(-1, 50, 0)).toHaveLength(1);
    pending.get(10)!.next({
      namespaceId: 0,
      account: 'peer',
      domain: 'local',
      rev: 3,
      name: 'Later peer',
      bio: '',
      avatarBase64: 'aW1hZ2U=',
    });
    pending.get(10)!.complete();
    expect(profiles).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ avatar: 'data:image/webp;base64,aW1hZ2U=' }),
    );
    (repo.queryMessages as Mock).mockResolvedValue({
      data: [row(9, 2)],
      hasMore: false,
    });
    await src.getOlder(10, 50);
    expect(resolver.resolve).toHaveBeenCalledWith({
      type: 'MESSAGE_AUTHOR',
      threadId: 42,
      messageSeq: 9,
    });
    pending.get(9)!.complete();
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
    expect(vi.mocked(repo.queryMessages as Mock).mock.calls.length).toBe(0);
  });

  it('keeps a newer demand pending at newest and resolves it after source data updates', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    src.finishLocalInit(undefined);
    const queryMessages = repo.queryMessages as Mock;
    const demand = src.requestNewer(100, 50);
    let settled = false;
    const resultPromise = firstValueFrom(demand).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    queryMessages.mockResolvedValue({
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
    const calls = vi.mocked(repo.queryMessages as Mock).mock.calls.length;
    liveSignal$.next({ threadId: 42, seq: 101 });
    await Promise.resolve();
    expect(vi.mocked(repo.queryMessages as Mock).mock.calls.length).toBe(calls);
  });

  it('emits an error result for a failed newer demand and SSE does not implicitly retry it', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [],
    });
    src.finishLocalInit(undefined);
    const queryMessages = repo.queryMessages as Mock;
    queryMessages.mockResolvedValue({ data: [], hasMore: true, failed: true });

    expect((await firstValueFrom(src.requestNewer(100, 50))).kind).toBe(
      'error',
    );
    const failedCalls = vi.mocked(queryMessages).mock.calls.length;
    liveSignal$.next({ threadId: 42, seq: 101 });
    await Promise.resolve();
    expect(vi.mocked(queryMessages).mock.calls.length).toBe(failedCalls);

    queryMessages.mockResolvedValue({ data: [row(101, 2)], hasMore: false });
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
    (repo.queryMessages as Mock).mockResolvedValue({
      data: [],
      hasMore: false,
    });
    const subscription = src.requestNewer(10, 50).subscribe();
    src.finishLocalInit(12);
    await Promise.resolve();
    expect(vi.mocked(repo.queryMessages as Mock).mock.lastCall![1]).toEqual({
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
    const before = vi.mocked(repo.queryMessages as Mock).mock.calls.length;
    const subscription = src.requestNewer(-1, 50).subscribe();
    src.finishLocalInit(undefined, 258);
    await Promise.resolve();
    expect(newerAvailable).toHaveBeenCalledTimes(1);
    expect(newerAvailable).toHaveBeenCalledWith(258);
    expect(
      vi.mocked(repo.queryMessages as Mock).mock.calls.length,
    ).toBeGreaterThan(before);
    subscription.unsubscribe();
  });

  it('marks the sole server message as both after a cold empty-cache init', async () => {
    const only = row(1, 2);
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    const queryMessages = repo.queryMessages as Mock;
    queryMessages
      .mockResolvedValueOnce({ data: [], hasMore: false })
      .mockResolvedValueOnce({ data: [only], hasMore: false });

    expect(await src.init(-1, 50, 0)).toEqual([]);

    const next = firstValueFrom(src.requestNewer(-1, 50));
    src.finishLocalInit(undefined, 1);

    await expect(next).resolves.toMatchObject({
      kind: 'items',
      items: [{ id: 1, boundary: 'both' }],
    });
  });

  it('reconciles against the greater of the durable thread seq and live-session HWM', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [row(10, 2)],
      hasMore: false,
    });

    await src.init(-1, 50, 0);
    (repo.queryMessages as Mock).mockResolvedValue({
      data: [],
      hasMore: false,
    });
    const subscription = src.requestNewer(10, 50).subscribe();
    src.finishLocalInit(12, 11);
    await Promise.resolve();
    expect(vi.mocked(repo.queryMessages as Mock).mock.lastCall![1]).toEqual({
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
    const queryMessages = repo.queryMessages as Mock;

    await src.init(-1, 50, 0);
    src.finishLocalInit(undefined, 20);
    await src.getNewer(11, 50);

    expect(vi.mocked(queryMessages).mock.lastCall![1]).toEqual({
      skip: 1,
      take: 50,
      lastSeq: 11,
      orderBy: 'asc',
    });
  });

  it('keeps the newer demand pending when the repository confirms the newest boundary', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [row(50, 2)],
      hasMore: false,
    });
    const queryHistory = repo.queryBrowserMessageHistory as Mock;

    await src.init(-1, 50, 0);
    src.finishLocalInit(undefined, 50);
    liveSignal$.next({ threadId: 42, seq: 50 });
    queryHistory.mockResolvedValueOnce({
      items: [],
      hasOlder: true,
      hasNewer: false,
      failed: false,
    });
    const callsAfterInit = queryHistory.mock.calls.length;
    const subscription = src.requestNewer(50, 50).subscribe();
    await Promise.resolve();

    expect(queryHistory.mock.calls.length).toBe(callsAfterInit + 1);

    queryHistory.mockResolvedValueOnce({
      items: [{ kind: 'message', message: row(51, 2) }],
      hasOlder: true,
      hasNewer: false,
      failed: false,
    });
    liveSignal$.next({ threadId: 42, seq: 51 });
    while (queryHistory.mock.calls.length < callsAfterInit + 2)
      await Promise.resolve();
    expect(queryHistory.mock.calls.length).toBe(callsAfterInit + 2);
    subscription.unsubscribe();
  });

  it('uses the shared HWM only to decide whether a newer request is needed', async () => {
    const { src, repo, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    const queryMessages = repo.queryMessages as Mock;

    src.finishLocalInit(undefined, 20);
    await src.getNewer(10, 50);
    liveSignal$.next({ threadId: 42, seq: 25 });
    await src.getNewer(20, 50);

    expect(
      vi
        .mocked(queryMessages)
        .mock.calls.slice(-2)
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
    const queryMessages = repo.queryMessages as Mock;

    src.finishLocalInit(undefined, 20);
    reconnectSignal$.next();
    await src.getNewer(10, 50);

    expect(vi.mocked(queryMessages).mock.lastCall![1]).toEqual({
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

  it('routes a post-ready older top-up through the repository walker', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [row(10, 2)],
      hasMore: true,
    });
    const queryHistory = repo.queryBrowserMessageHistory as Mock;

    await src.init(-1, 50, 0);
    src.finishLocalInit(undefined);
    await src.getOlder(10, 50);

    expect(queryHistory.mock.lastCall).toEqual([
      42,
      { kind: 'older', before: 10, count: 50 },
    ]);
  });

  it('reshapes previously seen messages when a trimmed newer edge is loaded again', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [row(12, 2), row(11, 2)],
      hasMore: false,
    });
    const queryMessages = repo.queryMessages as Mock;

    const initial = await src.init(-1, 50, 0);
    expect(initial.map((item) => item.id)).toEqual([11, 12]);

    // Model the virtual-list lifecycle: the kernel trims these rows after the user scrolls upward,
    // then asks the source for them again while scrolling down. IDB legitimately returns ids already
    // shaped earlier in this source session; they must not be filtered by a lifetime seen-id set.
    queryMessages.mockResolvedValue({
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
        creator: { account: 'me', domain: 'local' },
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
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
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
    offline;
  });

  it('resolves the author from the local User table before shaping the row', async () => {
    const { src, queryUserInfo, profiles } = setup({
      code: 0,
      message: 'ok',
      data: [row(100, 2)],
      hasMore: false,
    });

    const items = await src.init(-1, 50, 0);
    src.finishLocalInit(undefined);

    expect(items.map((item) => item.id)).toEqual([100]);
    expect(items[0].data.name).toBe('Alice');
    expect(queryUserInfo).not.toHaveBeenCalled();
    expect(profiles).not.toHaveBeenCalled();
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
    const queryMessages = repo.queryMessages as Mock;
    await src.init(-1, 50, 0);
    queryMessages.mockResolvedValue({ data: [], hasMore: true, failed: true });

    await expect(src.getOlder(10, 50)).rejects.toThrow();
    await expect(src.getOlder(10, 50)).rejects.toThrow();
    expect(vi.mocked(queryMessages).mock.calls.length).toBe(3); // init + both retries; noOlder was never poisoned
  });

  it('does not turn a failed cold init into an empty-thread boundary', async () => {
    const { src, repo } = setup({ code: 0, message: 'ok', data: [] });
    const queryMessages = repo.queryMessages as Mock;
    queryMessages.mockResolvedValue({ data: [], hasMore: true, failed: true });

    await expect(src.init(-1, 50, 0)).rejects.toThrow();
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
      expect.objectContaining({ clientMessageId: 'cid-restored' }),
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

  // ---- HTTP acceptance + push-echo confirmation ----

  it('markPendingAccepted flips a pending entry sending→accepted IN PLACE (keeps position) and returns false when absent', () => {
    const { src } = setup({ code: 0, message: 'ok', data: [], hasMore: false });
    src.addPending(pendingItem('cid-keep-1', -1));
    src.addPending(pendingItem('cid-keep-2', -2));

    expect(src.markPendingAccepted('cid-keep-1')).toBe(true);
    const pending = src.getPending();
    expect(pending.length).toBe(2);
    expect(pending[0].clientMessageId).toBe('cid-keep-1'); // position KEPT (unlike failPending, which sinks to tail)
    expect(pending[0].data.status).toBe('accepted');
    expect(pending[0].data.kind).toBeUndefined();
    expect(pending[1].clientMessageId).toBe('cid-keep-2'); // sibling untouched
    expect(pending[1].data.status).toBe('sending');

    expect(src.markPendingAccepted('no-such-cid')).toBe(false); // echo already dropped it → false (self-heal)
  });

  it('keeps attachment pending entries reconcilable without exposing duplicate per-file bubbles', () => {
    const { src } = setup({ code: 0, message: 'ok', data: [], hasMore: false });
    const image = pendingItem('cid-image');
    (
      image as unknown as {
        data: {
          contentType: string;
        };
      }
    ).data.contentType = 'IMAGE';

    src.addPending(image);

    expect(src.getPending()).toEqual([]);
    expect(src.markPendingAccepted('cid-image')).toBe(true);
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
    const dispose = vi.fn().mockName('dispose');
    src.addPending(pendingItem(cid)); // HTTP 200 has NOT fired yet → still 'sending'
    outbox.retainResource(cid, {
      type: 'native-attachment',
      partId: 'part-native',
      selection: {} as never,
      release: dispose,
      discard: vi.fn().mockName('discard'),
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
    const dispose = vi.fn().mockName('dispose');
    src.addPending(pendingItem('cid-discard'));
    outbox.retainResource('cid-discard', {
      type: 'native-attachment',
      partId: 'part-discard',
      selection: {} as never,
      release: vi.fn().mockName('release'),
      discard: dispose,
    });

    expect(src.failPending('cid-discard')).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    expect(src.discardPending('cid-discard')).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(outbox.resource('cid-discard')).toBeUndefined();
  });

  it('rawToItems: a real whose cid matches an accepted pending entry owns the check choreography', async () => {
    const cid = 'http-first-cid';
    const echo = row(100, 1, cid);
    const { src, liveSignal$ } = setup({
      code: 0,
      message: 'ok',
      data: [echo],
      hasMore: false,
    });
    src.addPending(pendingItem(cid));
    expect(src.markPendingAccepted(cid)).toBe(true); // HTTP 200 won the race → pending now 'accepted'

    liveSignal$.next({ threadId: 42, seq: 100 });
    const items = await src.init(-1, 50, 0);
    expect(items[0].data.status).toBe('sent');
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

  function quotedReply() {
    return {
      ...row(101, 2),
      content: JSON.stringify({
        text: 'reply',
        quote: {
          seq: 44,
          author: 'Alice',
          body: 'old preview',
          image: '/old.jpg',
          contentType: 'IMAGE',
        },
      }),
    };
  }

  it('suppresses cached previews when the local target is a tombstone', async () => {
    const { src, getDeletedMessageSeqs } = setup({
      code: 0,
      message: 'ok',
      data: [quotedReply()],
    });
    getDeletedMessageSeqs.mockResolvedValue([44]);
    const items = await src.init(-1, 50, 0);
    expect(getDeletedMessageSeqs).toHaveBeenCalledWith(42, [44]);
    expect(items[0].data.quote).toEqual({ seq: 44, unavailable: true });
    expect(items[0].data.text).toBe('reply');
    src.destroy();
  });

  it('invalidates mounted replies only for their thread and unsubscribes on destroy', async () => {
    const { src, deletedLive$, onQuoteDeleted } = setup({
      code: 0,
      message: 'ok',
      data: [quotedReply()],
    });
    await src.init(-1, 50, 0);
    deletedLive$.next({ threadId: 99, seqs: [44] });
    expect(onQuoteDeleted).not.toHaveBeenCalled();
    deletedLive$.next({ threadId: 42, seqs: [44] });
    expect(onQuoteDeleted).toHaveBeenCalledWith(101, 44);
    // A later stale HTTP/cache body cannot restore the preview.
    expect((await src.init(-1, 50, 0))[0].data.quote).toEqual({
      seq: 44,
      unavailable: true,
    });
    src.destroy();
    onQuoteDeleted.mockClear();
    deletedLive$.next({ threadId: 42, seqs: [44] });
    expect(onQuoteDeleted).not.toHaveBeenCalled();
  });

  it('keeps a deletion received during a local lookup authoritative', async () => {
    const { src, getDeletedMessageSeqs, deletedLive$ } = setup({
      code: 0,
      message: 'ok',
      data: [quotedReply()],
    });
    getDeletedMessageSeqs.mockImplementation(async () => {
      deletedLive$.next({ threadId: 42, seqs: [44] });
      return [];
    });
    expect((await src.init(-1, 50, 0))[0].data.quote).toEqual({
      seq: 44,
      unavailable: true,
    });
    src.destroy();
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

    await expect(src.init(-1, 50, 0)).rejects.toThrowError(
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
      expect.objectContaining({
        kind: 'audio',
        src: '/uploads/cas/aa/bb/voice.webm',
        duration: 7.5,
        msgId: 101,
      }),
    );
  });

  describe('native source-level history boundary', () => {
    type NativeWindow = Window & {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: { core: { invoke: Mock } };
    };

    beforeEach(() => {
      const nativeWindow = window as NativeWindow;
      nativeWindow.__TAURI_INTERNALS__ = {};
      nativeWindow.__TAURI__ = { core: { invoke: vi.fn() } };
    });

    afterEach(() => {
      const nativeWindow = window as NativeWindow;
      delete nativeWindow.__TAURI_INTERNALS__;
      delete nativeWindow.__TAURI__;
    });

    it('uses one native source call for an around demand', async () => {
      const { src, repo } = setup({ code: 0, message: 'ok', data: [] });
      const queryNative = repo.queryNativeMessageHistory as Mock;
      queryNative.mockResolvedValueOnce({
        items: [
          { kind: 'message', message: row(40, 2) },
          { kind: 'message', message: row(41, 2) },
        ],
        hasOlder: true,
        hasNewer: true,
        failed: false,
      });

      const items = await src.init(40, 20, 10);

      expect(items.map((item) => item.id)).toEqual([40, 41]);
      expect(queryNative).toHaveBeenCalledTimes(1);
      expect(queryNative).toHaveBeenCalledWith(42, {
        kind: 'around',
        anchor: 40,
        olderCount: 20,
        newerCount: 10,
      });
      expect(repo.queryMessages).not.toHaveBeenCalled();
    });

    it('projects one gap item and resumes an older walk from left plus one', async () => {
      const { src, repo } = setup({ code: 0, message: 'ok', data: [] });
      const queryNative = repo.queryNativeMessageHistory as Mock;
      queryNative
        .mockResolvedValueOnce({
          items: [
            {
              kind: 'serverGap',
              left: 20,
              right: 30,
              state: 'SERVER_PENDING',
            },
          ],
          hasOlder: true,
          hasNewer: true,
          failed: false,
        })
        .mockResolvedValueOnce({
          items: [{ kind: 'message', message: row(20, 2) }],
          hasOlder: false,
          hasNewer: true,
          failed: false,
        })
        .mockResolvedValueOnce({
          items: [{ kind: 'message', message: row(31, 2) }],
          hasOlder: true,
          hasNewer: false,
          failed: false,
        });

      const initial = await src.init(-1, 50, 0);
      const older = await src.getOlder(initial[0].id, 50);
      const newer = await src.getNewer(initial[0].id, 50);

      expect(initial).toHaveLength(1);
      expect(initial[0].id).toBe(Number.MIN_SAFE_INTEGER + 1);
      expect(initial[0].data.serverGap).toEqual({
        left: 20,
        right: 30,
        state: 'SERVER_PENDING',
      });
      expect(older.map((item) => item.id)).toEqual([20]);
      expect(newer.map((item) => item.id)).toEqual([31]);
      expect(queryNative).toHaveBeenNthCalledWith(2, 42, {
        kind: 'older',
        before: 21,
        count: 50,
      });
      expect(queryNative).toHaveBeenNthCalledWith(3, 42, {
        kind: 'newer',
        after: 30,
        count: 50,
      });
    });
  });
});
