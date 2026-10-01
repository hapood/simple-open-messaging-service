import 'fake-indexeddb/auto';
import { WebdbStorage } from './webdb-storage';
import { WebdbService } from './webdb.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { createP2PConversation } from './model';
import { syncThreadFeed } from './thread-feed-sync';
import { threadFeedSnapshot, threadStructure } from './thread-feed.test-helper';

describe('shared background storage', () => {
  const userId = '9107';
  let storage: WebdbStorage;
  const groupMetaRequest = vi.fn(async () => {
    throw new Error('unexpected group-meta request');
  });
  const profileResolver = vi.fn(async () => false);

  beforeEach(() => {
    storage = new WebdbStorage();
  });
  afterEach(async () => {
    await storage.closeAndDelete(userId);
  });

  it('runs feed synchronization without an Angular injector or a nested worker', async () => {
    await storage.openForUser(userId);
    const result = await syncThreadFeed(
      storage,
      1,
      async () => ({
        code: 0,
        data: {
          items: [
            threadFeedSnapshot(7, {
              profile: {
                account: 'peer',
                domain: 'local',
                namespaceId: 0,
                profileRev: 0,
              },
              messageEndSeq: 2,
              unreadCount: 2,
            }),
          ],
          scannedThrough: 1,
          through: 1,
          threadFeedEndId: 1,
          hasMore: false,
        },
      }),
      groupMetaRequest,
      profileResolver,
    );
    expect(result.cursor).toBe(1);
    expect(
      result.states[0].threadFeedId === null
        ? undefined
        : result.states[0].unreadCount,
    ).toBe(2);
    await storage.close();
    const page = new WebdbService(() => null);
    try {
      await page.openExistingForUser(userId);
      expect(await page.getMeta('threadFeedCursor')).toBe(1);
      expect((await page.getThreadStates())[0]).toEqual(result.states[0]);
    } finally {
      await page.close();
    }
  });

  it('persists only the newest preview as typed columns without changing tomb/read heads', async () => {
    await storage.openForUser(userId);
    const preview = (seq: number, status: 'LIVE' | 'USER_RETRACTION') => ({
      seq,
      createdAt: '2026-01-01T00:00:00.000Z',
      sender: {
        account: 'peer',
        domain: 'local',
        namespaceId: 0,
        profileRev: 3,
      },
      status,
      text: status === 'LIVE' ? `message ${seq}` : undefined,
    });
    const first = threadFeedSnapshot(7, {
      profile: {
        account: 'peer',
        domain: 'local',
        namespaceId: 0,
        profileRev: 3,
      },
      threadFeedId: 1,
      messageEndSeq: 9,
      tombstoneEndSeq: 2,
      lastReadSeq: 5,
      unreadCount: 2,
      previews: [
        preview(9, 'USER_RETRACTION'),
        preview(7, 'LIVE'),
        preview(8, 'LIVE'),
      ],
    });
    const delivered = await storage.mergeThreadStates([first], 1);
    expect(delivered[0].previews).toHaveLength(3);
    const db = await storage.db();
    expect(await db.get('threads', 7)).toMatchObject({
      profileAccount: 'peer',
      profileDomain: 'local',
      profileNamespaceId: 0,
      threadProfileRev: 3,
    });
    expect(await db.get('threads', 7)).not.toHaveProperty('profileRev');
    expect(await db.get('threads', 7)).not.toHaveProperty('profile');
    expect(await db.get('threads', 7)).not.toHaveProperty('previews');
    expect(await db.getAll('threadPreviews')).toEqual([
      {
        threadId: 7,
        seq: 9,
        createdAt: '2026-01-01T00:00:00.000Z',
        senderAccount: 'peer',
        senderDomain: 'local',
        senderNamespaceId: 0,
        senderProfileRev: 3,
        status: 'USER_RETRACTION',
        text: null,
      },
    ]);
    await storage.advanceThreadRead(7, 8);
    expect((await storage.getThreadStates())[0]).toMatchObject({
      localReadSeq: 8,
      lastReadSeq: 5,
      tombstoneEndSeq: 2,
      previews: [{ seq: 9, status: 'USER_RETRACTION' }],
    });
    await storage.mergeThreadStates(
      [{ ...first, threadFeedId: 2, previews: [] }],
      2,
    );
    expect(await db.getAll('threadPreviews')).toEqual([]);
    expect((await storage.getThreadStates())[0]).toMatchObject({
      localReadSeq: 8,
      lastReadSeq: 5,
      tombstoneEndSeq: 2,
      previews: [],
    });
  });

  it('does not publish a partial page when a required preview array is absent', async () => {
    await storage.openForUser(userId);
    const snapshot = threadFeedSnapshot(7, {
      profile: {
        account: 'peer',
        domain: 'local',
        namespaceId: 0,
        profileRev: 0,
      },
    });
    await expect(
      storage.mergeThreadStates([{ ...snapshot, previews: undefined }], 1),
    ).rejects.toThrow(TypeError);
    expect(await (await storage.db()).get('threads', 7)).toBeUndefined();
    expect(await storage.getMeta('threadFeedCursor')).toBeUndefined();
    await expect(
      storage.mergeThreadStates(
        [
          {
            ...snapshot,
            previews: [
              {
                seq: 1,
                createdAt: '2026-01-01T00:00:00Z',
                sender: null,
                status: 'LIVE',
              },
            ],
          } as unknown as typeof snapshot,
        ],
        1,
      ),
    ).rejects.toThrow(TypeError);
    expect(await (await storage.db()).get('threads', 7)).toBeUndefined();
  });

  it('selects unresolved group profiles from the thread state alone', async () => {
    await storage.openForUser(userId);
    await storage.mergeThreadStates([
      threadFeedSnapshot(9, {
        type: 'GROUP',
        role: 'MEMBER',
        threadFeedId: 1,
        profile: {
          account: '!team',
          domain: 'local',
          namespaceId: 0,
          profileRev: 4,
        },
      }),
    ]);
    const db = await storage.db();
    expect(await db.get('threads', 9)).not.toHaveProperty('profileRev');
    expect(await storage.getUnresolvedGroupMetaProfiles()).toContainEqual({
      type: 'GROUP',
      threadId: 9,
      account: '!team',
      domain: 'local',
      namespaceId: 0,
      rev: 4,
    });
  });

  it('keeps the selected avatar revision only in the unified thread row', async () => {
    await storage.openForUser(userId);
    const db = await storage.db();
    expect(await storage.getThreads()).toEqual([]);
    await storage.mergeThreadStates([
      threadFeedSnapshot(7, {
        profile: {
          account: 'peer',
          domain: 'local',
          namespaceId: 0,
          profileRev: 4,
        },
      }),
    ]);
    expect((await storage.getThreads())[0].profileRev).toBe(4);
    expect(await db.get('threads', 7)).not.toHaveProperty('profileRev');
    await storage.putThread(
      createP2PConversation(
        7,
        { account: 'peer', name: 'Peer' },
        { profileRev: 99, threadFeedId: 1 },
      ),
    );
    expect((await storage.getThreads())[0].profileRev).toBe(4);
    expect(await db.get('threads', 7)).not.toHaveProperty('profileRev');
  });

  it('rejects presentation-only writes and atomically rejects a mixed replacement', async () => {
    await storage.openForUser(userId);
    const peer = createP2PConversation(7, { account: 'peer', name: 'Peer' });
    await expect(storage.putThread(peer)).rejects.toThrow(
      'matching feed state',
    );
    expect(await (await storage.db()).get('threads', 7)).toBeUndefined();
    await storage.mergeThreadStates([
      threadFeedSnapshot(7, {
        profile: {
          account: 'peer',
          domain: 'local',
          namespaceId: 0,
          profileRev: 2,
        },
      }),
    ]);
    const before = await (await storage.db()).get('threads', 7);
    await expect(
      storage.replaceThreads([
        { ...peer, threadFeedId: 1 },
        createP2PConversation(8, { account: 'other', name: 'Other' }),
      ]),
    ).rejects.toThrow('matching feed state');
    expect(await (await storage.db()).get('threads', 7)).toEqual(before);
    expect(await (await storage.db()).get('threads', 8)).toBeUndefined();
  });

  it('rolls back a page that changes an established thread identity', async () => {
    await storage.openForUser(userId);
    await storage.mergeThreadStates(
      [
        threadFeedSnapshot(7, {
          profile: {
            account: 'peer',
            domain: 'local',
            namespaceId: 0,
            profileRev: 1,
          },
        }),
      ],
      1,
    );
    const db = await storage.db();
    const previous = await db.get('threads', 7);
    await expect(
      storage.mergeThreadStates(
        [
          threadFeedSnapshot(8, {
            threadFeedId: 2,
            profile: {
              account: 'other',
              domain: 'local',
              namespaceId: 0,
              profileRev: 0,
            },
          }),
          threadFeedSnapshot(7, {
            threadFeedId: 3,
            profile: {
              account: 'impostor',
              domain: 'local',
              namespaceId: 0,
              profileRev: 2,
            },
          }),
        ],
        3,
      ),
    ).rejects.toThrow('conversation identity');
    expect(await db.get('threads', 7)).toEqual(previous);
    expect(await db.get('threads', 8)).toBeUndefined();
    expect(await storage.getMeta('threadFeedCursor')).toBe(1);
  });

  it('deletes the unified state and its preview and roster together', async () => {
    await storage.openForUser(userId);
    await storage.mergeThreadStates(
      [
        threadFeedSnapshot(7, {
          type: 'GROUP',
          role: 'MEMBER',
          profile: {
            account: '!room',
            domain: 'local',
            namespaceId: 0,
            profileRev: 1,
          },
          messageEndSeq: 1,
          previews: [
            {
              seq: 1,
              createdAt: '2026-01-01T00:00:00Z',
              sender: {
                account: 'peer',
                domain: 'local',
                namespaceId: 0,
                profileRev: 1,
              },
              status: 'LIVE',
              text: 'hello',
            },
          ],
        }),
      ],
      1,
    );
    const db = await storage.db();
    await db.put('members', {
      threadId: 7,
      account: 'peer',
      domain: 'local',
      namespaceId: 0,
      profileRev: 1,
      role: 'MEMBER',
      left: false,
    });
    await storage.deleteThread(7);
    expect(await db.get('threads', 7)).toBeUndefined();
    expect(await db.get('threadPreviews', 7)).toBeUndefined();
    expect(await db.getAllFromIndex('members', 'thread', 7)).toEqual([]);
    expect(await storage.getThreadStates()).toEqual([]);
  });

  it('stores only typed, flat peer fields rather than a nested subject', async () => {
    await storage.openForUser(userId);
    await storage.mergeThreadStates([
      threadFeedSnapshot(7, {
        profile: {
          account: 'peer',
          domain: 'local',
          namespaceId: 0,
          profileRev: 0,
        },
      }),
    ]);
    const thread = createP2PConversation(
      7,
      { account: 'peer', name: 'Peer' },
      { threadFeedId: 1 },
    );
    await storage.putThread(thread);
    const restored = (await storage.getThreads())[0];
    expect(restored.type).toBe('P2P');
    if (restored.type === 'P2P') expect(restored.peerUser.account).toBe('peer');
    const persisted = await (await storage.db()).get('threads', 7);
    expect(persisted).toMatchObject({
      type: 'P2P',
      profileAccount: 'peer',
      subjectName: 'Peer',
    });
    expect(persisted).not.toHaveProperty('peerUser');
    expect(persisted).not.toHaveProperty('group');
  });

  it('restores aliases from feed state after structural writes, stale replay and reopening', async () => {
    await storage.openForUser(userId);
    const state = {
      ...threadStructure(7, {
        profile: {
          account: 'peer',
          domain: 'local',
          namespaceId: 0,
          profileRev: 0,
        },
      }),
      threadId: 7,
      threadFeedId: 1,
      threadProfileRev: 0,
      alias: 'Private',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      groupMetaFeedEndId: null,
      joinRequestEndFeedId: 0,
      joinRequestReadFeedId: -1,
      groupInviteEndFeedId: 0,
      announcementReadFeedId: 0,
      lastReadSeq: 0,
      unreadCount: 0,
      lastMentionSeq: null,
      previews: [],
    };
    await storage.mergeThreadStates([state], 1);
    await storage.putThread(
      createP2PConversation(
        7,
        { account: 'peer', name: 'Profile' },
        { alias: 'Stale structure' },
      ),
    );
    expect((await storage.getThreads())[0].alias).toBe('Private');
    expect(await (await storage.db()).get('threads', 7)).toHaveProperty(
      'alias',
      'Private',
    );
    await storage.close();
    await storage.openExistingForUser(userId);
    expect((await storage.getThreads())[0].alias).toBe('Private');
    await storage.mergeThreadStates(
      [{ ...state, threadFeedId: 2, alias: null }],
      2,
    );
    await storage.mergeThreadStates([state], 1);
    expect((await storage.getThreads())[0].alias).toBeNull();
  });

  it('does not create a missing account cache on the background existing-only path', async () => {
    await expect(storage.openExistingForUser(userId)).rejects.toThrow();
    expect(
      (await indexedDB.databases()).some((db) => db.name?.endsWith(userId)),
    ).toBe(false);
  });

  it('serializes cursor consumption across two account database owners', async () => {
    await storage.openForUser(userId);
    const background = new WebdbStorage();
    await background.openExistingForUser(userId);
    const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
    let tail: Promise<unknown> = Promise.resolve();
    const lock = vi.fn((_name: string, run: () => Promise<unknown>) => {
      const work = tail.then(run);
      tail = work.catch(() => {});
      return work;
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: lock },
    });
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [],
        scannedThrough: 1,
        through: 1,
        threadFeedEndId: 1,
        hasMore: false,
      },
    });
    try {
      await Promise.all([
        syncThreadFeed(storage, 1, request, groupMetaRequest, profileResolver),
        syncThreadFeed(
          background,
          1,
          request,
          groupMetaRequest,
          profileResolver,
        ),
      ]);
      expect(request).toHaveBeenCalledOnce();
      expect(lock.mock.calls.map((call) => call[0])).toEqual([
        'soms-thread-feed-' + userId,
        'soms-thread-feed-' + userId,
      ]);
    } finally {
      if (previous) Object.defineProperty(navigator, 'locks', previous);
      else Reflect.deleteProperty(navigator, 'locks');
      await background.close();
    }
  });

  it('retains the existing session invalidation gate', async () => {
    const lifetime = new SessionLifecycleService();
    storage = new WebdbStorage(() => null, lifetime);
    await storage.openForUser(userId);
    lifetime.invalidateSession();
    await expect(storage.getThreadStates()).rejects.toThrow();
    storage.dispose();
  });

  it('closes the background handle when another context deletes the cache and rejects a late response', async () => {
    await storage.openForUser(userId);
    const background = new WebdbStorage();
    await background.openExistingForUser(userId);
    let respond!: (value: unknown) => void;
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sync = syncThreadFeed(
      background,
      1,
      () => {
        started();
        return new Promise((resolve) => {
          respond = resolve;
        });
      },
      groupMetaRequest,
      profileResolver,
    );
    await requested;
    await storage.closeAndDelete(userId);
    expect(background.ready()).toBe(false);
    respond({
      code: 0,
      data: {
        items: [],
        scannedThrough: 1,
        through: 1,
        threadFeedEndId: 1,
        hasMore: false,
      },
    });
    expect(await sync).toMatchObject({
      cursor: 0,
      states: [],
      error: expect.any(String),
    });
    expect(
      (await indexedDB.databases()).some((db) => db.name?.endsWith(userId)),
    ).toBe(false);
    await background.close();
  });
});

