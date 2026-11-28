import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { NEVER, Observable, Subject } from 'rxjs';
import { ThreadRepository } from './thread-store.service';
import { WebdbService } from './webdb.service';
import { UserService, type SelfProfileView } from './user.service';
import { WebsocketService } from './websocket.service';
import { MessageRepository } from './message-repository.service';
import { MemberProfileRepository } from './member-profile-store.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { AppDataLifetime } from './app-data-lifetime.service';
import { ActiveThreadPresentation } from './active-thread-presentation.service';
import { parseLoginSessionId } from './session/session-identity';
import {
  createGroupConversation,
  createP2PConversation,
  type ConversationItem,
} from './model';
import { threadFeedSnapshot } from './thread-feed.test-helper';
import { ProfileRepository } from './profile-store.service';
import type { LocalThreadAttention } from '../../../../shared/thread-attention';
import type { ThreadAttentionProjection } from './webdb-storage';
import type { ThreadNotificationUpdate } from './thread-notification';

type Emission<T> = T extends Observable<infer Value> ? Value : never;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function attentionProjection(unreadCount: number): ThreadAttentionProjection {
  return {
    threadId: 7,
    lastReadSeq: 0,
    unreadCount,
    mentionUnread: [],
    lastMessagePreview: String(unreadCount),
    lastMessageAt: 1,
    lastMessageSenderAccount: 'peer',
    lastMessageSenderNamespaceId: 0,
  };
}

function peer(threadId = 7, threadFeedId = 1, pinnedAt: number | null = null) {
  return {
    ...createP2PConversation({
      threadId,
      account: `peer-${threadId}`,
      publisherNamespaceId: 0,
      profileRev: 0,
      threadFeedId,
    }),
    pinned: pinnedAt !== null,
    pinnedAt,
  };
}

function group() {
  return createGroupConversation({
    threadId: 9,
    account: 'room',
    publisherNamespaceId: 0,
    profileRev: 0,
    profile: { name: 'Room', bio: '', avatarDigest: null },
    role: 'MEMBER',
    threadFeedId: 1,
  });
}

function state(
  threadId = 7,
  overrides: Partial<ReturnType<typeof threadFeedSnapshot>> = {},
): LocalThreadAttention {
  return {
    ...threadFeedSnapshot(threadId, {
      publisherNamespaceId: 0,
      profileAccount: `peer-${threadId}`,
      profileRev: 0,
      ...overrides,
    }),
    localReadSeq: 0,
  };
}

const selfProfile: SelfProfileView = {
  id: 1,
  account: 'self',
  namespaceId: 0,
  isGroup: false,
  isDeleted: false,
  profileRev: 0,
  name: 'Self',
  bio: '',
};

