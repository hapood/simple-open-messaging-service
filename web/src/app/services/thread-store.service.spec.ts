import { SessionLifecycleService } from './session-lifecycle.service';
import type { Mock } from 'vitest';
import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import { WebdbService } from './webdb.service';
import { rawPreview, ThreadRepository } from './thread-store.service';
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
    opts,
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
  let queryReadDeltaSpy: Mock;
  let queryUserInfoSpy: Mock;
  let advanceCursorSpy: Mock;
  let applyRelationshipRequestStateRevisionSpy: Mock;
  let applyRelationshipIntentStateRevisionSpy: Mock;
  let applyGroupJoinRequestHeadSpy: Mock;
  let clearGroupJoinRequestHeadSpy: Mock;
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
            applyGroupJoinRequestHead: (applyGroupJoinRequestHeadSpy = vi
              .fn()
              .mockName('applyGroupJoinRequestHead')
              .mockReturnValue(true)),
            clearGroupJoinRequestHead: (clearGroupJoinRequestHeadSpy = vi
              .fn()
              .mockName('clearGroupJoinRequestHead')),
            queryReadDelta: (queryReadDeltaSpy = vi
              .fn()
              .mockName('queryReadDelta')
              .mockReturnValue(
                of({ code: 0, data: { readRevision: 0, items: [] } }),
              )),
            queryUserInfo: (queryUserInfoSpy = vi
              .fn()
              .mockName('queryUserInfo')
              .mockReturnValue(of({ code: 0, data: [] }))),
            queryGroupMeta: vi.fn().mockReturnValue(
              of({
                code: 0,
                data: {
                  account: '!dev',
                  mode: 'full',
                  items: [],
                  scannedThrough: '1',
                  groupMetaFeedEndId: '1',
                  hasMore: false,
                },
              }),
            ),
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
    readRevision?: number;
  }): void {
    eventSubject.next({
      event: 'HELLO',
      data,
    });
  }

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
    for (const it of items) await tx.store.put(it);
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
      account: 'peer',
      domain: 'bravo.test',
      rev: 3,
      name: 'Peer image',
      bio: '',
      avatarBase64: 'aW1hZ2U=',
    };
    resolved.next({ selector: { threadId: 9, messageSeq: 2 }, profile });
    resolved.next({
      selector: { threadId: 9, messageSeq: 3 },
      profile: { ...profile, account: 'me', name: 'Self' },
    });
    resolved.next({
      selector: { threadId: 9, messageSeq: 1 },
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
      selector: { threadId: 9, messageSeq: 4 },
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
    });
    await populate([item]);
    const profile = {
      account: 'peer',
      domain: 'bravo.test',
      rev: 1,
      name: 'Message',
      bio: '',
      avatarBase64: null,
    };
    TestBed.inject(ProfileResolutionService)['resolved'].next({
      selector: { threadId: 9, messageSeq: 4 },
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
      avatar: '',
    });
    await populate([item]);
    expect(resolve).toHaveBeenCalledWith({
      account: 'check03-b-001',
      domain: 'bravo.test',
      rev: 3,
    });
    resolved.next({
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
    });
    await populate([item]);
    repo['upsertThread']({
      ...item,
      peerUser: { ...item.peerUser, profileRev: 4 },
    });
    current.next({
      account: 'u0',
      domain: 'bravo.test',
      rev: 4,
      name: 'Current',
      bio: '',
      avatarBase64: null,
    });
    old.next({
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
    item.peerUser.profileRev = 3;
    await populate([item]);
    TestBed.inject(SessionLifecycleService).endSession();
    resolved.next({
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
    const after = cursorSignal() ?? 1;
    if (cursorSignal() === undefined) cursorSignal.set(after);
    const feedId = after + 1;
    queryStateFeedSpy.mockReturnValueOnce(
      of({
        code: 0,
        data: {
          mode: 'delta',
          items: [
            {
              feedId,
              account: '',
              domain: 'local',
              namespaceId: 0,
              eventType: 'THREAD_CONTENT_HEAD',
              subjectAccount: '',
              subjectDomain: 'local',
              body: {
                threadId,
                messageEndSeq: seq,
                tombstoneEndSeq,
              },
            },
          ],
          hasMore: false,
          scannedThrough: feedId,
          stateFeedEndId: feedId,
        },
      }),
    );
    eventSubject.next({
      event: 'STATE_FEED_UPDATED',
      data: { feedId },
    });
    await flush(20);
  }

  // ── eager cache-paint (load — the instant pre-HELLO boot path) ─────────────────────────────────

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

  it.each(['getNamespaces', 'getThreads', 'getMeta'] as const)(
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

  it('handles a detached preview read failure and requests recovery', async () => {
    await seedCachedThread(p2p(1, 11));
    const failure = new Error('message cache unreadable');
    vi.spyOn(
      TestBed.inject(MessageRepository),
      'getNewestMessages',
    ).mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await repo.load();
    await vi.waitFor(() =>
      expect(
        TestBed.inject(UserService).requestCacheRebuild,
      ).toHaveBeenCalledOnce(),
    );
    expect(warn).toHaveBeenCalledWith(
      '[cache-paint] cached message preview read failed',
      failure,
    );
    expect(repo.items()[0].threadId).toBe(1);
    expect(toastWarn).not.toHaveBeenCalled();
  });

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
  it('load() re-derives the list preview from the newest cached local message (local-first)', async () => {
    await seedCachedThread(p2p(1, 77));
    await seedMessage(1, 5, 'hello world', {
      account: 'u77',
      domain: 'local',
      namespaceId: 0,
    });
    repo.load();
    await flush(20);
    const items = repo.items();
    expect(items[0].lastMessagePreview).toBe('hello world');
    expect(items[0].lastMessageSenderId).toBe('[0,"local","u77"]');
  });

  it('fetches a preview body for a content head without any local messages', async () => {
    await populate([p2p(1, 77)]);
    const history = vi
      .spyOn(TestBed.inject(MessageRepository), 'queryBrowserMessageHistory')
      .mockResolvedValue({
        failed: false,
        hasOlder: false,
        hasNewer: false,
        items: [
          {
            kind: 'message',
            message: {
              threadId: 1,
              seq: 5,
              contentType: 'PURE_TEXT',
              content: JSON.stringify({ text: 'cold preview' }),
              creator: { account: 'u77', domain: 'local', namespaceId: 0 },
              createdAt: 1234,
              updatedAt: 1234,
              isDeleted: false,
            } as Message,
          },
        ],
      });
    await emitThreadContentHead(1, 5);
    await flush(20);
    expect(history).toHaveBeenCalledWith(1, { kind: 'latest', count: 1 });
    expect(repo.items()[0]).toMatchObject({
      lastMessagePreview: 'cold preview',
      lastMessagePreviewSeq: 5,
      lastMessageAt: 1234,
    });
    await emitThreadContentHead(1, 5);
    expect(history).toHaveBeenCalledTimes(1);
  });

  it('pulls and commits preview bodies after SSE content updates without opening the chat', async () => {
    await populate([p2p(1, 77)]);
    let seq = 1;
    const page = vi.fn().mockImplementation((query: { before?: number }) =>
      of(
        query.before === undefined
          ? { code: 30006, data: { resumeAfter: 0, resumeBefore: seq + 1 } }
          : {
              code: 0,
              data: {
                messages: [
                  {
                    threadId: 1,
                    seq,
                    contentType: 'PURE_TEXT',
                    content: JSON.stringify({ text: `preview ${seq}` }),
                    creator: {
                      account: 'u77',
                      domain: 'local',
                      namespaceId: 0,
                    },
                    createdAt: seq,
                    updatedAt: seq,
                    isDeleted: false,
                  },
                ],
                gaps: [],
                scannedThrough: seq,
                hasMore: seq > 1,
              },
            },
      ),
    );
    Object.assign(TestBed.inject(MsgService), {
      queryMessageHistoryPage: page,
    });

    await emitThreadContentHead(1, seq);
    await flush(20);
    expect(repo.items()[0].lastMessagePreview).toBe('preview 1');
    seq = 2;
    await emitThreadContentHead(1, seq);
    await flush(20);
    expect(repo.items()[0].lastMessagePreview).toBe('preview 2');
    expect(repo.openThreadId()).toBeUndefined();
    expect(
      (await TestBed.inject(MessageRepository).getNewestMessages([1])).get(1)
        ?.seq,
    ).toBe(2);
    expect(
      (await (await webdb.db()).get('threads', 1))?.lastMessagePreview,
    ).toBe('preview 2');
  });

  it('keeps the old preview during a pending pull, failure, and gap, then retries on a content notification', async () => {
    await populate([
      p2p(1, 77, {
        lastMessagePreview: 'old preview',
        lastMessagePreviewSeq: 1,
      }),
    ]);
    type Result = Awaited<
      ReturnType<MessageRepository['queryBrowserMessageHistory']>
    >;
    let finish!: (result: Result) => void;
    const history = vi
      .spyOn(TestBed.inject(MessageRepository), 'queryBrowserMessageHistory')
      .mockReturnValueOnce(
        new Promise<Result>((resolve) => {
          finish = resolve;
        }),
      );
    await emitThreadContentHead(1, 2);
    expect(repo.items()[0].lastMessagePreview).toBe('old preview');
    finish({ items: [], hasOlder: true, hasNewer: true, failed: true });
    await flush(20);
    expect(repo.items()[0].lastMessagePreview).toBe('old preview');

    history.mockResolvedValueOnce({
      items: [
        { kind: 'serverGap', left: 1, right: 2, state: 'SERVER_PENDING' },
      ],
      hasOlder: true,
      hasNewer: false,
      failed: false,
    });
    await emitThreadContentHead(1, 2);
    expect(repo.items()[0].lastMessagePreview).toBe('old preview');

    history.mockResolvedValueOnce({
      items: [
        {
          kind: 'message',
          message: {
            threadId: 1,
            seq: 2,
            contentType: 'PURE_TEXT',
            content: JSON.stringify({ text: 'new preview' }),
            creator: { account: 'u77', domain: 'local', namespaceId: 0 },
            createdAt: 2,
            updatedAt: 2,
            isDeleted: false,
          } as Message,
        },
      ],
      hasOlder: true,
      hasNewer: false,
      failed: false,
    });
    await emitThreadContentHead(1, 2);
    expect(history).toHaveBeenCalledTimes(3);
    expect(repo.items()[0].lastMessagePreview).toBe('new preview');
  });

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
    const items = [false, true].map((reverse, index) => ({
      feedId: index + 1,
      eventType: 'RELATIONSHIP_INTENT',
      namespaceId: 0,
      account: reverse ? peer.account : 'me',
      domain: 'local',
      subjectAccount: reverse ? 'me' : peer.account,
      subjectDomain: 'local',
      body: {
        status: 'ACCEPTED',
        direction: reverse ? 'INCOMING' : 'OUTGOING',
        note: '',
        requestedAt: 1,
        expiresAt: null,
        localThreadId: 61,
        peer,
      },
    }));
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
    emitHello({ userId: 1, stateFeedEndId: 2 });
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

  it('buffers only the newest content head while a read commit is pending', async () => {
    await populate([p2p(1, 11, { lastMessageSeq: 4, lastMessageAt: 100 })]);
    repo.beginReadCommit(1);

    await emitThreadContentHead(1, 5);
    await emitThreadContentHead(1, 7);
    await emitThreadContentHead(1, 6);
    expect(repo.items()[0].lastMessageSeq).toBe(4);
    expect(repo.readCommitPending().has(1)).toBe(true);

    repo.finishReadCommit(1);

    expect(repo.readCommitPending().has(1)).toBe(false);
    expect(repo.items()[0]).toEqual(
      expect.objectContaining({
        lastMessageSeq: 7,
        lastMessageAt: 100,
      }),
    );
  });

  it('a content head does not badge the open thread', async () => {
    await populate([p2p(1, 11)]);
    await repo.setOpenThread(1);
    await emitThreadContentHead(1, 100);
    expect(repo.items()[0].unreadCount).toBe(0);
  });

  it('garbage-collects manager attention when a member feed removes the local manager role', async () => {
    await populate([
      createGroupConversation(
        7,
        { id: 70, account: '!team', name: 'Team', ownerId: 1 },
        { role: 'ADMIN' },
      ),
    ]);

    repo.applyGroupUpdate(7, { role: 'MEMBER' });

    expect(clearGroupJoinRequestHeadSpy).toHaveBeenCalledWith(7);
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
    expect(repo.items().map((t) => t.threadId)).toEqual([1, 2]);

    repo.applyThreadMeta(2, {
      muted: true,
      blocked: true,
      alias: 'Quiet',
    });
    await flush();

    expect(repo.items().map((t) => t.threadId)).toEqual([1, 2]);
    expect(repo.items()[1]).toEqual(
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

  it('does not move a thread when a join-request head is only the optimistic read acknowledgement', async () => {
    await populate([
      p2p(1, 11, { lastMessageAt: 200 }),
      p2p(2, 22, { lastMessageAt: 100 }),
    ]);
    cursorSignal.set(1);
    applyGroupJoinRequestHeadSpy.mockReturnValue(false);
    queryStateFeedSpy.mockReturnValue(
      of({
        code: 0,
        data: {
          mode: 'delta',
          items: [
            {
              feedId: 2,
              account: '!group',
              domain: 'local',
              eventType: 'GROUP_JOIN_REQUEST_HEAD',
              subjectAccount: '',
              subjectDomain: 'local',
              body: {
                threadId: 2,
                latestFeedId: 12,
                latestRequestAt: 300,
                readFeedId: 12,
              },
            },
          ],
          hasMore: false,
          scannedThrough: 2,
          stateFeedEndId: 2,
        },
      }),
    );

    eventSubject.next({ event: 'STATE_FEED_UPDATED', data: { feedId: 2 } });
    await flush(30);

    expect(repo.items().map((thread) => thread.threadId)).toEqual([1, 2]);
    expect(repo.items()[1].joinRequestAt).toBeUndefined();
  });

  it('moves an ordinary thread to the ordinary-tier head for a genuinely new join request', async () => {
    await populate([
      p2p(1, 11, { lastMessageAt: 200 }),
      p2p(2, 22, { lastMessageAt: 100 }),
    ]);
    cursorSignal.set(1);
    queryStateFeedSpy.mockReturnValue(
      of({
        code: 0,
        data: {
          mode: 'delta',
          items: [
            {
              feedId: 2,
              account: '!group',
              domain: 'local',
              eventType: 'GROUP_JOIN_REQUEST_HEAD',
              subjectAccount: '',
              subjectDomain: 'local',
              body: {
                threadId: 2,
                latestFeedId: 13,
                latestRequestAt: 300,
                readFeedId: 12,
              },
            },
          ],
          hasMore: false,
          scannedThrough: 2,
          stateFeedEndId: 2,
        },
      }),
    );

    eventSubject.next({ event: 'STATE_FEED_UPDATED', data: { feedId: 2 } });
    await flush(30);

    expect(repo.items().map((thread) => thread.threadId)).toEqual([2, 1]);
    expect(repo.items()[0].joinRequestAt).toBe(300);
  });

  it('hydrates a newly activated zero-message friendship thread from relationship state', async () => {
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
            {
              feedId: 2,
              account: 'alice',
              domain: 'local.test',
              namespaceId: 12,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: 'bob',
              subjectDomain: 'peer.test',
              body: {
                status: 'REQUESTED',
                note: '',
                requestedAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                direction: 'OUTGOING',
                localThreadId: 9,
                peer,
              },
            },
            {
              feedId: 3,
              account: 'bob',
              domain: 'peer.test',
              namespaceId: 12,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: 'alice',
              subjectDomain: 'local.test',
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
            {
              feedId: 4,
              account: '',
              domain: 'local',
              namespaceId: 0,
              eventType: 'THREAD_CONTENT_HEAD',
              subjectAccount: '',
              subjectDomain: 'local',
              body: {
                threadId: 9,
                messageEndSeq: 7,
                tombstoneEndSeq: 0,
              },
            },
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

    expect(repo.items()).toEqual([
      expect.objectContaining({
        threadId: 9,
        friendshipActive: true,
        conversationState: 'ACTIVE',
        lastMessageSeq: 7,
      }),
    ]);
  });

  it('commits group profile and member references before refreshing the same page message preview', async () => {
    emitHello({ userId: 1, stateFeedEndId: 0 });
    await flush(20);
    cursorSignal.set(1);
    (TestBed.inject(UserService).queryGroupMeta as Mock).mockReturnValue(
      of({
        code: 0,
        data: {
          account: '!dev',
          mode: 'full',
          scannedThrough: '2',
          groupMetaFeedEndId: '2',
          hasMore: false,
          items: [
            {
              feedId: '1',
              operation: 'GROUP_PROFILE',
              body: { profileRev: 2 },
            },
            {
              feedId: '2',
              operation: 'UPSERT',
              account: 'alice',
              domain: 'local',
              namespaceId: 0,
              body: { role: 'OWNER', profileRev: 1 },
            },
          ],
        },
      }),
    );
    vi.spyOn(
      TestBed.inject(ProfileResolutionService),
      'resolve',
    ).mockReturnValue(
      of({
        account: '!dev',
        domain: 'local',
        rev: 2,
        name: 'Resolved dev',
        bio: '',
        avatarBase64: null,
      }),
    );
    vi.spyOn(
      TestBed.inject(MessageRepository),
      'queryBrowserMessageHistory',
    ).mockResolvedValue({
      failed: false,
      hasOlder: false,
      hasNewer: false,
      items: [
        {
          kind: 'message',
          message: {
            threadId: 12,
            seq: 1,
            contentType: 'PURE_TEXT',
            content: JSON.stringify({ text: 'group preview' }),
            creator: { account: 'alice', domain: 'local', namespaceId: 0 },
            createdAt: 1,
            updatedAt: 1,
            isDeleted: false,
          } as Message,
        },
      ],
    });
    const group = {
      account: '!dev',
      domain: 'local',
      isLocal: true,
      name: 'dev',
      avatar: '',
      description: '',
      profileRev: 1,
      namespaceId: 0,
    };
    queryStateFeedSpy.mockReturnValue(
      of({
        code: 0,
        data: {
          mode: 'delta',
          items: [
            {
              feedId: 2,
              account: '!dev',
              domain: 'local',
              namespaceId: 0,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: 'alice',
              subjectDomain: 'local',
              body: {
                status: 'ACCEPTED',
                note: '',
                requestedAt: 1,
                expiresAt: null,
                direction: 'INCOMING',
                threadId: 12,
                group,
              },
            },
            {
              feedId: 3,
              account: 'alice',
              domain: 'local',
              namespaceId: 0,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: '!dev',
              subjectDomain: 'local',
              body: {
                status: 'ACCEPTED',
                note: '',
                requestedAt: 1,
                expiresAt: null,
                direction: 'OUTGOING',
                threadId: 12,
                group,
              },
            },
            {
              feedId: 4,
              account: '!dev',
              domain: 'local',
              namespaceId: 0,
              eventType: 'GROUP_META_FEED_HEAD',
              subjectAccount: '',
              subjectDomain: 'local',
              body: { groupMetaFeedEndId: '2' },
            },
            {
              feedId: 5,
              account: '',
              domain: 'local',
              namespaceId: 0,
              eventType: 'THREAD_CONTENT_HEAD',
              subjectAccount: '',
              subjectDomain: 'local',
              body: { threadId: 12, messageEndSeq: 1, tombstoneEndSeq: 0 },
            },
          ],
          hasMore: false,
          scannedThrough: 5,
          stateFeedEndId: 5,
        },
      }),
    );

    eventSubject.next({ event: 'STATE_FEED_UPDATED', data: { feedId: 5 } });
    await flush(30);

    expect(toastWarn).not.toHaveBeenCalled();
    expect(repo.items()).toEqual([
      expect.objectContaining({
        threadId: 12,
        type: 'GROUP',
        lastMessagePreview: 'group preview',
        group: expect.objectContaining({
          account: '!dev',
          name: 'Resolved dev',
          profileRev: 2,
        }),
      }),
    ]);
    expect(await webdb.getMeta('stateFeedId')).toBe(5);
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

  it('records a local HWM without guessing the unread badge', async () => {
    await populate([
      p2p(1, 11, {
        lastReadSeq: 5,
        lastMessageSeq: 8,
        unreadCount: 3,
        mentionUnread: ['me'],
      }),
    ]);

    expect(repo.commitLocalRead(1, 7)).toBe(true);
    expect(repo.items()[0]).toEqual(
      expect.objectContaining({
        lastReadSeq: 5,
        unreadCount: 3,
        mentionUnread: ['me'],
      }),
    );
    expect(repo.commitLocalRead(1, 7)).toBe(false);
  });

  it('atomically applies the server read state', async () => {
    await populate([p2p(1, 11, { lastReadSeq: 5, unreadCount: 3 })]);
    repo.commitLocalRead(1, 7);

    repo.applyReadState({
      threadId: 1,
      lastReadSeq: 7,
      readRevision: 1,
      unreadCount: 1,
      mentionUnread: ['all'],
    });

    expect(repo.items()[0]).toEqual(
      expect.objectContaining({
        lastReadSeq: 7,
        unreadCount: 1,
        mentionUnread: ['all'],
      }),
    );
  });

  it('pulls read delta when HELLO exposes a revision gap', async () => {
    await populate([p2p(1, 11, { lastReadSeq: 2, unreadCount: 4 })]);
    await webdb.putMeta('readRevision', 2);
    queryReadDeltaSpy.mockReturnValue(
      of({
        code: 0,
        data: {
          readRevision: 5,
          items: [
            {
              threadId: 1,
              lastReadSeq: 6,
              readRevision: 5,
              unreadCount: 0,
              mentionUnread: [],
            },
          ],
        },
      }),
    );

    emitHello({ userId: 1, stateFeedEndId: 0, readRevision: 5 });
    await flush(20);

    expect(queryReadDeltaSpy).toHaveBeenCalledWith({
      fromRevision: 2,
      toRevision: 5,
    });
    expect(repo.items()[0]).toEqual(
      expect.objectContaining({ lastReadSeq: 6, unreadCount: 0 }),
    );
    expect(await webdb.getMeta('readRevision')).toBe(5);
  });

  it('treats attention SSE as a cursor-only wake-up and pulls its projection', async () => {
    await populate([p2p(1, 11, { lastReadSeq: 2, unreadCount: 4 })]);
    await webdb.putMeta('readRevision', 2);
    emitHello({ userId: 1, stateFeedEndId: 0, readRevision: 2 });
    await flush(20);
    queryReadDeltaSpy.mockClear();
    queryReadDeltaSpy.mockReturnValue(
      of({
        code: 0,
        data: {
          readRevision: 3,
          items: [
            {
              threadId: 1,
              lastReadSeq: 7,
              readRevision: 3,
              unreadCount: 0,
              mentionUnread: [],
            },
          ],
        },
      }),
    );

    eventSubject.next({
      event: 'ATTENTION_REV_UPDATED',
      data: { attentionRevision: 3 },
    });
    await flush(20);

    expect(queryReadDeltaSpy).toHaveBeenCalledWith({
      fromRevision: 2,
      toRevision: 3,
    });
    expect(repo.items()[0]).toEqual(
      expect.objectContaining({ lastReadSeq: 7, unreadCount: 0 }),
    );
  });

  // ── per-thread dismiss-HWM (the away-notification per-thread grouping state) ─────────────────

  it('recordThreadDismiss advances a thread HWM + persists the map to IDB', async () => {
    repo.recordThreadDismiss({ threadId: 7, seq: 3 });
    await flush();
    expect(repo.threadHwms()).toEqual({ 7: 3 });
    expect(await webdb.getMeta('threadHwms')).toEqual({ 7: 3 });
  });

  it('recordThreadDismiss merges per-thread and never regresses (monotonic)', async () => {
    repo.recordThreadDismiss({ threadId: 7, seq: 5 });
    repo.recordThreadDismiss({ threadId: 9, seq: 2 });
    repo.recordThreadDismiss({ threadId: 7, seq: 3 }); // stale / lower → ignored
    await flush();
    expect(repo.threadHwms()).toEqual({ 7: 5, 9: 2 });
  });

  it('clearThreadDismiss resets the map to empty + persists {}', async () => {
    repo.recordThreadDismiss({ threadId: 7, seq: 5 });
    await flush();
    repo.clearThreadDismiss();
    await flush();
    expect(repo.threadHwms()).toEqual({});
    expect(await webdb.getMeta('threadHwms')).toEqual({});
  });

  it('clearThreadDismiss is a no-op when already empty', async () => {
    repo.clearThreadDismiss();
    await flush();
    expect(repo.threadHwms()).toEqual({});
    expect(await webdb.getMeta('threadHwms')).toBeUndefined();
  });

  it('loadThreadHwms hydrates from IDB on HELLO (boot restore of a persisted map)', async () => {
    await webdb.putMeta('threadHwms', { 7: 5, 9: 2 });
    emitHello({ userId: 1, stateFeedEndId: 5 });
    await flush(20);
    expect(repo.threadHwms()).toEqual({ 7: 5, 9: 2 });
  });

  it('session-end reset (logout) clears the thread HWMs', async () => {
    sessionUserId.set(1);
    repo.recordThreadDismiss({ threadId: 7, seq: 5 });
    await flush();
    expect(repo.threadHwms()).toEqual({ 7: 5 });
    sessionUserId.set(null); // logout → reset()
    await flush(20);
    expect(repo.threadHwms()).toEqual({});
  });
});

describe('rawPreview', () => {
  it('renders a link card title instead of leaking its JSON envelope', () => {
    expect(
      rawPreview(
        'LINK',
        JSON.stringify({
          url: 'https://example.com/article',
          title: '  An example\narticle  ',
          description: 'Description',
        }),
      ),
    ).toBe('An example article');
  });

  it('falls back to the link URL when the card has no title', () => {
    expect(
      rawPreview(
        'LINK',
        JSON.stringify({ url: 'https://example.com/article', title: '  ' }),
      ),
    ).toBe('https://example.com/article');
  });

  it('uses a link description before the URL when the provider has no title', () => {
    expect(
      rawPreview(
        'LINK',
        JSON.stringify({
          url: 'https://v.douyin.com/example',
          title: '',
          description: '  Douyin video\ncaption  ',
        }),
      ),
    ).toBe('Douyin video caption');
  });

  it('renders semantic mentions as readable labels instead of leaking the storage URI', () => {
    expect(
      rawPreview(
        'PURE_TEXT',
        JSON.stringify({
          text: '你好 [@张三](somfp://user/zhangsan%40example.com)',
          quote: {
            seq: 7,
            author: '李四',
            body: '不应进入会话摘要',
          },
        }),
      ),
    ).toBe('你好 @张三');
  });

  it('renders a forwarded bundle as a readable summary instead of raw JSON', () => {
    expect(
      rawPreview(
        'FORWARD',
        JSON.stringify({
          bundleId: 'bundle-1',
          summaryLines: ['王涛：[图片]', '李雷：你好'],
        }),
      ),
    ).toBe('[Chat history] 王涛：[图片]');
  });

  it('falls back to the forward marker for malformed bundle content', () => {
    expect(rawPreview('FORWARD', '{')).toBe('[Chat history]');
  });

  it('renders an all-file gallery as a file-set summary instead of raw JSON', () => {
    expect(
      rawPreview(
        'GALLERY',
        JSON.stringify({ items: [{ kind: 'FILE' }, { kind: 'FILE' }] }),
      ),
    ).toBe('[File set · 2]');
  });

  it('renders a mixed file set with its item count and safely handles malformed content', () => {
    expect(
      rawPreview(
        'GALLERY',
        JSON.stringify({ items: [{ kind: 'IMAGE' }, { kind: 'VIDEO' }] }),
      ),
    ).toBe('[File set · 2]');
    expect(rawPreview('GALLERY', '{')).toBe('[File set]');
  });
});