describe('profile-namespace change feed consumption', () => {
  const userId = '9107';
  let storage: WebdbStorage;

  beforeEach(() => {
    storage = new WebdbStorage();
  });
  afterEach(async () => {
    await storage.closeAndDelete(userId);
  });

  it('expires cached rows and plants tombs for uncached pairs', async () => {
    await storage.openForUser(userId);
    await storage.commitProfileNamespaceBindings(
      [
        {
          publisherNamespaceId: 12,
          profileNamespaceId: 0,
          domain: 'peer.test',
          rootPublicKey: 'r'.repeat(44),
          updateFeedId: 4,
        },
      ],
      0,
    );
    const touched = await storage.applyProfileNamespaceChanges([
      { publisherNamespaceId: 12, profileNamespaceId: 0, changeId: 7 },
      { publisherNamespaceId: 15, profileNamespaceId: 3, changeId: 8 },
    ]);
    expect(touched).toEqual([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
      { publisherNamespaceId: 15, profileNamespaceId: 3 },
    ]);
    const rows = await storage.getProfileNamespaceBindings([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
      { publisherNamespaceId: 15, profileNamespaceId: 3 },
    ]);
    expect(rows[0]).toMatchObject({
      domain: 'peer.test',
      expired: true,
      changeSeq: 7,
      updateFeedId: 4,
    });
    // Feed pulled, cache not: the pair is a visible tomb.
    expect(rows[1]).toMatchObject({
      domain: null,
      rootPublicKey: null,
      expired: true,
      changeSeq: 8,
    });
  });

  it('skips stale-replay items and keeps newer-round expiries authoritative', async () => {
    await storage.openForUser(userId);
    await storage.applyProfileNamespaceChanges([
      { publisherNamespaceId: 12, profileNamespaceId: 0, changeId: 9 },
    ]);
    // A replayed older change is a no-op.
    const replay = await storage.applyProfileNamespaceChanges([
      { publisherNamespaceId: 12, profileNamespaceId: 0, changeId: 7 },
    ]);
    expect(replay).toEqual([]);
    // A resolve answer from a round that ended before the expiry cannot
    // resurrect the row.
    await storage.commitProfileNamespaceBindings(
      [
        {
          publisherNamespaceId: 12,
          profileNamespaceId: 0,
          domain: 'stale.test',
          rootPublicKey: 's'.repeat(44),
          updateFeedId: 99,
        },
      ],
      8,
    );
    const [stale] = await storage.getProfileNamespaceBindings([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
    ]);
    expect(stale).toMatchObject({ expired: true, changeSeq: 9 });
    // An answer from the converged round clears the tomb and pins the
    // round's coordinate.
    await storage.commitProfileNamespaceBindings(
      [
        {
          publisherNamespaceId: 12,
          profileNamespaceId: 0,
          domain: 'fresh.test',
          rootPublicKey: 'f'.repeat(44),
          updateFeedId: 10,
        },
      ],
      9,
    );
    const [fresh] = await storage.getProfileNamespaceBindings([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
    ]);
    expect(fresh).toMatchObject({
      domain: 'fresh.test',
      expired: false,
      changeSeq: 9,
    });
  });

  it('drains the change feed, resolves touched pairs, and advances the cursor', async () => {
    await storage.openForUser(userId);
    const pages = [
      {
        code: 0,
        data: {
          items: [
            { publisherNamespaceId: 12, profileNamespaceId: 0, changeId: 1 },
            { publisherNamespaceId: 15, profileNamespaceId: 2, changeId: 2 },
          ],
          scannedThrough: 2,
          endId: 5,
          hasMore: true,
        },
      },
      {
        code: 0,
        data: {
          items: [
            { publisherNamespaceId: 16, profileNamespaceId: 0, changeId: 5 },
          ],
          scannedThrough: 5,
          endId: 5,
          hasMore: false,
        },
      },
    ];
    const resolveBodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/user/profile-namespace-feed')) {
        return {
          ok: true,
          status: 200,
          json: async () => pages.shift(),
        } as unknown as Response;
      }
      resolveBodies.push(JSON.parse(String(init?.body)));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            entries: [
              {
                publisherNamespaceId: 12,
                profileNamespaceId: 0,
                domain: 'peer.test',
                rootPublicKey: 'r'.repeat(44),
                updateFeedId: 4,
                expired: false,
              },
            ],
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await storage.pullProfileNamespaceChanges(5);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 2 feed pages + 2 resolve rounds
    expect(resolveBodies).toEqual([
      {
        pairs: [
          { publisherNamespaceId: 12, profileNamespaceId: 0 },
          { publisherNamespaceId: 15, profileNamespaceId: 2 },
        ],
      },
      { pairs: [{ publisherNamespaceId: 16, profileNamespaceId: 0 }] },
    ]);
    const [converged] = await storage.getProfileNamespaceBindings([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
    ]);
    expect(converged).toMatchObject({ domain: 'peer.test', expired: false });
    // The skip fast path: an anchor equal to the persisted cursor makes no
    // network call at all.
    const calls = fetchMock.mock.calls.length;
    await storage.pullProfileNamespaceChanges(5);
    expect(fetchMock.mock.calls.length).toBe(calls);
    vi.unstubAllGlobals();
  });
});