function setup() {
  const presentation = {
    reportActiveThread: vi.fn<ActiveThreadPresentation['reportActiveThread']>(),
  } satisfies Pick<ActiveThreadPresentation, 'reportActiveThread'>;
  const webdb = {
    profileWake$: new Subject<Emission<WebdbService['profileWake$']>>(),
    workerFailed$: new Subject<void>(),
    threadFeedCommitted$: new Subject<
      Emission<WebdbService['threadFeedCommitted$']>
    >(),
    groupMetaCommitted$: new Subject<
      Emission<WebdbService['groupMetaCommitted$']>
    >(),
    stateFeedCommitted$: new Subject<
      Emission<WebdbService['stateFeedCommitted$']>
    >(),
    getThreads: vi.fn<WebdbService['getThreads']>().mockResolvedValue([]),
    getThreadStates: vi
      .fn<WebdbService['getThreadStates']>()
      .mockResolvedValue([]),
    projectThreadAttention: vi
      .fn<WebdbService['projectThreadAttention']>()
      .mockResolvedValue(attentionProjection(0)),
    patchThread: vi
      .fn<WebdbService['patchThread']>()
      .mockResolvedValue(undefined),
    deleteThread: vi
      .fn<WebdbService['deleteThread']>()
      .mockResolvedValue(undefined),
    pullProfileNamespaceChanges: vi
      .fn<WebdbService['pullProfileNamespaceChanges']>()
      .mockResolvedValue(undefined),
  } satisfies Partial<WebdbService>;
  const user = {
    sessionUserId: signal<number | null>(1),
    sessionProfile: signal<SelfProfileView | undefined>(selfProfile),
    establishSession: vi
      .fn<UserService['establishSession']>()
      .mockResolvedValue(undefined),
    refreshCommittedStateFeed: vi
      .fn<UserService['refreshCommittedStateFeed']>()
      .mockResolvedValue(1),
  } satisfies Pick<
    UserService,
    | 'sessionUserId'
    | 'sessionProfile'
    | 'establishSession'
    | 'refreshCommittedStateFeed'
  >;
  const ws = {
    eventSubject: new Subject<Emission<WebsocketService['eventSubject']>>(),
    connect: vi.fn<WebsocketService['connect']>(),
    disconnect: vi.fn<WebsocketService['disconnect']>(),
  } satisfies Pick<WebsocketService, 'eventSubject' | 'connect' | 'disconnect'>;
  const messages = {
    slotsChanged$: new Subject<number>(),
    applyThreadContentHead:
      vi.fn<MessageRepository['applyThreadContentHead']>(),
    deleteByThread: vi
      .fn<MessageRepository['deleteByThread']>()
      .mockResolvedValue(undefined),
  } satisfies Pick<
    MessageRepository,
    'slotsChanged$' | 'applyThreadContentHead' | 'deleteByThread'
  >;
  const profiles = {
    resolve: vi.fn<ProfileRepository['resolve']>().mockReturnValue(NEVER),
  } satisfies Pick<ProfileRepository, 'resolve'>;
  const memberProfiles = {
    notifyChanged: vi.fn<MemberProfileRepository['notifyChanged']>(),
  } satisfies Pick<MemberProfileRepository, 'notifyChanged'>;
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      ThreadRepository,
      SessionLifecycleService,
      AppDataLifetime,
      { provide: WebdbService, useValue: webdb },
      { provide: ActiveThreadPresentation, useValue: presentation },
      { provide: UserService, useValue: user },
      { provide: WebsocketService, useValue: ws },
      { provide: MessageRepository, useValue: messages },
      { provide: ProfileRepository, useValue: profiles },
      { provide: MemberProfileRepository, useValue: memberProfiles },
    ],
  });
  const repo = TestBed.inject(ThreadRepository);
  TestBed.tick();
  const commit = (...states: LocalThreadAttention[]) =>
    webdb.threadFeedCommitted$.next({ userId: 1, states });
  const hello = () =>
    ws.eventSubject.next({
      event: 'HELLO',
      status: 0,
      message: '',
      data: { userId: 1, sessionId: 11, stateFeedEndId: 0, threadFeedEndId: 0 },
    });
  const load = async (
    rows: ConversationItem[] = [peer()],
    states: LocalThreadAttention[] = [state()],
  ) => {
    webdb.getThreads.mockResolvedValue(rows);
    webdb.getThreadStates.mockResolvedValue(states);
    await repo.load();
    webdb.projectThreadAttention.mockClear();
  };
  return {
    repo,
    webdb,
    presentation,
    user,
    ws,
    messages,
    profiles,
    commit,
    hello,
    load,
  };
}

