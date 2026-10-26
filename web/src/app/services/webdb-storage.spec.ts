import 'fake-indexeddb/auto';
import { WebdbStorage } from './webdb-storage';
import type { ProfileNamespacePairKey } from './webdb-storage';
import { WebdbService } from './webdb.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { syncThreadFeed } from './thread-feed-sync';
import { threadFeedSnapshot, threadStructure } from './thread-feed.test-helper';
import { prepareTestSessionCache as prepareSession } from './session/session-cache.test-helper';
import type { SessionCacheDescriptor } from './session/session-identity';

describe('shared background storage', () => {
  const userId = '9107';
  let storage: WebdbStorage;
  let session: SessionCacheDescriptor;

  beforeEach(async () => {
    storage = new WebdbStorage(() => null, new SessionLifecycleService());
    session = await prepareSession();
    storage.bindSessionCache(session);
  });
  afterEach(async () => {
    await storage.closeAndDelete(userId);
  });

  it('runs feed synchronization without an Angular injector or a nested worker', async () => {
    await storage.openForUser(userId);
    const result = await syncThreadFeed(storage, 1, async () => ({
      code: 0,
      data: {
        items: [
          threadFeedSnapshot(7, {
            profileAccount: 'peer',
            publisherNamespaceId: 0,
            profileRev: 0,
            messageEndSeq: 2,
            unreadCount: 2,
          }),
        ],
        scannedThrough: 1,
        through: 1,
        threadFeedEndId: 1,
        hasMore: false,
      },
    }));
    expect(result.cursor).toBe(1);
    expect(
      result.states[0].threadFeedId === null
        ? undefined
        : result.states[0].unreadCount,
    ).toBe(2);
    await storage.close();
    const page = new WebdbStorage(() => null, new SessionLifecycleService());
    page.bindSessionCache(session);
    try {
      await page.openExistingForUser(userId);
      expect((await page.readAccountState()).threadFeedCursor).toBe(1);
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
        profileNamespaceId: 0,
        profileRev: 3,
      },
      status,
      text: status === 'LIVE' ? `message ${seq}` : undefined,
    });
    const first = threadFeedSnapshot(7, {
      profileAccount: 'peer',
      publisherNamespaceId: 0,
      profileRev: 3,
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
      publisherNamespaceId: 0,
      profileRev: 3,
    });
    expect(await db.get('threads', 7)).not.toHaveProperty('threadProfileRev');
    expect(await db.get('threads', 7)).not.toHaveProperty('profile');
    expect(await db.get('threads', 7)).not.toHaveProperty('previews');
    expect(await db.getAll('threadPreviews')).toEqual([
      {
        threadId: 7,
        seq: 9,
        createdAt: '2026-01-01T00:00:00.000Z',
        senderAccount: 'peer',
        senderProfileNamespaceId: 0,
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
      profileAccount: 'peer',
      publisherNamespaceId: 0,
      profileRev: 0,
    });
    await expect(
      storage.mergeThreadStates([{ ...snapshot, previews: undefined }], 1),
    ).rejects.toThrow(TypeError);
    expect(await (await storage.db()).get('threads', 7)).toBeUndefined();
    expect((await storage.readAccountState()).threadFeedCursor).toBeNull();
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
        profileAccount: '!team',
        publisherNamespaceId: 0,
        profileRev: 4,
      }),
    ]);
    const db = await storage.db();
    expect(await db.get('threads', 9)).not.toHaveProperty('threadProfileRev');
    expect(await storage.getUnresolvedGroupMetaProfiles()).toContainEqual({
      type: 'GROUP',
      threadId: 9,
      account: '!team',
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
        profileAccount: 'peer',
        publisherNamespaceId: 0,
        profileRev: 4,
      }),
    ]);
    expect((await storage.getThreads())[0].profileRev).toBe(4);
    expect(await db.get('threads', 7)).not.toHaveProperty('threadProfileRev');
    await storage.patchThread(7, { pinned: true, pinnedAt: 100 });
    expect((await storage.getThreads())[0].profileRev).toBe(4);
    expect(await db.get('threads', 7)).not.toHaveProperty('threadProfileRev');
  });

  it('rejects local patches without feed state and leaves other threads unchanged', async () => {
    await storage.openForUser(userId);
    await expect(storage.patchThread(7, { muted: true })).rejects.toThrow(
      'cannot patch thread before feed state exists',
    );
    expect(await (await storage.db()).get('threads', 7)).toBeUndefined();
    await storage.mergeThreadStates([
      threadFeedSnapshot(7, {
        profileAccount: 'peer',
        publisherNamespaceId: 0,
        profileRev: 2,
      }),
    ]);
    const before = await (await storage.db()).get('threads', 7);
    await expect(storage.patchThread(8, { muted: true })).rejects.toThrow(
      'cannot patch thread before feed state exists',
    );
    expect(await (await storage.db()).get('threads', 7)).toEqual(before);
    expect(await (await storage.db()).get('threads', 8)).toBeUndefined();
  });

  it('rolls back a page that changes an established thread identity', async () => {
    await storage.openForUser(userId);
    await storage.mergeThreadStates(
      [
        threadFeedSnapshot(7, {
          profileAccount: 'peer',
          publisherNamespaceId: 0,
          profileRev: 1,
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
            profileAccount: 'other',
            publisherNamespaceId: 0,
            profileRev: 0,
          }),
          threadFeedSnapshot(7, {
            threadFeedId: 3,
            profileAccount: 'impostor',
            publisherNamespaceId: 0,
            profileRev: 2,
          }),
        ],
        3,
      ),
    ).rejects.toThrow('conversation identity');
    expect(await db.get('threads', 7)).toEqual(previous);
    expect(await db.get('threads', 8)).toBeUndefined();
    expect((await storage.readAccountState()).threadFeedCursor).toBe(1);
  });

  it('deletes the unified state and its preview and roster together', async () => {
    await storage.openForUser(userId);
    await storage.mergeThreadStates(
      [
        threadFeedSnapshot(7, {
          type: 'GROUP',
          role: 'MEMBER',
          profileAccount: '!room',
          publisherNamespaceId: 0,
          profileRev: 1,
          messageEndSeq: 1,
          previews: [
            {
              seq: 1,
              createdAt: '2026-01-01T00:00:00Z',
              sender: {
                account: 'peer',
                profileNamespaceId: 0,
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
        profileAccount: 'peer',
        publisherNamespaceId: 0,
        profileRev: 0,
      }),
    ]);
    const restored = (await storage.getThreads())[0];
    expect(restored.type).toBe('P2P');
    if (restored.type === 'P2P') expect(restored.account).toBe('peer');
    const persisted = await (await storage.db()).get('threads', 7);
    expect(persisted).toMatchObject({
      type: 'P2P',
      profileAccount: 'peer',
    });
    for (const field of ['subjectName', 'subjectAvatar', 'subjectBio'])
      expect(persisted).not.toHaveProperty(field);
    expect(persisted).not.toHaveProperty('peerUser');
    expect(persisted).not.toHaveProperty('group');
  });

  it('materializes only the exact selected home profile without storing display copies in threads', async () => {
    await storage.openForUser(userId);
    await storage.mergeThreadStates([
      threadFeedSnapshot(7, {
        profileAccount: 'peer',
        publisherNamespaceId: 7,
        profileRev: 2,
      }),
    ]);
    const db = await storage.db();
    const original = await db.get('threads', 7);
    for (const profile of [
      { profileNamespaceId: 7, rev: 2, name: 'Wrong namespace' },
      { profileNamespaceId: 0, rev: 3, name: 'Newer revision' },
      { profileNamespaceId: 0, rev: 2, name: 'Selected peer' },
    ]) {
      await storage.commitResolvedProfile({
        publisherNamespaceId: 7,
        account: 'peer',
        bio: 'Exact bio',
        avatarBase64: null,
        ...profile,
      });
    }
    expect(await db.get('threads', 7)).toEqual(original);
    expect((await storage.getThreads())[0].profile).toMatchObject({
      name: 'Selected peer',
      bio: 'Exact bio',
    });
    await storage.patchThread(7, { muted: true });
    expect((await storage.getThreads())[0].profile.name).toBe('Selected peer');
    await storage.close();
    await storage.openForUser(userId);
    expect((await storage.getThreads())[0].profile.name).toBe('Selected peer');
  });

  it('preserves feed aliases across local patches, stale replay and reopening', async () => {
    await storage.openForUser(userId);
    const state = {
      ...threadStructure(7, {
        profileAccount: 'peer',
        publisherNamespaceId: 0,
        profileRev: 0,
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
    await storage.patchThread(7, { muted: true });
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
    const background = new WebdbStorage(
      () => null,
      new SessionLifecycleService(),
    );
    background.bindSessionCache(session);
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
        syncThreadFeed(storage, 1, request),
        syncThreadFeed(background, 1, request),
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
    storage.bindSessionCache(session);
    await storage.openForUser(userId);
    lifetime.invalidateSession();
    await expect(storage.getThreadStates()).rejects.toThrow();
    storage.dispose();
  });

  it('closes the background handle when another context deletes the cache and rejects a late response', async () => {
    await storage.openForUser(userId);
    const background = new WebdbStorage(
      () => null,
      new SessionLifecycleService(),
    );
    background.bindSessionCache(session);
    await background.openExistingForUser(userId);
    let respond!: (value: unknown) => void;
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sync = syncThreadFeed(background, 1, () => {
      started();
      return new Promise((resolve) => {
        respond = resolve;
      });
    });
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
  let session: SessionCacheDescriptor;

  beforeEach(async () => {
    storage = new WebdbStorage(() => null, new SessionLifecycleService());
    session = await prepareSession();
    storage.bindSessionCache(session);
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
          status: 'ACTIVE',
          expired: false,
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
      status: 'ACTIVE',
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
          status: 'ACTIVE',
          expired: false,
        },
      ],
      8,
    );
    const [stale] = await storage.getProfileNamespaceBindings([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
    ]);
    // The changeSeq guard dropped the older round's answer — not the flag:
    // the tomb is untouched (the answer carried domain 'stale.test').
    expect(stale).toMatchObject({ domain: null, expired: true, changeSeq: 9 });
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
          status: 'ACTIVE',
          expired: false,
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

  it('stores a stale-window answer as-is: data kept, expired preserved, coordinates pinned', async () => {
    await storage.openForUser(userId);
    await storage.commitProfileNamespaceBindings(
      [
        {
          publisherNamespaceId: 12,
          profileNamespaceId: 0,
          domain: 'old.test',
          rootPublicKey: 'o'.repeat(44),
          updateFeedId: 3,
          status: 'ACTIVE',
          expired: false,
        },
      ],
      5,
    );
    // The server is mid-refresh and answers with the stale cached value.
    await storage.commitProfileNamespaceBindings(
      [
        {
          publisherNamespaceId: 12,
          profileNamespaceId: 0,
          domain: 'stale-kept.test',
          rootPublicKey: 's'.repeat(44),
          updateFeedId: 3,
          status: 'ACTIVE',
          expired: true,
        },
      ],
      5,
    );
    const [stale] = await storage.getProfileNamespaceBindings([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
    ]);
    expect(stale).toMatchObject({
      domain: 'stale-kept.test',
      expired: true,
      changeSeq: 5,
      updateFeedId: 3,
      status: 'ACTIVE',
    });
    // A converged answer at the same round clears the flag.
    await storage.commitProfileNamespaceBindings(
      [
        {
          publisherNamespaceId: 12,
          profileNamespaceId: 0,
          domain: 'fresh.test',
          rootPublicKey: 'f'.repeat(44),
          updateFeedId: 6,
          status: 'ACTIVE',
          expired: false,
        },
      ],
      5,
    );
    const [fresh] = await storage.getProfileNamespaceBindings([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
    ]);
    expect(fresh).toMatchObject({
      domain: 'fresh.test',
      expired: false,
      updateFeedId: 6,
      status: 'ACTIVE',
    });
  });

  it('commits the cursor before wake and never waits for optional namespace resolution', async () => {
    await storage.openForUser(userId);
    const wakes: Array<
      Array<{ publisherNamespaceId: number; profileNamespaceId: number }>
    > = [];
    storage.profileNamespaceWake$.subscribe((pairs) => wakes.push(pairs));
    const page = {
      code: 0,
      data: {
        items: [
          { publisherNamespaceId: 12, profileNamespaceId: 0, changeId: 3 },
        ],
        scannedThrough: 3,
        endId: 3,
        hasMore: false,
      },
    };
    let resolveOk = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/user/profile-namespace-feed')) {
        return {
          ok: true,
          status: 200,
          json: async () => page,
        } as unknown as Response;
      }
      if (!resolveOk) return { ok: false, status: 503 } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            status: 'READY',
            entry: {
              publisherNamespaceId: 12,
              profileNamespaceId: 0,
              domain: 'peer.test',
              rootPublicKey: 'r'.repeat(44),
              updateFeedId: 4,
              status: 'ACTIVE',
              expired: false,
            },
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const cursorAtWake: unknown[] = [];
    storage.profileNamespaceWake$.subscribe(() => {
      cursorAtWake.push(
        storage
          .readAccountState()
          .then((state) => state.profileNamespaceChangeEndId),
      );
    });
    await storage.pullProfileNamespaceChanges();
    expect(await Promise.all(cursorAtWake)).toEqual([3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Optional resolver errors cannot prevent fact progress.
    expect(wakes).toEqual([
      [{ publisherNamespaceId: 12, profileNamespaceId: 0 }],
    ]);
    // The retry re-applies the same page: the stale-replay guard empties
    // `touched`, so no duplicate wake① and no resolve round — the tomb
    // converges on the next demand or change instead.
    resolveOk = true;
    await storage.pullProfileNamespaceChanges();
    expect(wakes).toEqual([
      [{ publisherNamespaceId: 12, profileNamespaceId: 0 }],
    ]);
    const [row] = await storage.getProfileNamespaceBindings([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
    ]);
    expect(row).toMatchObject({ domain: null, expired: true, changeSeq: 3 });
    // The cursor advanced: the anchor fast path now skips.
    const calls = fetchMock.mock.calls.length;
    await storage.pullProfileNamespaceChanges(3);
    expect(fetchMock.mock.calls.length).toBe(calls);
    vi.unstubAllGlobals();
  });

  it('drains the change feed without resolving touched pairs and advances the cursor', async () => {
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
      const body = JSON.parse(String(init?.body)) as ProfileNamespacePairKey;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            status: 'READY',
            entry: {
              publisherNamespaceId: body.publisherNamespaceId,
              profileNamespaceId: body.profileNamespaceId,
              domain: `${body.publisherNamespaceId}-${body.profileNamespaceId}.test`,
              rootPublicKey: 'r'.repeat(44),
              updateFeedId: 4,
              status: 'ACTIVE',
              expired: false,
            },
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const wakes: Array<
      Array<{ publisherNamespaceId: number; profileNamespaceId: number }>
    > = [];
    storage.profileNamespaceWake$.subscribe((pairs) => wakes.push(pairs));

    await storage.pullProfileNamespaceChanges(5);
    expect(fetchMock).toHaveBeenCalledTimes(2); // feed pages only
    // One wake per page, after expiry and cursor commit.
    expect(wakes).toEqual([
      [
        { publisherNamespaceId: 12, profileNamespaceId: 0 },
        { publisherNamespaceId: 15, profileNamespaceId: 2 },
      ],
      [{ publisherNamespaceId: 16, profileNamespaceId: 0 }],
    ]);
    expect(resolveBodies).toEqual([]);
    const [converged] = await storage.getProfileNamespaceBindings([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
    ]);
    expect(converged).toMatchObject({ domain: null, expired: true });
    // The skip fast path: an anchor equal to the persisted cursor makes no
    // network call at all.
    const calls = fetchMock.mock.calls.length;
    await storage.pullProfileNamespaceChanges(5);
    expect(fetchMock.mock.calls.length).toBe(calls);
    vi.unstubAllGlobals();
  });

  it('finishes fact drain while wake-triggered optional resolution is stalled', async () => {
    await storage.openForUser(userId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            items: [
              { publisherNamespaceId: 12, profileNamespaceId: 0, changeId: 3 },
            ],
            scannedThrough: 3,
            endId: 3,
            hasMore: false,
          },
        }),
      })),
    );
    const resolve = vi
      .spyOn(storage, 'resolveProfileNamespacePairs')
      .mockImplementation(() => new Promise(() => {}));
    const subscription = storage.profileNamespaceWake$.subscribe((pairs) => {
      void storage.resolveProfileNamespacePairs(pairs, 3);
    });
    try {
      await storage.pullProfileNamespaceChanges();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(
        (await storage.readAccountState()).profileNamespaceChangeEndId,
      ).toBe(3);
    } finally {
      subscription.unsubscribe();
      resolve.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each([0, 50032])(
    'rejects old-account namespace answers before binding/tomb commit (code %s)',
    async (code) => {
      await storage.openForUser(userId);
      let release!: (response: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              release = resolve;
            }),
        ),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pair = { publisherNamespaceId: 12, profileNamespaceId: 0 };
      const otherUser = `${userId}-other`;
      try {
        const resolution = storage.resolveProfileNamespacePairs([pair], 3);
        await storage.closeAndDelete(userId);
        // An account switch on one handle arrives with its own login-session cache.
        storage.bindSessionCache(await prepareSession());
        await storage.openForUser(otherUser);
        release({
          ok: true,
          json: async () => ({
            code,
            data: {
              status: 'READY',
              entry: {
                ...pair,
                domain: 'old-account.test',
                rootPublicKey: null,
                updateFeedId: 4,
                expired: false,
                status: 'ACTIVE',
              },
            },
          }),
        } as Response);
        expect((await resolution).failed).toEqual([pair]);
        const db = await storage.db();
        expect(await db.get('profileNamespaces', [12, 0])).toBeUndefined();
        expect(await db.get('profileNamespaceTombs', [12, 0])).toBeUndefined();
      } finally {
        await storage.closeAndDelete(otherUser);
        // Restore the describe-level binding so afterEach cleanup stays user-matched.
        storage.bindSessionCache(session);
        warn.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );

  it('writes a namespace tomb on FEDERATION_NAMESPACE_UNRECOVERABLE and does not mark pending', async () => {
    await storage.openForUser(userId);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/user/profile-namespace-feed')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              items: [
                {
                  publisherNamespaceId: 42,
                  profileNamespaceId: 7,
                  changeId: 1,
                },
              ],
              scannedThrough: 1,
              endId: 1,
              hasMore: false,
            },
          }),
        } as unknown as Response;
      }
      // resolve answers UNRECOVERABLE (50032)
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 50032, data: null }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await storage.pullProfileNamespaceChanges();
    const result = await storage.resolveProfileNamespacePairs(
      [{ publisherNamespaceId: 42, profileNamespaceId: 7 }],
      1,
    );
    expect(result.unrecoverable).toEqual([
      { publisherNamespaceId: 42, profileNamespaceId: 7 },
    ]);
    expect(result.pending).toEqual([]);

    // A tomb row is persisted in the dedicated store.
    const db = await (
      storage as unknown as {
        db: () => Promise<IDBDatabase>;
      }
    ).db();
    const tx = db.transaction(
      ['profileNamespaceTombs', 'profileNamespaces'],
      'readonly',
    );
    const tomb = await tx.objectStore('profileNamespaceTombs').get([42, 7]);
    expect(tomb).toMatchObject({
      publisherNamespaceId: 42,
      profileNamespaceId: 7,
    });
    // No READY binding was committed — only the expiry tomb from
    // applyProfileNamespaceChanges remains (domain null, expired true).
    const binding = await tx.objectStore('profileNamespaces').get([42, 7]);
    expect(binding).toMatchObject({
      publisherNamespaceId: 42,
      profileNamespaceId: 7,
      domain: null,
      expired: true,
    });
    vi.unstubAllGlobals();
  });
});

describe('profile-namespace pull single-flight', () => {
  const userId = '9107';
  let storage: WebdbStorage;
  let session: SessionCacheDescriptor;

  beforeEach(async () => {
    storage = new WebdbStorage(() => null, new SessionLifecycleService());
    session = await prepareSession();
    storage.bindSessionCache(session);
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
            status: 'READY',
            entry: {
              publisherNamespaceId: 12,
              profileNamespaceId: 0,
              domain: 'peer.test',
              rootPublicKey: 'r'.repeat(44),
              updateFeedId: 4,
              status: 'ACTIVE',
              expired: false,
            },
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
    expect(resolveCalls.count).toBe(0);
    // The cursor ended at 2: the fast path now skips with anchor 2.
    const before = fetchMock.mock.calls.length;
    await storage.pullProfileNamespaceChanges(2);
    expect(fetchMock.mock.calls.length).toBe(before);
    vi.unstubAllGlobals();
  });
});
