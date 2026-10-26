import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ThreadRepository } from './thread-store.service';
import { WebdbService } from './webdb.service';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { MessageRepository } from './message-repository.service';
import { MemberProfileRepository } from './member-profile-store.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { parseLoginSessionId } from './session/session-identity';
import {
  createGroupConversation,
  createP2PConversation,
  type P2PConversationItem,
} from './model';
import { threadFeedSnapshot } from './thread-feed.test-helper';
import { ProfileRepository } from './profile-store.service';

/**
 * The open-thread UI state is persisted fire-and-forget, so the account cache
 * teardown rejection must never escape as an unhandled rejection; real storage
 * errors still propagate to the caller.
 */
describe('ThreadRepository.setOpenThread teardown tolerance', () => {
  let drainThreadMisc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    drainThreadMisc = vi.fn().mockName('drainThreadMisc');
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ThreadRepository,
        {
          provide: WebdbService,
          useValue: {
            drainThreadMisc,
            profileWake$: new Subject(),
            workerFailed$: new Subject(),
            threadFeedCommitted$: new Subject(),
            threadAttentionProjectionCommitted$: new Subject(),
            groupMetaCommitted$: new Subject(),
            stateFeedCommitted$: new Subject(),
            resolveProfileDemand: vi
              .fn()
              .mockRejectedValue(new Error('no profile in this fixture')),
            getProfileAvatarBlob: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: UserService,
          useValue: {
            sessionUserId: signal<number | null>(null),
            sessionProfile: signal(null),
            requestCacheRebuild: vi.fn(),
          },
        },
        {
          provide: WebsocketService,
          useValue: {
            eventSubject: new Subject(),
            connect: vi.fn(),
            disconnect: vi.fn(),
          },
        },
        {
          provide: MessageRepository,
          useValue: { slotsChanged$: new Subject() },
        },
        {
          provide: MemberProfileRepository,
          useValue: { notifyChanged: vi.fn() },
        },
        SessionLifecycleService,
      ],
    });
  });

  it('orders pins by last-set time and incrementally repositions only changed rows', () => {
    const repo = TestBed.inject(ThreadRepository);
    const internal = repo as unknown as {
      applyItems(items: P2PConversationItem[]): void;
      applyThreadFeedOrders(
        snapshots: {
          threadId: number;
          threadFeedId: number;
          profileRev: number;
        }[],
      ): void;
    };
    Object.assign(TestBed.inject(WebdbService), {
      patchThread: vi.fn().mockResolvedValue(undefined),
    });
    const row = (id: number, feed: number, pinnedAt: number | null) => ({
      ...createP2PConversation({
        threadId: id,
        account: `peer-${id}`,
        publisherNamespaceId: 0,
        profileRev: 0,
        threadFeedId: feed,
      }),
      pinned: pinnedAt !== null,
      pinnedAt,
    });
    internal.applyItems([
      row(1, 100, 10),
      row(2, 50, 20),
      row(3, 30, null),
      row(4, 40, null),
    ]);
    const ids = () => repo.items().map((item) => item.threadId);
    expect(ids()).toEqual([2, 1, 4, 3]);
    const sort = vi.spyOn(Array.prototype, 'sort');
    try {
      internal.applyThreadFeedOrders([
        { threadId: 1, threadFeedId: 101, profileRev: 0 },
      ]);
      expect(ids()).toEqual([2, 1, 4, 3]);
      internal.applyThreadFeedOrders([
        { threadId: 3, threadFeedId: 102, profileRev: 0 },
      ]);
      expect(ids()).toEqual([2, 1, 3, 4]);
      repo.applyThreadMeta(1, { pinnedAt: 30 });
      expect(ids()).toEqual([1, 2, 3, 4]);
      repo.applyThreadMeta(1, { pinned: false, pinnedAt: null });
      expect(ids()).toEqual([2, 1, 3, 4]);
      internal.applyItems([
        row(1, 101, null),
        row(2, 50, 20),
        row(3, 102, null),
        row(4, 103, null),
      ]);
      expect(ids()).toEqual([2, 4, 1, 3]);
      expect(sort).not.toHaveBeenCalled();
      internal.applyThreadFeedOrders([
        { threadId: 3, threadFeedId: 104, profileRev: 0 },
        { threadId: 1, threadFeedId: 105, profileRev: 0 },
      ]);
      expect(ids()).toEqual([2, 1, 3, 4]);
      expect(sort).toHaveBeenCalledTimes(1);
      expect(sort.mock.contexts[0]).toHaveLength(2);
    } finally {
      sort.mockRestore();
    }
  });

  it('resolves when clearing the open thread during account cache teardown', async () => {
    drainThreadMisc.mockRejectedValue(
      new Error('account cache lifetime expired'),
    );
    const repo = TestBed.inject(ThreadRepository);
    await expect(repo.setOpenThread(undefined)).resolves.toBeUndefined();
    expect(drainThreadMisc).toHaveBeenCalledWith(null);
  });

  it('resolves when opening a thread during account cache teardown', async () => {
    drainThreadMisc.mockRejectedValue(
      new Error('account cache lifetime expired'),
    );
    const repo = TestBed.inject(ThreadRepository);
    await expect(repo.setOpenThread(7)).resolves.toBeUndefined();
    expect(drainThreadMisc).toHaveBeenCalledWith(7);
  });

  it('does not read successor state or publish cached rows after the captured login ends', async () => {
    const lifecycle = TestBed.inject(SessionLifecycleService);
    lifecycle.bindSession(
      parseLoginSessionId('11111111-2222-4333-8444-555555555555'),
    );
    const user = TestBed.inject(UserService);
    user.sessionUserId.set(1);
    const group = createGroupConversation({
      threadId: 9,
      account: 'room',
      publisherNamespaceId: 0,
      profileRev: 0,
      profile: { name: 'Room', bio: '', avatarDigest: null },
      role: 'MEMBER',
      threadFeedId: 1,
    });
    let finish!: (rows: (typeof group)[]) => void;
    const pending = new Promise<(typeof group)[]>((resolve) => {
      finish = resolve;
    });
    const getThreadStates = vi.fn().mockResolvedValue([]);
    Object.assign(TestBed.inject(WebdbService), {
      getThreads: vi.fn().mockReturnValue(pending),
      getThreadStates,
    });
    const repo = TestBed.inject(ThreadRepository);
    TestBed.tick();
    const loading = repo.load();
    lifecycle.invalidateSession();
    lifecycle.bindSession(
      parseLoginSessionId('22222222-3333-4444-8555-666666666666'),
    );
    finish([group]);
    await loading;
    expect(getThreadStates).not.toHaveBeenCalled();
    expect(repo.items()).toEqual([]);
    expect(repo.navigationReady()).toBe(false);
  });

  it.each(['complete', 'fail'] as const)(
    'does not continue or repair after old HELLO hydration finishes late: %s',
    async (outcome) => {
      const lifecycle = TestBed.inject(SessionLifecycleService);
      lifecycle.bindSession(
        parseLoginSessionId('11111111-2222-4333-8444-555555555555'),
      );
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const pending = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const user = TestBed.inject(UserService);
      const establishSession = vi.fn().mockReturnValue(pending);
      Object.assign(user, { establishSession });
      const getThreadStates = vi.fn();
      Object.assign(TestBed.inject(WebdbService), { getThreadStates });
      TestBed.inject(ThreadRepository);
      TestBed.tick();
      const ws = TestBed.inject(WebsocketService);
      ws.eventSubject.next({
        event: 'HELLO',
        status: 0,
        message: '',
        data: {
          userId: 1,
          sessionId: 11,
          stateFeedEndId: 0,
          threadFeedEndId: 0,
        },
      });
      expect(establishSession).toHaveBeenCalledOnce();
      lifecycle.invalidateSession();
      lifecycle.bindSession(
        parseLoginSessionId('22222222-3333-4444-8555-666666666666'),
      );
      if (outcome === 'complete') {
        finish();
        await pending;
        await Promise.resolve();
      } else {
        fail(new Error('old hydration failed'));
        await expect(pending).rejects.toThrow('old hydration failed');
        await Promise.resolve();
      }
      expect(getThreadStates).not.toHaveBeenCalled();
      expect(user.requestCacheRebuild).not.toHaveBeenCalled();
    },
  );

  it('requires HELLO sessionId and passes its authoritative identity to UserService', async () => {
    const user = TestBed.inject(UserService);
    const stop = new Error('stop after session establishment');
    const establishSession = vi.fn().mockRejectedValue(stop);
    Object.assign(user, { establishSession });
    const repo = TestBed.inject(ThreadRepository) as unknown as {
      onHello: (value: unknown) => Promise<void>;
    };
    const hello = {
      userId: 1,
      stateFeedEndId: 0,
      threadFeedEndId: 0,
      profileRev: 4,
    };
    for (const sessionId of [undefined, null, 0, -1, '11', 1.5]) {
      await repo.onHello({ ...hello, sessionId });
    }
    expect(establishSession).not.toHaveBeenCalled();
    await expect(repo.onHello({ ...hello, sessionId: 11 })).rejects.toBe(stop);
    expect(establishSession).toHaveBeenCalledExactlyOnceWith(1, 4, 11);
  });

  it('does not treat partially restored list rows as navigation-ready', async () => {
    const webdb = TestBed.inject(WebdbService);
    const user = TestBed.inject(UserService);
    user.sessionUserId.set(1);
    Object.assign(user, { sessionProfile: signal(null) });
    const group = createGroupConversation({
      threadId: 9,
      account: 'room',
      publisherNamespaceId: 0,
      profileRev: 0,
      profile: { name: 'Room', bio: '', avatarDigest: null },
      role: 'MEMBER',
      threadFeedId: 1,
    });
    let finish!: (states: []) => void;
    const hydration = new Promise<[]>((resolve) => {
      finish = resolve;
    });
    Object.assign(webdb, {
      getThreads: vi.fn().mockResolvedValue([group]),
      getThreadStates: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockReturnValueOnce(hydration),
    });
    const repo = TestBed.inject(ThreadRepository);
    TestBed.tick();
    const loaded = repo.load();
    await vi.waitFor(() => expect(repo.items()).toHaveLength(1));
    expect(repo.status()).toBe('READY');
    expect(repo.navigationReady()).toBe(false);
    finish([]);
    await loaded;
    expect(repo.navigationReady()).toBe(true);
    TestBed.inject(SessionLifecycleService).endSession();
    expect(repo.navigationReady()).toBe(false);
  });

  it('adopts a committed snapshot revision by feed order, not revision magnitude', async () => {
    const webdb = TestBed.inject(WebdbService);
    const user = TestBed.inject(UserService);
    user.sessionUserId.set(1);
    Object.assign(user, { sessionProfile: signal(null) });
    const seed = createP2PConversation({
      threadId: 9,
      account: 'bob',
      publisherNamespaceId: 0,
      profileRev: 5,
    });
    const peer: P2PConversationItem = {
      ...seed,
      threadFeedId: 1,
      profile: { ...seed.profile, name: 'Bob rev five', bio: 'five bio' },
    };
    Object.assign(webdb, {
      getThreads: vi.fn().mockResolvedValue([peer]),
      projectThreadAttention: vi.fn().mockResolvedValue(null),
    });
    Object.assign(TestBed.inject(MessageRepository), {
      applyThreadContentHead: vi.fn(),
    });
    const repo = TestBed.inject(ThreadRepository);
    TestBed.tick();
    const committed = webdb.threadFeedCommitted$ as Subject<{
      userId: number;
      states: Array<
        ReturnType<typeof threadFeedSnapshot> & { localReadSeq: number }
      >;
    }>;
    // A newer feed position carries a lower revision: the snapshot wins and
    // the moved selection resets display fields until re-resolution.
    committed.next({
      userId: 1,
      states: [
        {
          ...threadFeedSnapshot(9, {
            type: 'P2P',
            publisherNamespaceId: 0,
            profileAccount: 'bob',
            profileRev: 3,
            threadFeedId: 2,
          }),
          localReadSeq: 0,
        },
      ],
    });
    await vi.waitFor(() => {
      const item = repo.items().find((entry) => entry.threadId === 9);
      expect(item?.type).toBe('P2P');
      if (item?.type !== 'P2P') throw new Error('P2P expected');
      expect(item.profileRev).toBe(3);
      expect(item.profile.name).toBe('');
      expect(item.profile.bio).toBe('');
    });
    TestBed.inject(SessionLifecycleService).endSession();
  });

  it('updates an existing conversation role in both directions from committed feed snapshots', async () => {
    const webdb = TestBed.inject(WebdbService);
    const user = TestBed.inject(UserService);
    user.sessionUserId.set(1);
    Object.assign(user, { sessionProfile: signal(null) });
    const group = createGroupConversation({
      threadId: 9,
      account: 'room',
      publisherNamespaceId: 0,
      profileRev: 0,
      profile: { name: 'Room', bio: '', avatarDigest: null },
      role: 'MEMBER',
      threadFeedId: 1,
    });
    Object.assign(webdb, {
      getThreads: vi.fn().mockResolvedValue([group]),
      projectThreadAttention: vi.fn().mockResolvedValue(null),
    });
    Object.assign(TestBed.inject(MessageRepository), {
      applyThreadContentHead: vi.fn(),
    });
    const repo = TestBed.inject(ThreadRepository);
    TestBed.tick();
    const committed = webdb.threadFeedCommitted$ as Subject<{
      userId: number;
      states: Array<
        ReturnType<typeof threadFeedSnapshot> & { localReadSeq: number }
      >;
    }>;
    for (const [threadFeedId, role] of [
      [2, 'ADMIN'],
      [3, 'MEMBER'],
    ] as const) {
      committed.next({
        userId: 1,
        states: [
          {
            ...threadFeedSnapshot(9, {
              type: 'GROUP',
              publisherNamespaceId: 0,
              profileAccount: 'room',
              profileRev: 0,
              threadFeedId,
              role,
            }),
            localReadSeq: 0,
          },
        ],
      });
      await vi.waitFor(() =>
        expect(repo.items().find((item) => item.threadId === 9)?.role).toBe(
          role,
        ),
      );
    }
  });

  it('lands warmed cross-namespace member profiles at the roster key once', async () => {
    const webdb = TestBed.inject(WebdbService);
    const user = TestBed.inject(UserService);
    user.sessionUserId.set(1);
    Object.assign(user, { sessionProfile: signal(null) });
    const group = createGroupConversation({
      threadId: 9,
      account: 'room',
      publisherNamespaceId: 0,
      profileRev: 0,
      profile: { name: 'Room', bio: '', avatarDigest: null },
      role: 'MEMBER',
      threadFeedId: 1,
    });
    const reference = {
      type: 'GROUP_MEMBER',
      threadId: 9,
      account: 'charlie',
      domain: 'bravo.test',
      namespaceId: 1,
      rev: 1,
    } as const;
    const resolveProfileDemand = vi.fn().mockResolvedValue({
      status: 'READY',
      profile: {
        publisherNamespaceId: 0,
        profileNamespaceId: 1,
        account: 'charlie',
        profileRev: 1,
        name: 'Charlie Bravo',
        bio: 'bio',
        avatarDigest: null,
      },
    });
    const commitResolvedGroupMetaProfile = vi.fn().mockResolvedValue(true);
    let discovered: unknown[] = [reference];
    Object.assign(webdb, {
      getThreads: vi.fn().mockResolvedValue([group]),
      projectThreadAttention: vi.fn().mockResolvedValue(null),
      resolveProfileDemand,
      commitResolvedGroupMetaProfile,
      getUnresolvedGroupMetaProfiles: vi
        .fn()
        .mockImplementation(() => Promise.resolve(discovered)),
    });
    Object.assign(TestBed.inject(MessageRepository), {
      applyThreadContentHead: vi.fn(),
    });
    const repo = TestBed.inject(ThreadRepository);
    TestBed.tick();
    const committed = webdb.threadFeedCommitted$ as Subject<{
      userId: number;
      states: Array<
        ReturnType<typeof threadFeedSnapshot> & { localReadSeq: number }
      >;
    }>;
    committed.next({
      userId: 1,
      states: [
        {
          ...threadFeedSnapshot(9, {
            type: 'GROUP',
            publisherNamespaceId: 0,
            profileAccount: 'room',
            profileRev: 0,
            threadFeedId: 2,
            role: 'MEMBER',
          }),
          localReadSeq: 0,
        },
      ],
    });
    await vi.waitFor(() =>
      expect(repo.items().some((item) => item.threadId === 9)).toBe(true),
    );
    const meta = webdb.groupMetaCommitted$ as Subject<{
      userId: number;
      threadIds: number[];
      patches: Array<{
        threadId: number;
        groupMetaFeedId: string;
        memberCount: number;
        announcementFeedId: null;
        announcementText: null;
        groupMetaRecoveryThrough: null;
      }>;
    }>;
    const metaEvent = {
      userId: 1,
      threadIds: [9],
      patches: [
        {
          threadId: 9,
          groupMetaFeedId: '24',
          memberCount: 3,
          announcementFeedId: null,
          announcementText: null,
          groupMetaRecoveryThrough: null,
        },
      ],
    };
    meta.next(metaEvent);
    await vi.waitFor(() =>
      expect(commitResolvedGroupMetaProfile).toHaveBeenCalledTimes(1),
    );
    expect(commitResolvedGroupMetaProfile).toHaveBeenCalledWith(
      reference,
      expect.objectContaining({
        namespaceId: 1,
        account: 'charlie',
        rev: 1,
        name: 'Charlie Bravo',
        bio: 'bio',
      }),
    );
    expect(resolveProfileDemand).toHaveBeenCalledTimes(1);
    expect(resolveProfileDemand.mock.calls[0][0]).toMatchObject({
      publisherNamespaceId: 0,
      lookup: 'GROUP_MEMBER_PROFILE',
      groupAccount: 'room',
      target: { profileNamespaceId: 1, account: 'charlie', rev: 1 },
    });
    // Once the reference converges, repeat commits must not re-issue work.
    discovered = [];
    meta.next(metaEvent);
    await vi.waitFor(() =>
      expect(
        (webdb.getUnresolvedGroupMetaProfiles as ReturnType<typeof vi.fn>).mock
          .calls.length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(resolveProfileDemand).toHaveBeenCalledTimes(1);
    expect(commitResolvedGroupMetaProfile).toHaveBeenCalledTimes(1);
  });

  it('propagates storage failures that are not cache teardown', async () => {
    drainThreadMisc.mockRejectedValue(new Error('QuExceededError'));
    const repo = TestBed.inject(ThreadRepository);
    await expect(repo.setOpenThread(undefined)).rejects.toThrow(
      'QuExceededError',
    );
  });
});
