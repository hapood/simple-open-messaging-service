// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
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
import { StableReadTracker } from './stable-read-tracker';
import { MessageRepository } from '../../services/message-repository.service';
import { UserService } from '../../services/user.service';
import type {
  ConversationItem,
  Message,
  MessageQueryRow,
  User,
  StandardResponse,
} from '../../services/model';
import type { MediaStatus } from '../message-cards/chat-item';
import { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import { ProfileRepository } from '../../services/profile-store.service';
import { MemberProfileRepository } from '../../services/member-profile-store.service';


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
    publisherNamespaceId: 0,
    profileNamespaceId: 0,
    creator:
      creator === 1
        ? { account: 'me', namespaceId: 0 }
        : { account: 'alice', namespaceId: 0 },
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    profileRev: 3,
    isDeleted: false,
    ...(clientMessageId !== undefined ? { clientMessageId } : {}),
  } as unknown as Message;
}

/** A pending (optimistic, status:'sending') self-text send keyed by `cid`. Mirrors makeOptimisticItem's shape. */
function groupConv(threadId: number): ConversationItem {
  return {
    threadId,
    authorityNamespaceId: 1,
    id: 1,
    type: 'GROUP',
    lastReadSeq: null,
    role: 'MEMBER',
    unreadCount: 0,
    lastMessagePreview: null,
    lastMessageAt: null,
    group: {
      account: '!group',
      domain: 'alpha.test',
      name: 'Group',
      avatar: '',
      description: '',
    },
  } as unknown as ConversationItem;
}

function remoteGroupMessage(seq: number): Message {
  return {
    ...row(seq, 2),
    threadId: 42,
    publisherNamespaceId: 1,
    creator: { account: 'charlie', namespaceId: 0 },
    profileRev: 1,
  } as unknown as Message;
}