describe('profile-namespace pull single-flight', () => {
  const userId = '9107';
  let storage: WebdbStorage;

  beforeEach(() => {
    storage = new WebdbStorage();
  });
  afterEach(async () => {
    await storage.closeAndDelete(userId);
  });

  it('joins concurrent triggers onto one drain and runs one trailing round with the newest anchor', async () => {
    await storage.openForUser(userId);
    const feedUrls: string[] = [];
    let releaseFirst: (value: unknown) => void = () => undefined;
    const firstFeed = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const pages = [
      {
        code: 0,
        data: {
          items: [
            { publisherNamespaceId: 12, profileNamespaceId: 0, changeId: 1 },
          ],
          scannedThrough: 1,
          endId: 1,
          hasMore: false,
        },
      },
      {
        code: 0,
        data: {
          items: [],
          scannedThrough: 2,
          endId: 2,
          hasMore: false,
        },
      },
    ];
    let feedCalls = 0;
    const resolveCalls = { count: 0 };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/user/profile-namespace-feed')) {
        feedUrls.push(url);
        feedCalls += 1;
        if (feedCalls === 1) {
          await firstFeed;
          return {
            ok: true,
            status: 200,
            json: async () => pages[0],
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => pages[feedCalls - 1],
        } as unknown as Response;
      }
      resolveCalls.count += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            entries: [
              {
                publisherNamespaceId: 12,
                profileNamespaceId: 0,
                domain: 'peer.test',
                rootPublicKey: 'r'.repeat(44),
                updateFeedId: 4,
                expired: false,
              },
            ],
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = storage.pullProfileNamespaceChanges(1);
    await vi.waitFor(() => expect(feedCalls).toBe(1));
    // A wake lands mid-drain: it must join the in-flight round, not start
    // a parallel drain, and its newer anchor must still be observed.
    const joined = storage.pullProfileNamespaceChanges(2);
    releaseFirst(undefined);
    await Promise.all([first, joined]);

    // Round 1 drained page 1; the trailing round observed anchor 2 via one
    // more feed fetch; the join never duplicated the drain.
    expect(feedCalls).toBe(2);
    expect(feedUrls[1]).toContain('after=1');
    expect(resolveCalls.count).toBe(1);
    // The cursor ended at 2: the fast path now skips with anchor 2.
    const before = fetchMock.mock.calls.length;
    await storage.pullProfileNamespaceChanges(2);
    expect(fetchMock.mock.calls.length).toBe(before);
    vi.unstubAllGlobals();
  });
});
