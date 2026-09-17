import { threadStateEvent } from './thread-state.test-helper';
import { firstValueFrom } from 'rxjs';
import { syncThreadFeed } from './thread-feed-sync';
import { SessionLifecycleService } from './session-lifecycle.service';
import type { Mock } from 'vitest';
import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import { WebdbService } from './webdb.service';
import { ThreadRepository } from './thread-store.service';
import { MessageRepository } from './message-repository.service';
import {
  ProfileResolutionService,
  type ResolvedProfile,
} from './profile-resolution.service';
import { ProfileRepository } from './profile-store.service';
import { UserService } from './user.service';
import { MsgService } from './message.service';
import { WebsocketService } from './websocket.service';
import {
  ConversationItem,
  createGroupConversation,
  createP2PConversation,
  Message,
  P2PConversationItem,
  User,
} from './model';
import { ToastService } from './toast.service';
import { TranslocoService } from '@jsverse/transloco';
import type { ThreadFeedSnapshot } from '../../../../shared/thread-attention';
import { MemberProfileRepository } from './member-profile-store.service';

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
  opts: Partial<P2PConversationItem> = {},
): P2PConversationItem {
  return createP2PConversation(
    threadId,
    { id: peerId, account: `u${peerId}`, name: `User ${peerId}` },
    { threadFeedId: threadId, ...opts },
  );
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
  let queryThreadFeedSpy: Mock;
  let queryUserInfoSpy: Mock;
  let advanceCursorSpy: Mock;
  let applyRelationshipRequestStateRevisionSpy: Mock;
  let applyRelationshipIntentStateRevisionSpy: Mock;
  let cursorSignal: ReturnType<typeof signal<number | undefined>>;
  let putProfileSpy: Mock;
  let toastWarn: Mock;

  beforeEach(async () => {
    eventSubject = new Subject();
    sessionUserId = signal<number | null>(null);
    sessionProfile = signal<User | undefined>({
      id: 1,
      account: 'me',
      domain: 'local',
    } as User);
    cursorSignal = signal<number | undefined>(undefined);
    queryThreadFeedSpy = vi.fn().mockReturnValue(
      of({
        code: 0,
        data: {
          threadFeedEndId: 0,
          through: 0,
          scannedThrough: 0,
          hasMore: false,
          items: [],
        },
      }),
    );

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
          provide: WebsocketService,
          useValue: { eventSubject, reconnect$: new Subject<void>() },
        },
        {
          provide: UserService,
          useValue: {
            sessionUserId,
            sessionProfile,
            requestCacheRebuild: vi.fn().mockResolvedValue(undefined),
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
            queryUserInfo: (queryUserInfoSpy = vi
              .fn()
              .mockName('queryUserInfo')
              .mockReturnValue(of({ code: 0, data: [] }))),
            applyStateProfile: (profile: User) => {
              if (profile.id === sessionProfile()?.id)
                sessionProfile.set(profile);
            },
            applyRelationshipRequestStateRevision:
              (applyRelationshipRequestStateRevisionSpy = vi
                .fn()
                .mockName('applyRelationshipRequestStateRevision')),
            applyRelationshipIntentStateRevision:
              (applyRelationshipIntentStateRevisionSpy = vi
                .fn()
                .mockName('applyRelationshipIntentStateRevision')),
            markRead: () => of({ code: 0 }),
          },
        },
      ],
    });
    repo = TestBed.inject(ThreadRepository);
    webdb = TestBed.inject(WebdbService);
    vi.spyOn(webdb, 'syncThreadFeed').mockImplementation(
      async (target, after) => {
        const result = await syncThreadFeed(
          webdb,
          target,
          (body) => firstValueFrom(queryThreadFeedSpy(body)),
          async (input) => ({
            code: 0,
            data: {
              account: '!dev',
              mode: input.mode,
              items: [],
              scannedThrough: input.through,
              groupMetaFeedEndId: input.through,
              hasMore: false,
            },
          }),
          async () => false,
        );
        return {
          ...(await webdb.readThreadFeedChanges(after)),
          ...(result.error ? { error: result.error } : {}),
        };
      },
    );
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
    creator: Message['creator'] = {
      account: `u${threadId * 11}`,
      domain: 'local',
      namespaceId: 0,
    },
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
    threadFeedEndId?: number;
  }): void {
    eventSubject.next({
      event: 'HELLO',
      data: { threadFeedEndId: 0, ...data },
    });
  }

  async function publishThreadState(state: ThreadFeedSnapshot, hello = false) {
    queryThreadFeedSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          items: [state],
          through: state.threadFeedId,
          scannedThrough: state.threadFeedId,
          threadFeedEndId: state.threadFeedId,
          hasMore: false,
        },
      }),
    );
    if (hello)
      emitHello({
        userId: 1,
        stateFeedEndId: 0,
        threadFeedEndId: state.threadFeedId,
      });
    else
      eventSubject.next({
        event: 'THREAD_FEED_UPDATED',
        data: { threadFeedEndId: state.threadFeedId },
      });
    await vi.waitFor(async () => {
      expect(
        Number(await webdb.getMeta('threadFeedCursor')),
      ).toBeGreaterThanOrEqual(state.threadFeedId);
      expect(
        repo.items().find((item) => item.threadId === state.threadId),
      ).toMatchObject({
        threadFeedId: state.threadFeedId,
      });
    });
  }

  const threadSnapshot = (): ThreadFeedSnapshot => ({
    threadId: 1,
    threadFeedId: 1,
    messageEndSeq: 8,
    tombstoneEndSeq: 0,
    groupMetaFeedEndId: null,
    joinRequestEndFeedId: 0,
    joinRequestReadFeedId: -1,
    groupInviteEndFeedId: 0,
    lastReadSeq: 0,
    unreadCount: 3,
    lastMentionSeq: 5,
    previews: [
      {
        seq: 5,
        createdAt: '2026-01-01T00:00:00.000Z',
        sender: { account: 'u11', domain: 'local' },
        status: 'LIVE',
        text: 'latest preview',
      },
    ],
  });

  it('consumes unified snapshots and rebases optimistic counts without replacing the local read position', async () => {
    const notified = vi.fn();
    const subscription = repo.threadNotifications$.subscribe(notified);
    await populate([p2p(1, 11)]);
    for (const seq of [1, 3, 5]) await seedMessage(1, seq);
    await seedMessage(1, 7, 'own', {
      account: 'me',
      domain: 'local',
      namespaceId: 0,
    });
    await publishThreadState(threadSnapshot(), true);
    expect(queryThreadFeedSpy).toHaveBeenCalledWith({
      after: 0,
      through: 1,
      take: 100,
      previewCount: 3,
    });
    expect(repo.items()[0]).toMatchObject({
      unreadCount: 3,
      lastMessagePreview: 'latest preview',
      lastMessageSeq: 8,
    });
    expect(repo.commitLocalRead(1, 3)).toBe(true);
    await flush(30);
    expect(repo.items()[0]).toMatchObject({ lastReadSeq: 3, unreadCount: 1 });
    await publishThreadState({
      ...threadSnapshot(),
      threadFeedId: 2,
      lastReadSeq: 1,
      unreadCount: 2,
    });
    expect(repo.items()[0]).toMatchObject({ lastReadSeq: 3, unreadCount: 1 });
    await publishThreadState({ ...threadSnapshot(), threadFeedId: 3 });
    expect(repo.items()[0]).toMatchObject({ lastReadSeq: 3, unreadCount: 1 });
    expect(notified.mock.lastCall?.[0][0]).toMatchObject({
      item: { lastReadSeq: 3, unreadCount: 1 },
      state: { threadFeedId: 3, unreadCount: 3 },
    });
    subscription.unsubscribe();
    expect(await webdb.getMeta('threadFeedCursor')).toBe(3);
    expect(await webdb.getMeta('stateFeedId')).toBeUndefined();
    expect((await webdb.getThreadStates())[0]).toMatchObject({
      localReadSeq: 3,
      server: { threadFeedId: 3, lastReadSeq: 0 },
    });
  });

  it('keeps server previews while optimistic reads clear unread and mentions', async () => {
    await populate([p2p(1, 11)]);
    for (const seq of [1, 3, 5]) await seedMessage(1, seq);
    await publishThreadState(threadSnapshot(), true);
    const previewFields = {
      lastMessagePreview: repo.items()[0].lastMessagePreview,
      lastMessageAt: repo.items()[0].lastMessageAt,
      lastMessageSenderId: repo.items()[0].lastMessageSenderId,
    };
    for (const seq of [5, 8]) {
      expect(repo.commitLocalRead(1, seq)).toBe(true);
      await flush(30);
      expect(repo.items()[0]).toMatchObject({
        ...previewFields,
        lastReadSeq: seq,
        unreadCount: 0,
        mentionUnread: [],
      });
    }
    // A server cursor behind the optimistic cursor still owns preview membership.
    await publishThreadState({
      ...threadSnapshot(),
      threadFeedId: 2,
      lastReadSeq: 5,
      unreadCount: 0,
      lastMentionSeq: null,
    });
    expect(repo.items()[0]).toMatchObject(previewFields);
    expect(await (await webdb.db()).get('threads', 1)).toMatchObject(
      previewFields,
    );
    await publishThreadState({
      ...threadSnapshot(),
      threadFeedId: 3,
      lastReadSeq: 8,
      unreadCount: 0,
      lastMentionSeq: null,
      previews: [],
    });
    expect(repo.items()[0].lastMessagePreview).toBeNull();
  });

  it('handles message and tomb heads together and masks deleted preview content without decrementing count', async () => {
    await populate([p2p(1, 11)]);
    await publishThreadState(threadSnapshot(), true);
    const tomb = {
      ...threadSnapshot(),
      threadFeedId: 2,
      messageEndSeq: 9,
      tombstoneEndSeq: 3,
      lastMentionSeq: null,
      previews: [
        {
          ...threadSnapshot().previews![0],
          status: 'MODERATION_REMOVAL' as const,
          text: undefined,
        },
      ],
    };
    await publishThreadState(tomb);
    expect(repo.items()[0]).toMatchObject({
      unreadCount: 3,
      mentionUnread: [],
      lastMessageSeq: 9,
      lastMessagePreview: '[Message removed by administrator]',
    });
    await publishThreadState({
      ...tomb,
      threadFeedId: 3,
      previews: [{ ...tomb.previews[0], status: 'USER_RETRACTION' }],
    });
    expect(repo.items()[0].lastMessagePreview).toBe('[Message retracted]');
  });

  it('reprojects when a missing local message slot becomes available, including tombs', async () => {
    await populate([p2p(1, 11)]);
    await publishThreadState(threadSnapshot(), true);
    repo.commitLocalRead(1, 3);
    await flush(20);
    expect(repo.items()[0].unreadCount).toBe(3);
    await seedMessage(1, 3);
    await webdb.applyDeletedMessages(
      1,
      [
        {
          threadId: 1,
          messageSeq: 3,
          deletionSeq: 1,
          type: 'USER_RETRACTION',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      1,
    );
    (
      TestBed.inject(MessageRepository) as unknown as {
        slotsChanged: Subject<number>;
      }
    ).slotsChanged.next(1);
    await flush(20);
    expect(repo.items()[0]).toMatchObject({ lastReadSeq: 3, unreadCount: 2 });
  });

  it('renders snapshots already committed by a background executor without another HTTP request', async () => {
    await populate([p2p(1, 11)]);
    emitHello({ userId: 1, stateFeedEndId: 0 });
    await flush(20);
    await webdb.mergeThreadStates([{ ...threadSnapshot(), unreadCount: 7 }], 1);
    queryThreadFeedSpy.mockClear();
    eventSubject.next({
      event: 'THREAD_FEED_UPDATED',
      data: { threadFeedEndId: 1 },
    });
    await flush(30);
    expect(queryThreadFeedSpy).not.toHaveBeenCalled();
    expect(repo.items()[0].unreadCount).toBe(7);
    expect(repo.items()[0].lastMessagePreview).toBe('latest preview');
  });

  it('refreshes committed worker state without starting a network drain', async () => {
    await populate([p2p(1, 11)]);
    const read = vi.spyOn(webdb, 'readThreadFeedChanges');
    emitHello({ userId: 1, stateFeedEndId: 0 });
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith(0));
    read.mockClear();
    await webdb.mergeThreadStates([{ ...threadSnapshot(), unreadCount: 8 }], 1);
    queryThreadFeedSpy.mockClear();
    vi.mocked(webdb.syncThreadFeed).mockClear();
    eventSubject.next({
      event: 'LOCAL_THREAD_FEED_COMMITTED',
      data: { userId: 1, cursor: 1 },
    });
    await vi.waitFor(() => expect(repo.items()[0].unreadCount).toBe(8));
    expect(read).toHaveBeenCalledWith(0);
    expect(webdb.syncThreadFeed).not.toHaveBeenCalled();
    expect(queryThreadFeedSpy).not.toHaveBeenCalled();
  });

  it('routes a committed Group Meta wake to thread-scoped domain listeners', async () => {
    await populate([
      createGroupConversation(
        12,
        { id: 12, account: '!team', name: 'Team', ownerId: 1 },
        { threadFeedId: 1 },
      ),
    ]);
    const notify = vi.spyOn(
      TestBed.inject(MemberProfileRepository),
      'notifyChanged',
    );
    emitHello({ userId: 1, stateFeedEndId: 0 });
    await flush(20);

    eventSubject.next({
      event: 'LOCAL_THREAD_FEED_COMMITTED',
      data: {
        userId: 1,
        changes: ['GROUP_META'],
        groupThreadIds: [12],
      },
    });

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith([12]));
    expect(queryThreadFeedSpy).not.toHaveBeenCalled();
  });

  it('ignores a local completion for another account', async () => {
    await populate([p2p(1, 11)]);
    emitHello({ userId: 1, stateFeedEndId: 0 });
    await flush(20);
    const read = vi.spyOn(webdb, 'readThreadFeedChanges');
    eventSubject.next({
      event: 'LOCAL_THREAD_FEED_COMMITTED',
      data: { userId: 2, cursor: 1 },
    });
    await flush(10);
    expect(read).not.toHaveBeenCalled();
  });

  it('advances empty compacted pages and does not repeat a consumed wake', async () => {
    emitHello({ userId: 1, stateFeedEndId: 0 });
    await flush(20);
    queryThreadFeedSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          items: [],
          through: 4,
          scannedThrough: 4,
          threadFeedEndId: 4,
          hasMore: false,
        },
      }),
    );
    eventSubject.next({
      event: 'THREAD_FEED_UPDATED',
      data: { threadFeedEndId: 4 },
    });
    await flush(20);
    expect(await webdb.getMeta('threadFeedCursor')).toBe(4);
    const calls = queryThreadFeedSpy.mock.calls.length;
    eventSubject.next({
      event: 'THREAD_FEED_UPDATED',
      data: { threadFeedEndId: 4 },
    });
    await flush(10);
    expect(queryThreadFeedSpy).toHaveBeenCalledTimes(calls);
  });

  it('does not commit an invalid feed page and retries on the next wake', async () => {
    await populate([p2p(1, 11)]);
    emitHello({ userId: 1, stateFeedEndId: 0 });
    await flush(20);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    queryThreadFeedSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          items: [threadSnapshot()],
          through: 1,
          scannedThrough: 0,
          threadFeedEndId: 1,
          hasMore: true,
        },
      }),
    );
    eventSubject.next({
      event: 'THREAD_FEED_UPDATED',
      data: { threadFeedEndId: 1 },
    });
    await flush(20);
    expect(await webdb.getMeta('threadFeedCursor')).toBeUndefined();
    await publishThreadState(threadSnapshot());
    expect(await webdb.getMeta('threadFeedCursor')).toBe(1);
    warn.mockRestore();
  });

  it('rebuilds from a code 30006 recovery window', async () => {
    cursorSignal.set(9);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    queryStateFeedSpy
      .mockReturnValueOnce(
        of({ code: 30006, data: { resumeAfter: 0, resumeBefore: 7 } }),
      )
      .mockReturnValueOnce(
        of({
          code: 0,
          data: {
            mode: 'full',
            items: [],
            hasMore: false,
            scannedThrough: 6,
            stateFeedEndId: 6,
          },
        }),
      );

    repo.onStateFeedUpdated(10);
    await flush(30);

    expect(warn).toHaveBeenCalledWith(
      '[state-feed] cursor unavailable; rebuilding from 0 through 6',
    );
    expect(queryStateFeedSpy.mock.calls[1][0]).toEqual(
      expect.objectContaining({ mode: 'full', after: 0, through: 6 }),
    );
    expect(cursorSignal()).toBe(6);
    warn.mockRestore();
  });

  /** Populate via the EAGER CACHE-PAINT (seed IDB + load) — the instant pre-HELLO path. For tests that
   *  just need a populated list (mutations, messages, peer profile) without exercising the delta. */
  async function populate(items: ConversationItem[]): Promise<void> {
    const db = await webdb.db();
    const tx = db.transaction('threads', 'readwrite');
    for (const it of items) {
      await tx.store.put(it);
    }
    await tx.done;
    await repo.load();
  }

  it('applies a profile fact only to the matching namespace in memory and storage', async () => {
    const old = p2p(91, 0);
    const current = p2p(92, 0);
    Object.assign(old.peerUser, {
      account: 'peer',
      domain: 'peer.test',
      namespaceId: 7,
      profileRev: 2,
      name: 'Old namespace',
    });
    Object.assign(current.peerUser, {
      account: 'peer',
      domain: 'peer.test',
      namespaceId: 8,
      profileRev: 2,
      name: 'Current namespace',
    });
    old.authorityNamespaceId = 7;
    current.authorityNamespaceId = 8;
    await populate([old, current]);
    cursorSignal.set(98);
    queryStateFeedSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          mode: 'delta',
          scannedThrough: 99,
          stateFeedEndId: 99,
          hasMore: false,
          items: [
            {
              feedId: 99,
              eventType: 'PROFILE',
              account: 'peer',
              domain: 'peer.test',
              namespaceId: 8,
              subjectAccount: '',
              subjectDomain: 'local',
              body: {
                displayName: 'Updated',
                avatar: '',
                bio: '',
                profileRev: 2,
              },
            },
          ],
        },
      }),
    );
    repo.onStateFeedUpdated(99);
    await vi.waitFor(() => expect(cursorSignal()).toBe(99));
    expect(repo.items().find((item) => item.threadId === 91)).toMatchObject({
      peerUser: { name: 'Old namespace', namespaceId: 7 },
    });
    expect(repo.items().find((item) => item.threadId === 92)).toMatchObject({
      peerUser: { name: 'Updated', namespaceId: 8 },
    });
    expect(
      (await webdb.getThreads()).find((item) => item.threadId === 91),
    ).toMatchObject({ peerUser: { name: 'Old namespace' } });
    expect(
      (await webdb.getThreads()).find((item) => item.threadId === 92),
    ).toMatchObject({ peerUser: { name: 'Updated' } });
  });

  it('updates a placeholder peer from message resolution without applying self or older profiles', async () => {
    const item = p2p(9, 0);
    Object.assign(item.peerUser, {
      account: 'peer',
      domain: 'bravo.test',
      profileRev: 0,
    });
    await populate([item]);
    const resolved = TestBed.inject(ProfileResolutionService)['resolved'];
    const profile = {
      namespaceId: 0,
      account: 'peer',
      domain: 'bravo.test',
      rev: 3,
      name: 'Peer image',
      bio: '',
      avatarBase64: 'aW1hZ2U=',
    };
    resolved.next({
      selector: { type: 'MESSAGE_AUTHOR', threadId: 9, messageSeq: 2 },
      profile,
    });
    resolved.next({
      selector: { type: 'MESSAGE_AUTHOR', threadId: 9, messageSeq: 3 },
      profile: { ...profile, account: 'me', name: 'Self' },
    });
    resolved.next({
      selector: { type: 'MESSAGE_AUTHOR', threadId: 9, messageSeq: 1 },
      profile: { ...profile, rev: 99, name: 'Old' },
    });
    expect(repo.items()[0]).toMatchObject({
      peerUser: {
        name: 'Peer image',
        profileRev: 3,
        avatar: 'data:image/webp;base64,aW1hZ2U=',
      },
    });
    await vi.waitFor(async () =>
      expect((await webdb.getThreads())[0]).toMatchObject({
        peerUser: { profileRev: 3, avatar: 'data:image/webp;base64,aW1hZ2U=' },
      }),
    );
    resolved.next({
      selector: { type: 'MESSAGE_AUTHOR', threadId: 9, messageSeq: 4 },
      profile: { ...profile, rev: 1, name: 'Later message' },
    });
    expect(repo.items()[0]).toMatchObject({
      peerProfileMessageSeq: 4,
      peerUser: { name: 'Later message', profileRev: 1 },
    });
    repo['upsertThread'](item);
    expect(repo.items()[0]).toMatchObject({
      peerProfileMessageSeq: 4,
      peerUser: { name: 'Later message', profileRev: 1 },
    });
  });

  it('does not let a pending relationship profile overwrite a message-selected profile', async () => {
    const relationship = new Subject<ResolvedProfile>();
    vi.spyOn(
      TestBed.inject(ProfileResolutionService),
      'resolve',
    ).mockReturnValue(relationship);
    const item = p2p(9, 0);
    Object.assign(item.peerUser, {
      account: 'peer',
      domain: 'bravo.test',
      profileRev: 9,
      name: '',
    });
    await populate([item]);
    const profile = {
      namespaceId: 0,
      account: 'peer',
      domain: 'bravo.test',
      rev: 1,
      name: 'Message',
      bio: '',
      avatarBase64: null,
    };
    TestBed.inject(ProfileResolutionService)['resolved'].next({
      selector: { type: 'MESSAGE_AUTHOR', threadId: 9, messageSeq: 4 },
      profile,
    });
    relationship.next({ ...profile, rev: 9, name: 'Relationship' });
    relationship.complete();
    expect(repo.items()[0]).toMatchObject({
      peerProfileMessageSeq: 4,
      peerUser: { name: 'Message', profileRev: 1 },
    });
  });

  it('hydrates a cached private thread through the shared profile resolver and persists the avatar', async () => {
    const resolved = new Subject<ResolvedProfile>();
    const resolve = vi
      .spyOn(TestBed.inject(ProfileResolutionService), 'resolve')
      .mockReturnValue(resolved);
    const item = p2p(9, 0);
    Object.assign(item.peerUser, {
      account: 'check03-b-001',
      domain: 'bravo.test',
      namespaceId: 1,
      profileRev: 3,
      name: '',
      avatar: '',
    });
    await populate([item]);
    expect(resolve).toHaveBeenCalledWith({
      type: 'EXACT',
      account: 'check03-b-001',
      domain: 'bravo.test',
      rev: 3,
    });
    resolved.next({
      namespaceId: 1,
      account: 'check03-b-001',
      domain: 'bravo.test',
      rev: 3,
      name: 'Resolved peer',
      bio: 'Bio',
      avatarBase64: 'aW1hZ2U=',
    });
    resolved.complete();
    expect(repo.items()[0]).toMatchObject({
      peerUser: {
        name: 'Resolved peer',
        avatar: 'data:image/webp;base64,aW1hZ2U=',
      },
    });
    await vi.waitFor(async () =>
      expect((await webdb.getThreads())[0]).toMatchObject({
        peerUser: {
          name: 'Resolved peer',
          avatar: 'data:image/webp;base64,aW1hZ2U=',
        },
      }),
    );
  });

  it('does not let an old peer resolution overwrite a newer relationship profile', async () => {
    const old = new Subject<ResolvedProfile>();
    const current = new Subject<ResolvedProfile>();
    vi.spyOn(TestBed.inject(ProfileResolutionService), 'resolve')
      .mockReturnValueOnce(old)
      .mockReturnValueOnce(current);
    const item = p2p(9, 0);
    Object.assign(item.peerUser, {
      domain: 'bravo.test',
      namespaceId: 1,
      profileRev: 3,
      name: '',
    });
    await populate([item]);
    repo['upsertThread']({
      ...item,
      peerUser: { ...item.peerUser, profileRev: 4, name: '' },
    });
    current.next({
      namespaceId: 1,
      account: 'u0',
      domain: 'bravo.test',
      rev: 4,
      name: 'Current',
      bio: '',
      avatarBase64: null,
    });
    old.next({
      namespaceId: 1,
      account: 'u0',
      domain: 'bravo.test',
      rev: 3,
      name: 'Old',
      bio: '',
      avatarBase64: 'b2xk',
    });
    expect(repo.items()[0]).toMatchObject({
      peerUser: { name: 'Current', profileRev: 4, avatar: '' },
    });
    old.complete();
    current.complete();
  });

  it('ignores a peer resolution that arrives after logout', async () => {
    const resolved = new Subject<ResolvedProfile>();
    vi.spyOn(
      TestBed.inject(ProfileResolutionService),
      'resolve',
    ).mockReturnValue(resolved);
    const item = p2p(9, 0);
    Object.assign(item.peerUser, { profileRev: 3, name: '' });
    await populate([item]);
    TestBed.inject(SessionLifecycleService).endSession();
    resolved.next({
      namespaceId: 0,
      account: 'u0',
      domain: 'local',
      rev: 3,
      name: 'Old session',
      bio: '',
      avatarBase64: 'b2xk',
    });
    resolved.complete();
    expect(repo.items()).toEqual([]);
  });

  async function emitThreadContentHead(
    threadId: number,
    seq: number,
    tombstoneEndSeq = 0,
  ): Promise<void> {
    if (
      (repo as unknown as { threadFeedCursor?: number }).threadFeedCursor ===
      undefined
    ) {
      emitHello({ userId: 1, stateFeedEndId: cursorSignal() ?? 0 });
      await flush(20);
    }
    const feedId = Number((await webdb.getMeta('threadFeedCursor')) ?? 0) + 1;
    queryThreadFeedSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          through: feedId,
          scannedThrough: feedId,
          threadFeedEndId: feedId,
          hasMore: false,
          items: [
            {
              threadId,
              threadFeedId: feedId,
              messageEndSeq: seq,
              tombstoneEndSeq,
              groupMetaFeedEndId: null,
              joinRequestEndFeedId: 0,
              joinRequestReadFeedId: -1,
              groupInviteEndFeedId: 0,
              lastReadSeq: 0,
              unreadCount: 0,
              lastMentionSeq: null,
              previews: [],
            },
          ],
        },
      }),
    );
    eventSubject.next({
      event: 'THREAD_FEED_UPDATED',
      data: { threadFeedEndId: feedId },
    });
    await flush(30);
  }

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

  it('warns instead of rejecting when the account database is not open', async () => {
    await webdb.closeAndDelete('1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(repo.load()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[cache-paint] cached thread read failed',
      expect.any(Error),
    );
    expect(repo.items()).toEqual([]);
    expect(toastWarn).not.toHaveBeenCalled();
    await webdb.openForUser('1');
    emitHello({ userId: 1, stateFeedEndId: 2 });
    await vi.waitFor(() => expect(cursorSignal()).toBe(2));
  });

  it.each(['getNamespaces', 'getThreads', 'getThreadStates'] as const)(
    'warns and requests recovery when cache pre-read %s fails',
    async (method) => {
      const failure = new Error('cache read failed');
      vi.spyOn(webdb, method).mockRejectedValueOnce(failure);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(repo.load()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        '[cache-paint] cached thread read failed',
        failure,
      );
      expect(
        TestBed.inject(UserService).requestCacheRebuild,
      ).toHaveBeenCalledOnce();
      expect(toastWarn).not.toHaveBeenCalled();
    },
  );

  it('handles failed HELLO cache initialization without an unhandled rejection', async () => {
    const failure = new Error('account cache cannot open');
    establishSessionSpy.mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    emitHello({ userId: 1, stateFeedEndId: 2 });
    await vi.waitFor(() =>
      expect(
        TestBed.inject(UserService).requestCacheRebuild,
      ).toHaveBeenCalledOnce(),
    );
    expect(warn).toHaveBeenCalledWith(
      '[cache-recovery] session cache initialization failed',
      failure,
    );
    expect(error).not.toHaveBeenCalled();
    expect(toastWarn).not.toHaveBeenCalled();
    expect(cursorSignal()).toBeUndefined();
  });

  // The clobber guard: a cache-paint that runs AFTER a fresher HELLO delta already populated the list
  // must BAIL — a late IDB read must not revert the list to the (now stale) cache.
  // Regression guard for the "暂无消息 on first launch" bug: the list embeds NO preview content, so each
  // thread's preview must be derived from its newest CACHED local message (local-first). load()'s paint
  // runs hydratePreviews — seed a local newest message + the cached thread, load, assert the preview +
  // sender are derived from the local message.

  // ── HELLO (the network-refresh half: delta-replay + missed-summary walk) ───────────────────────

  it('HELLO without a userId is ignored (no session established, no fetch)', async () => {
    emitHello({ stateFeedEndId: 0 }); // no userId → onHello bails before establishing the session
    await flush(20);
    expect(establishSessionSpy).not.toHaveBeenCalled();
    expect(queryStateFeedSpy).not.toHaveBeenCalled();
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

  it('drops pre-HELLO cached rows on logout before rebuilding the same user session', async () => {
    const stale = p2p(39, 21);
    await populate([stale]);
    expect(sessionUserId()).toBeNull();
    await webdb.closeAndDelete('1');
    sessionUserId.set(null);
    TestBed.inject(SessionLifecycleService).endSession();
    expect(repo.items()).toEqual([]);
    TestBed.tick();
    await webdb.recreateForUser('1');
    expect(await webdb.getThreads()).toEqual([]);
    const peer = stale.peerUser;
    const items = [threadStateEvent(2, 61)];
    queryThreadFeedSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          items: [
            {
              ...threadSnapshot(),
              threadId: 61,
              threadFeedId: 1,
              messageEndSeq: 0,
              unreadCount: 0,
              lastMentionSeq: null,
              previews: [],
            },
          ],
          through: 1,
          scannedThrough: 1,
          threadFeedEndId: 1,
          hasMore: false,
        },
      }),
    );
    queryStateFeedSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          mode: 'full',
          items,
          scannedThrough: 2,
          stateFeedEndId: 2,
          hasMore: false,
        },
      }),
    );
    emitHello({ userId: 1, stateFeedEndId: 2, threadFeedEndId: 1 });
    await flush(40);
    expect((await webdb.getThreads()).map((t) => t.threadId)).toEqual([61]);
    expect(
      repo
        .items()
        .map((t) => t.threadId)
        .sort((a, b) => a - b),
    ).toEqual([61]);
  });

  it('discards an eager cache read that finishes after the session ends', async () => {
    let finishRead!: (items: ConversationItem[]) => void;
    const read = vi.spyOn(webdb, 'getThreads').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const loading = repo.load();
    await vi.waitFor(() => expect(read).toHaveBeenCalled());

    TestBed.inject(SessionLifecycleService).endSession();
    finishRead([p2p(39, 21)]);
    await loading;

    expect(repo.items()).toEqual([]);
    expect(repo.status()).toBe('LOADING');
  });

  // ── live THREAD_CONTENT_HEAD projections ──────────────────────────────────────────────────────

  it('a content head advances the HWM without changing list presentation or unread', async () => {
    await populate([
      p2p(1, 11, { lastMessageAt: 100 }),
      p2p(2, 22, { lastMessageAt: 200 }),
    ]);
    const initialOrder = repo.items().map((item) => item.threadId);

    await emitThreadContentHead(1, 100);

    const items = repo.items();
    expect(items.map((item) => item.threadId)).toEqual(initialOrder);
    expect(repo.latestSeq(1)).toBe(100);
    const changed = items.find((item) => item.threadId === 1);
    expect(changed?.lastMessageSeq).toBe(100);
    expect(changed?.lastMessageAt).toBe(100);
    // unreadCount is NOT bumped — it is server-authoritative, applied by the missed-summary pull.
    expect(items[0].unreadCount).toBe(0);
    const rec = await (await webdb.db()).get('threads', 1);
    expect(rec?.unreadCount).toBe(0);
    expect(rec?.lastMessageSeq).toBe(100);
  });

  it('a content head does not badge the open thread', async () => {
    await populate([p2p(1, 11)]);
    await repo.setOpenThread(1);
    await emitThreadContentHead(1, 100);
    expect(repo.items()[0].unreadCount).toBe(0);
  });

  it('applies a member feed that removes the local manager role', async () => {
    await populate([
      createGroupConversation(
        7,
        { id: 70, account: '!team', name: 'Team', ownerId: 1 },
        { role: 'ADMIN', threadFeedId: 7 },
      ),
    ]);

    repo.applyGroupUpdate(7, { role: 'MEMBER' });

    expect(repo.items()[0]).toMatchObject({ threadId: 7, role: 'MEMBER' });
  });

  it('a duplicate content head does not emit a second message signal', async () => {
    await populate([p2p(1, 11, { lastMessageAt: 100 })]);
    const signals: Array<{ threadId: number; seq: number }> = [];
    const subscription = repo.threadSeq$.subscribe((signal) =>
      signals.push(signal),
    );
    await emitThreadContentHead(1, 100);
    expect(repo.items()[0].lastMessageAt).toBe(100);
    await emitThreadContentHead(1, 100);
    expect(repo.items()[0].lastMessageAt).toBe(100);
    expect(signals).toEqual([{ threadId: 1, seq: 100 }]);
    subscription.unsubscribe();
  });

  // ── mutations (each writes through to IDB + emits a fine-grained signal update) ───────────────

  it('orders pinned and ordinary tiers strictly by descending threadFeedId', async () => {
    await populate([
      p2p(1, 11, { threadFeedId: 30 }),
      p2p(2, 22, { threadFeedId: 10, pinned: true }),
      p2p(3, 33, { threadFeedId: 20 }),
      p2p(4, 44, { threadFeedId: 40, pinned: true }),
    ]);

    expect(repo.items().map((thread) => thread.threadId)).toEqual([4, 2, 1, 3]);
  });

  it('moves an updated ordinary thread by its newer threadFeedId', async () => {
    await populate([
      p2p(1, 11, { threadFeedId: 1 }),
      p2p(2, 22, { threadFeedId: 2 }),
    ]);
    expect(repo.items().map((thread) => thread.threadId)).toEqual([2, 1]);

    await publishThreadState(
      { ...threadSnapshot(), threadId: 1, threadFeedId: 3 },
      true,
    );

    expect(repo.items().map((thread) => thread.threadId)).toEqual([1, 2]);
  });

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
    expect(repo.items().map((t) => t.threadId)).toEqual([2, 1]);

    repo.applyThreadMeta(2, {
      muted: true,
      blocked: true,
      alias: 'Quiet',
    });
    await flush();

    expect(repo.items().map((t) => t.threadId)).toEqual([2, 1]);
    expect(repo.items()[0]).toEqual(
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

  it('hydrates a newly activated zero-message friendship thread from THREAD_STATE', async () => {
    emitHello({ userId: 1, stateFeedEndId: 0 });
    await flush(20);
    cursorSignal.set(1);
    const peer = {
      id: 22,
      account: 'bob',
      name: 'Bob',
      avatar: '',
      bio: '',
      domain: 'peer.test',
      namespaceId: 12,
    };
    queryStateFeedSpy.mockReturnValue(
      of({
        code: 0,
        data: {
          mode: 'delta',
          items: [
            threadStateEvent(3, 9, {
              authorityNamespaceId: 12,
              profile: {
                account: 'bob',
                domain: 'peer.test',
                namespaceId: 12,
                profileRev: 0,
              },
            }),
          ],
          hasMore: false,
          scannedThrough: 4,
          stateFeedEndId: 4,
        },
      }),
    );
    eventSubject.next({
      event: 'STATE_FEED_UPDATED',
      data: { feedId: 4 },
    });
    await flush(30);
    await publishThreadState({
      ...threadSnapshot(),
      threadId: 9,
      threadFeedId: 1,
      messageEndSeq: 0,
      unreadCount: 0,
      lastMentionSeq: null,
      previews: [],
    });

    expect(repo.items()).toEqual([
      expect.objectContaining({
        threadId: 9,
        friendshipActive: true,
        conversationState: 'ACTIVE',
        lastMessageSeq: 0,
      }),
    ]);
  });

  it('publishes one friend-intent revision only after draining through the committed feed HWM', async () => {
    cursorSignal.set(1);
    const peer = {
      id: 22,
      account: 'bob',
      name: 'Bob',
      avatar: '',
      bio: '',
      domain: 'local',
    };
    const secondPage = new Subject<unknown>();
    queryStateFeedSpy
      .mockReturnValueOnce(
        of({
          code: 0,
          data: {
            mode: 'delta',
            items: [
              {
                feedId: 2,
                account: 'bob',
                domain: 'local',
                eventType: 'RELATIONSHIP_INTENT',
                subjectAccount: 'alice',
                subjectDomain: 'local',
                body: {
                  status: 'ACCEPTED',
                  note: '',
                  requestedAt: 1,
                  expiresAt: null,
                  direction: 'INCOMING',
                  localThreadId: 9,
                  peer,
                },
              },
            ],
            hasMore: false,
            scannedThrough: 2,
            stateFeedEndId: 3,
          },
        }),
      )
      .mockReturnValueOnce(secondPage);

    eventSubject.next({
      event: 'STATE_FEED_UPDATED',
      data: { feedId: 2 },
    });
    await flush(10);

    expect(queryStateFeedSpy).toHaveBeenCalledTimes(2);
    expect(queryStateFeedSpy.mock.calls[1][0]).toEqual(
      expect.objectContaining({ after: 2, through: 3 }),
    );
    expect(applyRelationshipIntentStateRevisionSpy).not.toHaveBeenCalled();

    secondPage.next({
      code: 0,
      data: {
        mode: 'delta',
        items: [
          {
            feedId: 3,
            account: 'alice',
            domain: 'local',
            eventType: 'RELATIONSHIP_INTENT',
            subjectAccount: 'bob',
            subjectDomain: 'local',
            body: {
              status: 'ACCEPTED',
              note: '',
              requestedAt: 1,
              expiresAt: null,
              direction: 'OUTGOING',
              localThreadId: 9,
              peer,
            },
          },
        ],
        hasMore: false,
        scannedThrough: 3,
        stateFeedEndId: 3,
      },
    });
    secondPage.complete();
    await flush(10);

    expect(applyRelationshipIntentStateRevisionSpy).toHaveBeenCalledTimes(1);
    expect(applyRelationshipIntentStateRevisionSpy).toHaveBeenCalledWith(3);
  });
});