function pendingItem(cid: string, id = -1) {
  return {
    id,
    data: {
      type: 'msg',
      msgId: id,
      creator: JSON.stringify([0, 'me']),
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
    dbResult: StandardResponse<MessageQueryRow[]>,
    tid = 42,
    outbox = new ThreadSendOutbox(),
    resolutionRepo?: ProfileRepository,
    stageResponse: StandardResponse<
      Array<{
        clientMessageId: string;
        contentType: 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO' | 'GALLERY';
        content: string;
        status: 'pending' | 'failed';
        failReason: string | null;
        createdAt: number;
        updatedAt: number;
      }>
    > = { code: 0, message: 'ok', data: [] },
    groupRoster = false,
  ) {
    const liveSignal$ = new Subject<{
      threadId: number;
      seq: number;
    }>();
    const deletedLive$ = new Subject<{
      threadId: number;
      deletions: Array<{
        seq: number;
        type: 'USER_RETRACTION' | 'MODERATION_REMOVAL';
      }>;
    }>();
    const getDeletedMessageSeqs = vi.fn().mockResolvedValue([]);
    const onQuoteDeleted = vi.fn();
    const onQuoteUpdated = vi.fn();
    const slotsChanged$ = new Subject<number>();
    const getMessageByOrigin = vi.fn().mockResolvedValue({
      ...row(44, 1),
      content: JSON.stringify({ text: 'original message' }),
    });
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
              ].map((message: MessageQueryRow) => ({
                kind: 'message',
                message,
              })),
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
            items: messages.map((message: MessageQueryRow) => ({
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
      slotsChanged$,
      getMessageByOrigin,
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
      sessionProfile: () => ({
        id: 1,
        account: 'me',
        name: 'Me',
        domain: 'local',
      }),
    } as unknown as UserService;
    const messages = {
      queryMediaStages: vi
        .fn()
        .mockName('queryMediaStages')
        .mockReturnValue(of(stageResponse)),
      cancelUploadBatch: vi
        .fn()
        .mockName('cancelUploadBatch')
        .mockReturnValue(
          of({ code: 0, message: 'ok', data: { cancelled: 0 } }),
        ),
    };
    const profileRepo = {
      resolve: vi
        .fn()
        .mockName('resolve')
        .mockImplementation((demand: { target: { account: string } }) => {
          const user = users.find(
            (candidate) =>
              candidate.account.toLowerCase() ===
              demand.target.account.toLowerCase(),
          );
          return of(user);
        }),
    } as unknown as ProfileRepository;
    const activeProfileRepo = resolutionRepo ?? profileRepo;
    const newerAvailable = vi.fn().mockName('onNewerAvailable');
    const src = new HttpItemSource(
      groupRoster ? groupConv(tid) : conv(tid),
      repo,
      userService,
      outbox,
      {
        onQuoteDeleted,
        onQuoteUpdated,
        onNewerAvailable: newerAvailable,
      },
      messages as never,
      activeProfileRepo,
    );
    return {
      src,
      deletedLive$,
      getDeletedMessageSeqs,
      onQuoteDeleted,
      onQuoteUpdated,
      slotsChanged$,
      getMessageByOrigin,
      repo,
      liveSignal$,
      reconnectSignal$,
      mediaStatusLive$,
      newerAvailable,
      outbox,
      queryUserInfo,
      messages,
    };
  }

  it('resolves group message authors through the message profile demand', async () => {
    const resolve = vi.fn().mockImplementation(() =>
      of({
        publisherNamespaceId: 1,
        namespaceId: 0,
        account: 'charlie',
        rev: 1,
        name: 'Charlie',
        bio: '',
        avatarDigest: null,
        avatarBlob: null,
      }),
    );
    const accountProfiles = { resolve } as unknown as ProfileRepository;
    const { src } = setup(
      { code: 0, message: 'ok', data: [remoteGroupMessage(1)] },
      42,
      new ThreadSendOutbox(),
      accountProfiles,
      { code: 0, message: 'ok', data: [] },
      true,
    );

    const items = await src.init(-1, 20, 0);

    expect(items).toHaveLength(1);
    expect(items[0]!.data).toMatchObject({
      type: 'msg',
      name: 'Charlie',
      creator: JSON.stringify([0, 'charlie']),
    });
    // The author resolves by the message's own publisher-scoped coordinates —
    // the same demand path as P2P threads, never a roster identity join.
    expect(resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 1,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'charlie', rev: 1 },
    });
  });
  it('remounts an accepted native voice bubble so its confirmation timeout and retry remain visible', () => {
    const { src, outbox } = setup({ code: 0, message: 'ok', data: [] });
    const pending = pendingItem('voice-cid') as unknown as {
      id: number;
      clientMessageId: string;
      data: Record<string, unknown>;
    };
    const item = {
      ...pending,
      data: { ...pending.data, contentType: 'AUDIO', status: 'accepted' },
    };
    outbox.retainResource('voice-cid', {
      type: 'native-voice',
      threadId: 42,
      size: 512,
      discard: vi.fn(),
    });
    src.addPending(item as never);
    expect(src.getPending()).toEqual([item]);
    expect(src.acceptedPending()).toEqual([item]);
  });

  it('puts message evidence on the rendered item without resolving on the source', async () => {
    const repository = {
      getProfile: vi.fn().mockResolvedValue(undefined),
      resolve: vi.fn().mockReturnValue(of(undefined)),
    };
    const { src } = setup(
      { code: 0, message: 'ok', data: [row(10, 2)], hasMore: false },
      42,
      new ThreadSendOutbox(),
      repository as unknown as ProfileRepository,
    );
    const items = await src.init(-1, 50, 0);
    expect(items[0].data).toMatchObject({
      profileEvidence: {
        lookup: 'ACCOUNT_PROFILE',
        publisherNamespaceId: 0,
        target: {
          profileNamespaceId: 0,
          account: 'alice',
          rev: 3,
        },
      },
    });
    expect(repository.resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: {
        profileNamespaceId: 0,
        account: 'alice',
        rev: 3,
      },
    });
  });

  it('renders the system sender without requesting a sender profile and supplies thread context', async () => {
    const repository = {
      getProfile: vi.fn().mockResolvedValue(undefined),
      resolve: vi.fn().mockReturnValue(of(undefined)),
    };
    const notification = {
      ...row(10, 2),
      contentType: 'SYSTEM' as const,
      profileRev: 0,
      creator: { account: '$system', namespaceId: 0 },
      content: JSON.stringify({
        type: 'FRIEND_REMOVED',
        initiator: {
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          profileRev: 0,
        },
        participants: [
          { account: 'alice', domain: 'local', namespaceId: 0, profileRev: 0 },
          { account: 'bob', domain: 'local', namespaceId: 0, profileRev: 0 },
        ],
      }),
    };
    const { src } = setup(
      { code: 0, message: 'ok', data: [notification], hasMore: false },
      42,
      new ThreadSendOutbox(),
      repository as unknown as ProfileRepository,
    );
    const items = await src.init(-1, 50, 0);
    expect(items[0].data).toMatchObject({
      type: 'system',
      threadId: 42,
      isSelf: false,
    });
    expect(repository.resolve).not.toHaveBeenCalled();
    src.destroy();
  });

  it.each(['USER_RETRACTION', 'MODERATION_REMOVAL'] as const)(
    'projects an identified %s tombstone as a readable system row at the original sequence',
    async (deletionType) => {
      const tomb: MessageQueryRow = {
        threadId: 42,
        seq: 10,
        creator: { account: 'alice', namespaceId: 0 },
        profileRev: 1,
        createdAt: 1700000000000,
        updatedAt: 1700000000100,
        contentType: 'TOMB',
        isDeleted: true,
        deletionType,
      };
      const { src } = setup({
        code: 0,
        message: 'ok',
        data: [tomb],
        hasMore: false,
      });

      const items = await src.init(-1, 50, 0);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: 10,
        data: {
          type: 'system',
          contentType: 'SYSTEM',
          msgId: 10,
          deletionType,
          createdAtMs: 1700000000000,
        },
      });
      src.destroy();
    },
  );

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

  it('unsubscribes while hidden and explicitly catches up the missed feed ceiling on resume', () => {
    const { src, repo, liveSignal$, newerAvailable } = setup({
      code: 0,
      message: 'ok',
      data: [],
    });
    src.finishLocalInit(undefined);
    newerAvailable.mockClear();
    src.pauseLiveUpdates();
    liveSignal$.next({ threadId: 42, seq: 101 });
    expect(newerAvailable).not.toHaveBeenCalled();

    src.resumeLiveUpdates(101);
    expect(repo.retainNewestSeq).toHaveBeenCalledWith(42, 101);
    expect(newerAvailable).toHaveBeenCalledWith(101);
    liveSignal$.next({ threadId: 42, seq: 102 });
    expect(newerAvailable).toHaveBeenCalledWith(102);
    src.destroy();
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

  it('delivers an already in-flight newer request after live updates are paused', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    src.finishLocalInit(undefined);
    const queryMessages = repo.queryMessages as Mock;
    let finishQuery!: (value: {
      data: MessageQueryRow[];
      hasMore: boolean;
    }) => void;
    queryMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishQuery = resolve;
        }),
    );
    const resultPromise = firstValueFrom(src.requestNewer(100, 50));
    await vi.waitFor(() => expect(queryMessages).toHaveBeenCalledOnce());
    src.pauseLiveUpdates();
    finishQuery({ data: [row(101, 2)], hasMore: false });
    const result = await resultPromise;
    expect(result.kind).toBe('items');
    expect(queryMessages).toHaveBeenCalledOnce();
    src.resumeLiveUpdates(101);
    expect(queryMessages).toHaveBeenCalledOnce();
    src.destroy();
  });

  it('delivers a frozen in-flight page without reading it until the resumed viewport exposes it', async () => {
    const { src, repo } = setup({
      code: 0,
      message: 'ok',
      data: [],
      hasMore: false,
    });
    src.finishLocalInit(undefined);
    const commit = vi.fn();
    const reads = new StableReadTracker(commit);
    reads.startFromViewport([100]);
    commit.mockClear();
    let finishQuery!: (value: {
      data: MessageQueryRow[];
      hasMore: boolean;
    }) => void;
    const queryMessages = repo.queryMessages as Mock;
    queryMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishQuery = resolve;
        }),
    );
    const page = firstValueFrom(src.requestNewer(100, 50));
    await vi.waitFor(() => expect(queryMessages).toHaveBeenCalledOnce());

    reads.noteFullyVisible([100]);
    reads.flush();
    reads.reset();
    src.pauseLiveUpdates();
    finishQuery({ data: [row(101, 2)], hasMore: false });
    const delivered = await page;
    expect(delivered.kind).toBe('items');
    expect(
      delivered.kind === 'items' ? delivered.items.map((item) => item.id) : [],
    ).toEqual([101]);
    reads.noteFullyVisible([101]); // a layout callback may still fire while hidden
    expect(commit.mock.calls).toEqual([[100]]);

    src.resumeLiveUpdates(101);
    reads.startFromViewport([100]); // 101 is delivered, but not currently visible
    expect(commit.mock.calls).toEqual([[100], [100]]);
    reads.noteFullyVisible([101]);
    reads.flush();
    expect(commit.mock.calls.at(-1)).toEqual([101]);
    reads.reset();
    src.destroy();
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
      bundleId: 'bundle-1',
      summaryLines: ['Alice：hello'],
      messageCount: 1,
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
        creator: JSON.stringify([0, 'me']),
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
    const { src, queryUserInfo } = setup({
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

  it('restores durable media stages as failed pending attachments on init', async () => {
    const { src, messages } = setup(
      { code: 0, message: 'ok', data: [], hasMore: false },
      42,
      new ThreadSendOutbox(),
      undefined,
      {
        code: 0,
        message: 'ok',
        data: [
          {
            clientMessageId: 'cid-stage-file',
            contentType: 'FILE',
            content: '{}',
            status: 'pending',
            failReason: null,
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
          },
        ],
      },
    );

    await src.init(-1, 50, 0);

    expect(messages.queryMediaStages).toHaveBeenCalledWith(42);
    expect(src.getPending()).toEqual([
      expect.objectContaining({
        clientMessageId: 'cid-stage-file',
        data: expect.objectContaining({
          contentType: 'FILE',
          status: 'failed',
          file: expect.objectContaining({ name: 'Unfinished upload' }),
        }),
      }),
    ]);
  });

  it('abandons a durable media stage when the restored failed item is discarded', async () => {
    const { src, messages } = setup(
      { code: 0, message: 'ok', data: [], hasMore: false },
      42,
      new ThreadSendOutbox(),
      undefined,
      {
        code: 0,
        message: 'ok',
        data: [
          {
            clientMessageId: 'cid-stage-discard',
            contentType: 'FILE',
            content: '{}',
            status: 'pending',
            failReason: null,
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
          },
        ],
      },
    );

    await src.init(-1, 50, 0);

    expect(src.discardPending('cid-stage-discard')).toBe(true);
    expect(messages.cancelUploadBatch).toHaveBeenCalledWith(
      'cid-stage-discard',
    );
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

  it('refreshes an unresolved mounted quote after a same-thread DB commit and unregisters', async () => {
    const { src, getMessageByOrigin, slotsChanged$, onQuoteUpdated } = setup({
      code: 0,
      message: 'ok',
      data: [],
    });
    getMessageByOrigin.mockResolvedValue(undefined);
    const unregister = src.mountQuote(101, {
      anchor: { kind: 'origin', namespaceId: 3, originSeq: 4 },
    });
    await vi.waitFor(() => expect(getMessageByOrigin).toHaveBeenCalledOnce());
    getMessageByOrigin.mockResolvedValue({
      ...row(44, 1),
      content: '{"text":"new target"}',
    });
    slotsChanged$.next(99);
    expect(getMessageByOrigin).toHaveBeenCalledOnce();
    slotsChanged$.next(42);
    await vi.waitFor(() =>
      expect(onQuoteUpdated).toHaveBeenCalledWith(
        101,
        expect.objectContaining({ seq: 44, body: 'new target' }),
      ),
    );
    unregister();
    const calls = getMessageByOrigin.mock.calls.length;
    slotsChanged$.next(42);
    expect(getMessageByOrigin).toHaveBeenCalledTimes(calls);
    src.destroy();
  });

  it('rechecks persisted tombs after mounting', async () => {
    const { src, getDeletedMessageSeqs, onQuoteUpdated } = setup({
      code: 0,
      message: 'ok',
      data: [],
    });
    getDeletedMessageSeqs.mockResolvedValue([44]);
    src.mountQuote(101, {
      anchor: { kind: 'origin', namespaceId: 3, originSeq: 4 },
      seq: 44,
      body: 'old',
    });
    await vi.waitFor(() =>
      expect(onQuoteUpdated).toHaveBeenCalledWith(101, {
        seq: 44,
        unavailable: true,
      }),
    );
    src.destroy();
  });

  it('does not restore a summary when a tomb event arrives during target lookup', async () => {
    const { src, getMessageByOrigin, deletedLive$, onQuoteUpdated } = setup({
      code: 0,
      message: 'ok',
      data: [],
    });
    getMessageByOrigin.mockImplementation(async () => {
      deletedLive$.next({
        threadId: 42,
        deletions: [{ seq: 44, type: 'USER_RETRACTION' }],
      });
      return { ...row(44, 1), content: '{"text":"stale"}' };
    });
    src.mountQuote(101, {
      anchor: { kind: 'origin', namespaceId: 3, originSeq: 4 },
    });
    await vi.waitFor(() =>
      expect(onQuoteUpdated).toHaveBeenCalledWith(101, {
        seq: 44,
        unavailable: true,
      }),
    );
    src.destroy();
  });

  it('discards a lookup completing after unmount', async () => {
    const { src, getMessageByOrigin, onQuoteUpdated } = setup({
      code: 0,
      message: 'ok',
      data: [],
    });
    let finish!: (value: unknown) => void;
    getMessageByOrigin.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const unregister = src.mountQuote(101, {
      anchor: { kind: 'origin', namespaceId: 3, originSeq: 4 },
    });
    unregister();
    finish({ ...row(44, 1), content: '{"text":"late"}' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onQuoteUpdated).not.toHaveBeenCalled();
    src.destroy();
  });

  function quotedReply() {
    return {
      ...row(101, 2),
      content: JSON.stringify({
        text: 'reply',
        quote: {
          namespaceId: 3,
          originSeq: 4,
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
    deletedLive$.next({
      threadId: 99,
      deletions: [{ seq: 44, type: 'USER_RETRACTION' }],
    });
    expect(onQuoteDeleted).not.toHaveBeenCalled();
    deletedLive$.next({
      threadId: 42,
      deletions: [{ seq: 44, type: 'USER_RETRACTION' }],
    });
    expect(onQuoteDeleted).toHaveBeenCalledWith(101, 44);
    // A later stale HTTP/cache body cannot restore the preview.
    expect((await src.init(-1, 50, 0))[0].data.quote).toEqual({
      seq: 44,
      unavailable: true,
    });
    src.destroy();
    onQuoteDeleted.mockClear();
    deletedLive$.next({
      threadId: 42,
      deletions: [{ seq: 44, type: 'USER_RETRACTION' }],
    });
    expect(onQuoteDeleted).not.toHaveBeenCalled();
  });

  it('keeps a deletion received during a local lookup authoritative', async () => {
    const { src, getDeletedMessageSeqs, deletedLive$ } = setup({
      code: 0,
      message: 'ok',
      data: [quotedReply()],
    });
    getDeletedMessageSeqs.mockImplementation(async () => {
      deletedLive$.next({
        threadId: 42,
        deletions: [{ seq: 44, type: 'USER_RETRACTION' }],
      });
      return [];
    });
    expect((await src.init(-1, 50, 0))[0].data.quote).toEqual({
      seq: 44,
      unavailable: true,
    });
    src.destroy();
  });

  it('rawToItems builds the reply summary from a real cached target', async () => {
    const quoted = {
      ...row(101, 2),
      content: JSON.stringify({
        text: 'reply',
        quote: {
          namespaceId: 3,
          originSeq: 4,
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
      anchor: { kind: 'origin', namespaceId: 3, originSeq: 4 },
      seq: 44,
      body: 'original message',
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
      content: JSON.stringify({
        text: 'reply',
        quote: { namespaceId: 3, originSeq: 4 },
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
      anchor: { kind: 'origin', namespaceId: 3, originSeq: 4 },
      seq: 44,
      body: 'original message',
    });
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