describe('ThreadRepository public projections', () => {
  it('orders pins by last-set time and incrementally repositions changed rows', async () => {
    const { repo, load, commit, webdb } = setup();
    await load(
      [peer(1, 100, 10), peer(2, 50, 20), peer(3, 30), peer(4, 40)],
      [],
    );
    const ids = () => repo.items().map((item) => item.threadId);
    expect(ids()).toEqual([2, 1, 4, 3]);
    const sort = vi.spyOn(Array.prototype, 'sort');
    try {
      commit(state(1, { threadFeedId: 101 }));
      expect(ids()).toEqual([2, 1, 4, 3]);
      commit(state(3, { threadFeedId: 102 }));
      expect(ids()).toEqual([2, 1, 3, 4]);
      repo.applyThreadMeta(1, { pinnedAt: 30 });
      expect(ids()).toEqual([1, 2, 3, 4]);
      repo.applyThreadMeta(1, { pinned: false, pinnedAt: null });
      expect(ids()).toEqual([2, 1, 3, 4]);
      expect(sort).not.toHaveBeenCalled();
    } finally {
      sort.mockRestore();
    }
    // State-feed completion is the public full-cache refresh entry point.
    webdb.getThreads.mockResolvedValue([
      peer(1, 101),
      peer(2, 50, 20),
      peer(3, 102),
      peer(4, 103),
    ]);
    webdb.stateFeedCommitted$.next({ userId: 1 });
    await vi.waitFor(() => expect(ids()).toEqual([2, 4, 1, 3]));
    const batchSort = vi.spyOn(Array.prototype, 'sort');
    try {
      commit(state(3, { threadFeedId: 104 }), state(1, { threadFeedId: 105 }));
      expect(ids()).toEqual([2, 1, 3, 4]);
      expect(batchSort).toHaveBeenCalledTimes(1);
      expect(batchSort.mock.contexts[0]).toHaveLength(2);
    } finally {
      batchSort.mockRestore();
    }
  });

  it.each([undefined, 7])(
    'reports active selection %s without a database write',
    (threadId) => {
      const { repo, presentation } = setup();
      repo.setActiveThread(threadId);
      expect(presentation.reportActiveThread).toHaveBeenCalledWith(threadId);
      expect(repo.activeThreadId()).toBe(threadId);
    },
  );

  it('does not reactivate selection after the app ends', () => {
    const { repo, presentation } = setup();
    TestBed.inject(AppDataLifetime).end();
    repo.setActiveThread(7);
    expect(repo.activeThreadId()).toBeUndefined();
    expect(presentation.reportActiveThread).not.toHaveBeenCalled();
  });

  it('does not read further state or publish cached rows after the app data lifetime ends', async () => {
    const { repo, webdb } = setup();
    TestBed.inject(SessionLifecycleService).bindSession(
      parseLoginSessionId('11111111-2222-4333-8444-555555555555'),
    );
    const pending = deferred<ConversationItem[]>();
    webdb.getThreads.mockReturnValue(pending.promise);
    const loading = repo.load();
    TestBed.inject(AppDataLifetime).end();
    pending.resolve([group()]);
    await loading;
    expect(webdb.getThreadStates).not.toHaveBeenCalled();
    expect(repo.items()).toEqual([]);
    expect(repo.navigationReady()).toBe(false);
  });

  it.each(['complete', 'fail'] as const)(
    'does not continue or repair late HELLO hydration after app stop: %s',
    async (outcome) => {
      const { webdb, user, hello } = setup();
      TestBed.inject(SessionLifecycleService).bindSession(
        parseLoginSessionId('11111111-2222-4333-8444-555555555555'),
      );
      const pending = deferred<void>();
      user.establishSession.mockReturnValue(pending.promise);
      const warning = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        hello();
        expect(user.establishSession).toHaveBeenCalledOnce();
        TestBed.inject(AppDataLifetime).end();
        if (outcome === 'complete') {
          pending.resolve(undefined);
          await pending.promise;
        } else {
          pending.reject(new Error('old hydration failed'));
          await expect(pending.promise).rejects.toThrow('old hydration failed');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(webdb.getThreadStates).not.toHaveBeenCalled();
        expect(webdb.pullProfileNamespaceChanges).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    },
  );

  it('rejects malformed HELLO identities and passes the authoritative identity to UserService', async () => {
    const { ws, user, webdb } = setup();
    const pending = deferred<void>();
    user.establishSession.mockReturnValue(pending.promise);
    const hello = {
      userId: 1,
      stateFeedEndId: 0,
      threadFeedEndId: 0,
      profileRev: 4,
    };
    for (const sessionId of [undefined, null, 0, -1, '11', 1.5]) {
      ws.eventSubject.next({
        event: 'HELLO',
        status: 0,
        message: '',
        data: { ...hello, sessionId },
      });
    }
    expect(user.establishSession).not.toHaveBeenCalled();
    ws.eventSubject.next({
      event: 'HELLO',
      status: 0,
      message: '',
      data: { ...hello, sessionId: 11 },
    });
    expect(user.establishSession).toHaveBeenCalledExactlyOnceWith(1, 4, 11);
    TestBed.inject(AppDataLifetime).end();
    pending.resolve(undefined);
    await pending.promise;
    expect(webdb.getThreadStates).not.toHaveBeenCalled();
  });

  it('does not treat partially restored list rows as navigation-ready', async () => {
    const { repo, webdb } = setup();
    const hydration = deferred<LocalThreadAttention[]>();
    webdb.getThreads.mockResolvedValue([group()]);
    webdb.getThreadStates
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(hydration.promise);
    const loaded = repo.load();
    await vi.waitFor(() => expect(repo.items()).toHaveLength(1));
    expect(repo.status()).toBe('READY');
    expect(repo.navigationReady()).toBe(false);
    hydration.resolve([]);
    await loaded;
    expect(repo.navigationReady()).toBe(true);
    TestBed.inject(AppDataLifetime).end();
    expect(repo.navigationReady()).toBe(false);
  });

  it('adopts a committed snapshot revision by feed order, not revision magnitude', async () => {
    const { repo, load, commit, profiles } = setup();
    await load(
      [
        {
          ...peer(9),
          profileRev: 5,
          profile: {
            name: 'Bob rev five',
            bio: 'five bio',
            avatarDigest: null,
          },
        },
      ],
      [state(9, { profileRev: 5 })],
    );
    commit(state(9, { profileRev: 3, threadFeedId: 2 }));
    expect(repo.items()[0]).toMatchObject({
      type: 'P2P',
      profileRev: 3,
      threadFeedId: 2,
      profile: { name: '', bio: '', avatarDigest: null },
    });
    expect(profiles.resolve).toHaveBeenCalled();
    // An older feed cannot restore its larger revision.
    commit(state(9, { profileRev: 5, threadFeedId: 1 }));
    expect(repo.items()[0].profileRev).toBe(3);
  });

  it('updates an existing conversation role in both directions from committed feed snapshots', async () => {
    const { repo, load, commit } = setup();
    await load(
      [group()],
      [state(9, { type: 'GROUP', profileAccount: 'room', role: 'MEMBER' })],
    );
    for (const [threadFeedId, role] of [
      [2, 'ADMIN'],
      [3, 'MEMBER'],
    ] as const) {
      commit(
        state(9, { type: 'GROUP', profileAccount: 'room', threadFeedId, role }),
      );
      expect(repo.items()[0].role).toBe(role);
    }
  });

  it('coalesces slot wakes without publishing an intermediate dirty result or stale cache attention', async () => {
    const { repo, load, messages, webdb } = setup();
    await load();
    const first = deferred<ThreadAttentionProjection>();
    const trailing = deferred<ThreadAttentionProjection>();
    webdb.projectThreadAttention
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise);
    messages.slotsChanged$.next(7);
    await vi.waitFor(() =>
      expect(webdb.projectThreadAttention).toHaveBeenCalledOnce(),
    );
    messages.slotsChanged$.next(7);
    messages.slotsChanged$.next(7);
    expect(webdb.projectThreadAttention).toHaveBeenCalledOnce();
    first.resolve(attentionProjection(8));
    await vi.waitFor(() =>
      expect(webdb.projectThreadAttention).toHaveBeenCalledTimes(2),
    );
    expect(repo.items()[0].unreadCount).toBe(0);
    expect(repo.items()[0].lastMessagePreview).toBe('0');
    trailing.resolve(attentionProjection(3));
    await vi.waitFor(() => expect(repo.items()[0].unreadCount).toBe(3));
    expect(repo.items()[0].lastMessagePreview).toBe('3');
    expect(webdb.projectThreadAttention).toHaveBeenLastCalledWith(7, {
      account: 'self',
      namespaceId: 0,
    });
    const refresh = deferred<ThreadAttentionProjection>();
    webdb.projectThreadAttention.mockReturnValueOnce(refresh.promise);
    webdb.getThreads.mockResolvedValue([peer()]);
    webdb.stateFeedCommitted$.next({ userId: 1 });
    await vi.waitFor(() =>
      expect(webdb.projectThreadAttention).toHaveBeenCalledTimes(3),
    );
    expect(repo.items()[0].unreadCount).toBe(3);
    expect(repo.items()[0].lastMessagePreview).toBe('3');
    refresh.resolve(attentionProjection(4));
    await vi.waitFor(() => expect(repo.items()[0].unreadCount).toBe(4));
    messages.slotsChanged$.next(7);
    await vi.waitFor(() =>
      expect(webdb.projectThreadAttention).toHaveBeenCalledTimes(4),
    );
  });

  it('coalesces live notifications with the latest committed snapshot', async () => {
    const { repo, load, commit, webdb } = setup();
    await load();
    const first = deferred<ThreadAttentionProjection>();
    const trailing = deferred<ThreadAttentionProjection>();
    webdb.projectThreadAttention
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise);
    const notify = vi.fn<(updates: ThreadNotificationUpdate[]) => void>();
    const subscription = repo.threadNotifications$.subscribe(notify);
    try {
      commit(state(7, { threadFeedId: 2, messageEndSeq: 2, unreadCount: 2 }));
      await vi.waitFor(() =>
        expect(webdb.projectThreadAttention).toHaveBeenCalledOnce(),
      );
      commit(state(7, { threadFeedId: 3, messageEndSeq: 3, unreadCount: 3 }));
      first.resolve(attentionProjection(1));
      await vi.waitFor(() =>
        expect(webdb.projectThreadAttention).toHaveBeenCalledTimes(2),
      );
      expect(notify).not.toHaveBeenCalled();
      expect(repo.items()[0].unreadCount).toBe(0);
      trailing.resolve(attentionProjection(2));
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
      expect(notify.mock.calls[0][0]).toMatchObject([
        {
          item: { threadId: 7, unreadCount: 2 },
          state: { threadFeedId: 3, messageEndSeq: 3 },
        },
      ]);
    } finally {
      subscription.unsubscribe();
    }
  });

  it('preserves local join-request acknowledgement across slot-only projection', async () => {
    const { repo, load, messages, webdb } = setup();
    await load(
      [
        {
          ...group(),
          threadId: 7,
          role: 'ADMIN',
          joinRequestEndFeedId: 12,
          joinRequestReadFeedId: 8,
        },
      ],
      [
        state(7, {
          type: 'GROUP',
          profileAccount: 'room',
          role: 'ADMIN',
          joinRequestEndFeedId: 12,
          joinRequestReadFeedId: 8,
        }),
      ],
    );
    const pending = deferred<ThreadAttentionProjection>();
    webdb.projectThreadAttention.mockReturnValueOnce(pending.promise);
    messages.slotsChanged$.next(7);
    await vi.waitFor(() =>
      expect(webdb.projectThreadAttention).toHaveBeenCalledOnce(),
    );
    repo.markJoinRequestsReadLocally(7, 12);
    expect(webdb.patchThread).toHaveBeenCalledWith(7, {
      joinRequestReadFeedId: 12,
    });
    pending.resolve(attentionProjection(1));
    await vi.waitFor(() => expect(repo.items()[0].unreadCount).toBe(1));
    expect(repo.items()[0].joinRequestReadFeedId).toBe(12);
    expect(repo.items()[0].joinRequestEndFeedId).toBe(12);
  });

  it('does not resurrect a removed thread when its projection returns', async () => {
    const { repo, load, messages, webdb, commit, presentation } = setup();
    await load();
    repo.setActiveThread(7);
    presentation.reportActiveThread.mockClear();
    const pending = deferred<ThreadAttentionProjection>();
    webdb.projectThreadAttention.mockReturnValueOnce(pending.promise);
    const notify = vi.fn<(updates: ThreadNotificationUpdate[]) => void>();
    const subscription = repo.threadNotifications$.subscribe(notify);
    try {
      commit(state(7, { threadFeedId: 2, messageEndSeq: 2, unreadCount: 2 }));
      await vi.waitFor(() =>
        expect(webdb.projectThreadAttention).toHaveBeenCalledOnce(),
      );
      messages.slotsChanged$.next(7);
      await repo.removeThread(7);
      expect(repo.activeThreadId()).toBeUndefined();
      expect(presentation.reportActiveThread).toHaveBeenCalledWith(undefined);
      expect(webdb.deleteThread).toHaveBeenCalledWith(7);
      expect(messages.deleteByThread).toHaveBeenCalledWith(7);
      pending.resolve(attentionProjection(99));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      messages.slotsChanged$.next(7);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(repo.items()).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      expect(webdb.projectThreadAttention).toHaveBeenCalledOnce();
    } finally {
      subscription.unsubscribe();
    }
  });

  it('retries a failed projection only on the next wake, without a hot loop', async () => {
    const { repo, load, messages, webdb } = setup();
    await load();
    webdb.projectThreadAttention
      .mockRejectedValueOnce(new Error('projection conflict'))
      .mockResolvedValueOnce(attentionProjection(4));
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      messages.slotsChanged$.next(7);
      await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(webdb.projectThreadAttention).toHaveBeenCalledOnce();
      expect(repo.items()[0].unreadCount).toBe(0);
      messages.slotsChanged$.next(7);
      await vi.waitFor(() => expect(repo.items()[0].unreadCount).toBe(4));
      expect(webdb.projectThreadAttention).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it('does not publish a projection or handle SSE and slot wakes after destruction', async () => {
    const { repo, load, messages, webdb, user, hello } = setup();
    await load();
    const pending = deferred<ThreadAttentionProjection>();
    webdb.projectThreadAttention.mockReturnValueOnce(pending.promise);
    messages.slotsChanged$.next(7);
    await vi.waitFor(() =>
      expect(webdb.projectThreadAttention).toHaveBeenCalledOnce(),
    );
    TestBed.resetTestingModule();
    const before = repo.items();
    pending.resolve(attentionProjection(99));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(repo.items()).toBe(before);
    hello();
    messages.slotsChanged$.next(7);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(user.establishSession).not.toHaveBeenCalled();
    expect(webdb.projectThreadAttention).toHaveBeenCalledOnce();
  });
});
