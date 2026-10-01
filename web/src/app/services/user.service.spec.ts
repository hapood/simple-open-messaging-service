import type { Mock } from 'vitest';
import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import {
  HttpClient,
  provideHttpClient,
  HttpRequest,
  withXhr,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { firstValueFrom, of } from 'rxjs';
import { CACHE_REBUILD_RELOAD, UserService } from './user.service';
import { LocalCacheVersionMismatchError, WebdbService } from './webdb.service';
import { ProfileRepository } from './profile-store.service';
import { User } from './model';
import { PreferenceStore } from './preference-store.service';
import { SessionLifecycleService } from './session-lifecycle.service';

/** Match the POST /user/my-profile request regardless of the runtime apiOrigin (empty same-origin in
 *  the browser, absolute under Tauri). */
const isMyProfile = (req: HttpRequest<unknown>): boolean =>
  req.method === 'POST' && req.url.endsWith('/user/my-profile');
/** A minimal my-profile response body; `over` overrides fields under test. */
const profile = (
  over: Partial<User>,
): {
  code: number;
  data: User;
} => ({
  code: 0,
  data: {
    id: 1,
    name: 'A',
    avatar: '',
    bio: '',
    domain: 'local',
    account: 'alice',
    namespaceId: 0,
    profileRev: 1,
    ...over,
  } as User,
});

describe('UserService.localRelationship', () => {
  it('matches transient federated users by exact Address across request pages', async () => {
    const service = Object.create(UserService.prototype) as UserService;
    const listLocalFriendRequests = vi.fn(
      async (direction: string, cursor: string | null) => {
        const item = (account: string) => ({
          kind: 'FRIEND',
          status: 'REQUESTED',
          expiresAt: Date.now() + 60_000,
          peer: { id: 0, account, domain: 'bravo.test' },
        });
        const items =
          direction === 'OUTGOING'
            ? cursor
              ? [item('bob')]
              : [item('someone-else')]
            : [];
        return {
          items,
          scannedThrough: cursor ?? 'next-page',
          hasMore: direction === 'OUTGOING' && cursor === null,
          total: 2,
          actionableTotal: 2,
        };
      },
    );
    Object.assign(service, {
      webdb: {
        getThreads: async () => [
          {
            type: 'P2P',
            friendshipActive: true,
            peerUser: { id: 0, account: 'someone-else', domain: 'bravo.test' },
          },
        ],
      },
      listLocalFriendRequests,
    });

    await expect(
      service.localRelationship({
        id: 0,
        account: 'bob',
        domain: 'bravo.test',
      }),
    ).resolves.toBe('OUTGOING_PENDING');
    expect(listLocalFriendRequests).toHaveBeenCalledTimes(2);
  });
});

describe('UserService profile refresh', () => {
  let svc: UserService;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        UserService,
        // The constructor effect touches WebdbService (open/close on id change) + ensureProfile writes the
        // self-profile through to BOTH ProfileRepository and WebdbService.putMeta('selfProfile') — all side
        // effects irrelevant to the refresh contract, so stub them. sessionProfile is the real signal under test.
        {
          provide: WebdbService,
          useValue: {
            openForUser: vi
              .fn()
              .mockName('openForUser')
              .mockResolvedValue(undefined),
            openExistingForUser: vi
              .fn()
              .mockName('openExistingForUser')
              .mockResolvedValue(undefined),
            recreateForUser: vi
              .fn()
              .mockName('recreateForUser')
              .mockResolvedValue(undefined),
            closeAndDelete: vi
              .fn()
              .mockName('closeAndDelete')
              .mockResolvedValue(undefined),
            getMeta: vi.fn().mockName('getMeta').mockResolvedValue(undefined),
            putMeta: vi.fn().mockName('putMeta').mockResolvedValue(undefined),
            getSyncState: vi
              .fn()
              .mockName('getSyncState')
              .mockResolvedValue(undefined),
            putSyncState: vi
              .fn()
              .mockName('putSyncState')
              .mockResolvedValue(undefined),
            cleanupRelationshipRequests: vi
              .fn()
              .mockName('cleanupRelationshipRequests')
              .mockResolvedValue(undefined),
          },
        },
        {
          provide: ProfileRepository,
          useValue: {
            resolve: vi.fn().mockReturnValue(
              of({
                name: 'A',
                bio: '',
                avatarDigest: null,
                avatarBlob: null,
              }),
            ),
          },
        },
      ],
    });
    svc = TestBed.inject(UserService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  // The force-refresh contract guard. updateSessionProfile() must ALWAYS hit the network — it calls
  // ensureProfile({ force: true }). Before the fix it passed no `force`, so once sessionProfile was
  // populated ensureProfile short-circuited to of(cached): a live change never re-fetched, so the new
  // value never reached sessionProfile (post-edit avatar/name-bio refresh + the PROFILE_REV_UPDATED
  // multi-device refresh suffered the same staleness). The second call here MUST issue a second request
  // and adopt its CHANGED response — only force does that.
  it('updateSessionProfile() forces a re-fetch even when sessionProfile is already set', async () => {
    // First refresh seeds sessionProfile with name = 'A'. The cold POST is subscribed inside
    // updateSessionProfile — expectOne throws until it arrives, and waitFor retries on that throw.
    svc.updateSessionProfile();
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ name: 'A' }),
    );
    await vi.waitFor(() => expect(svc.sessionProfile()?.name).toBe('A'));

    vi.mocked(TestBed.inject(ProfileRepository).resolve).mockReturnValue(
      of({
        namespaceId: 0,
        account: 'alice',
        domain: 'local',
        rev: 2,
        name: 'B',
        bio: '',
        avatarDigest: null,
        avatarBlob: null,
      }),
    );
    // Second refresh — sessionProfile is already set. The bug would short-circuit here (no request,
    // stale 'A' stays). The fix issues the request regardless and adopts the new value.
    svc.updateSessionProfile();
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ name: 'B' }),
    );
    await vi.waitFor(() => expect(svc.sessionProfile()?.name).toBe('B'));
  });

  it('uses runtime avatar presence without caching base64 in the self profile', async () => {
    const result = firstValueFrom(svc.ensureProfile());
    vi.mocked(TestBed.inject(ProfileRepository).resolve).mockReturnValue(
      of({
        namespaceId: 0,
        account: 'alice',
        domain: 'local',
        rev: 2,
        name: 'Resolved Alice',
        bio: 'Resolved bio',
        avatarDigest:
          'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
        avatarBlob: new Blob(['a'], { type: 'image/webp' }),
      }),
    );
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ profileRev: 2, avatar: '/uploads/old-path.webp' }),
    );
    expect(await result).toMatchObject({
      name: 'Resolved Alice',
      avatar: '',
    });
    expect(TestBed.inject(ProfileRepository).resolve).toHaveBeenCalledWith({
      type: 'EXACT',
      account: 'alice',
      domain: 'local',
      rev: 2,
    });
    expect(TestBed.inject(WebdbService).putMeta).toHaveBeenCalledWith(
      'selfProfile',
      expect.objectContaining({ avatar: '' }),
    );
  });

  // Contrast: ensureProfile() (no force) is the idempotent get-or-load — it DOES short-circuit to the
  // cached sessionProfile on a second call (of(cached), no HTTP). This is precisely the behavior
  // updateSessionProfile must NOT inherit; pinning both keeps the two accessors' contracts explicit
  // so the force cannot be "simplified" back out of the refresh path.
  it('ensureProfile() (no force) short-circuits to the cached profile on the second call', async () => {
    const first = firstValueFrom(svc.ensureProfile());
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ name: 'A' }),
    );
    await first;
    expect(svc.sessionProfile()?.name).toBe('A');

    // Second call: sessionProfile is set → returns of(cached) synchronously, NO HTTP request.
    let emitted: User | undefined;
    svc.ensureProfile().subscribe((u) => (emitted = u));
    expect(emitted?.name).toBe('A'); // served from cache, not the network
    httpMock.expectNone(isMyProfile);
  });

  // Regression guard for the account-switch bug: clearSession() (logout) must wipe the user-scoped
  // account preferences (emoji recents — no server copy) so a second account on the
  // same browser never sees the previous one's, while leaving device-level preferences (theme, language,
  // list-width, device_id) intact. The DB-layer in-memory caches are reset by each repo's own
  // session-end effect (watching sessionProfile) — covered in their specs.
  it('clearSession() clears account preferences but keeps device preferences', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    svc.sessionProfile.set(profile({ id: 1 }).data);
    await preferences.set('account:1', 'soms.chat.emojiRecents', ['😀']);
    await preferences.set('device', 'theme', 'dark');
    await svc.clearSession();
    expect(svc.sessionProfile()).toBeUndefined();
    expect(
      await preferences.get('account:1', 'soms.chat.emojiRecents'),
    ).toBeUndefined();
    expect(await preferences.get('device', 'theme')).toBe('dark');
    await preferences.remove('device', 'theme');
  });

  it('derives the friend-request badge from the synchronized read watermark', () => {
    expect(svc.friendReqBadge()).toBe(false);

    svc.applyRelationshipRequestStateRevision(20);
    svc.seedStateFeedCursor(20);
    expect(svc.friendReqBadge()).toBe(true);

    svc.markRelationshipRequestsRead();
    httpMock
      .expectOne(
        (req) =>
          req.method === 'POST' &&
          req.url.endsWith('/relationship/requests/read'),
      )
      .flush({ code: 0, data: { readThroughFeedId: 20 } });
    expect(svc.friendReqBadge()).toBe(false);

    svc.applyRelationshipRequestStateRevision(21);
    expect(svc.friendReqBadge()).toBe(true);
  });
});

describe('UserService session lifecycle (establishSession / restoreWebdb / clearSession)', () => {
  let reload: Mock;
  let svc: UserService;
  let httpMock: HttpTestingController;
  let webdb: {
    openForUser: Mock;
    openExistingForUser: Mock;
    recreateForUser: Mock;
    closeAndDelete: Mock;
    getMeta: Mock;
    putMeta: Mock;
    getSyncState: Mock;
    putSyncState: Mock;
    cleanupRelationshipRequests: Mock;
  };

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        UserService,
        {
          provide: WebdbService,
          useValue: {
            openForUser: vi
              .fn()
              .mockName('openForUser')
              .mockResolvedValue(undefined),
            openExistingForUser: vi
              .fn()
              .mockName('openExistingForUser')
              .mockResolvedValue(undefined),
            recreateForUser: vi
              .fn()
              .mockName('recreateForUser')
              .mockResolvedValue(undefined),
            closeAndDelete: vi
              .fn()
              .mockName('closeAndDelete')
              .mockResolvedValue(undefined),
            getMeta: vi.fn().mockName('getMeta').mockResolvedValue({
              id: 1,
              profileRev: 0,
              name: 'A',
              avatar: '',
              bio: '',
              domain: 'local',
            }),
            putMeta: vi.fn().mockName('putMeta').mockResolvedValue(undefined),
            getSyncState: vi
              .fn()
              .mockName('getSyncState')
              .mockResolvedValue(undefined),
            putSyncState: vi
              .fn()
              .mockName('putSyncState')
              .mockResolvedValue(undefined),
            cleanupRelationshipRequests: vi
              .fn()
              .mockName('cleanupRelationshipRequests')
              .mockResolvedValue(undefined),
          },
        },
        {
          provide: ProfileRepository,
          useValue: {
            resolve: vi.fn().mockReturnValue(
              of({
                name: 'A',
                bio: '',
                avatarDigest: null,
                avatarBlob: null,
              }),
            ),
          },
        },
      ],
    });
    reload = vi.fn();
    TestBed.overrideProvider(CACHE_REBUILD_RELOAD, { useValue: reload });
    svc = TestBed.inject(UserService);
    httpMock = TestBed.inject(HttpTestingController);
    webdb = TestBed.inject(WebdbService) as unknown as typeof webdb;
    await TestBed.inject(PreferenceStore).remove('device', 'soms.lastUserId');
    await TestBed.inject(PreferenceStore).remove(
      'account:1',
      'soms.cacheRebuild',
    );
    await TestBed.inject(PreferenceStore).remove(
      'account:7',
      'soms.cacheRebuild',
    );
  });

  afterEach(() => {
    httpMock.verify();
    void TestBed.inject(PreferenceStore).remove('device', 'soms.lastUserId');
  });

  it('establishSession opens the per-user IDB on userId + sets sessionUserId + persists lastUserId', async () => {
    await svc.establishSession(1, 0);
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBe(1);
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBe(1);
  });

  it('runs request garbage collection on startup when no prior cleanup exists', async () => {
    webdb.getMeta.mockImplementation(async (key: string) =>
      key === 'selfProfile'
        ? {
            id: 1,
            profileRev: 0,
            name: 'A',
            avatar: '',
            bio: '',
            domain: 'local',
          }
        : undefined,
    );

    await svc.establishSession(1, 0);
    // The cleanup is fire-and-forget inside establishSession; its completion is marked by the
    // persisted timestamp (written only after the cleanup resolves) — wait on that, not on a sleep.
    await vi.waitFor(() =>
      expect(webdb.putMeta).toHaveBeenCalledWith(
        'relationshipRequestCleanupAt',
        expect.any(Number),
      ),
    );

    expect(webdb.cleanupRelationshipRequests).toHaveBeenCalledTimes(1);
    expect(webdb.putMeta).toHaveBeenCalledWith(
      'relationshipRequestCleanupAt',
      expect.any(Number),
    );
  });

  it('skips startup request garbage collection within the 24-hour interval', async () => {
    const recent = Date.now() - 1_000;
    webdb.getMeta.mockImplementation(async (key: string) => {
      if (key === 'relationshipRequestCleanupAt') return recent;
      if (key === 'selfProfile')
        return {
          id: 1,
          profileRev: 0,
          name: 'A',
          avatar: '',
          bio: '',
          domain: 'local',
        };
      return undefined;
    });

    await svc.establishSession(1, 0);
    // No wait needed: the skip-vs-run branch is evaluated inside establishSession, so once the
    // await above resolves the decision is already final.

    expect(webdb.cleanupRelationshipRequests).not.toHaveBeenCalled();
  });

  it('runs startup request garbage collection when the 24-hour interval has elapsed', async () => {
    const stale = Date.now() - 86_400_000 - 1_000;
    webdb.getMeta.mockImplementation(async (key: string) => {
      if (key === 'relationshipRequestCleanupAt') return stale;
      if (key === 'selfProfile')
        return {
          id: 1,
          profileRev: 0,
          name: 'A',
          avatar: '',
          bio: '',
          domain: 'local',
        };
      return undefined;
    });

    await svc.establishSession(1, 0);
    await vi.waitFor(() =>
      expect(webdb.putMeta).toHaveBeenCalledWith(
        'relationshipRequestCleanupAt',
        expect.any(Number),
      ),
    );

    expect(webdb.cleanupRelationshipRequests).toHaveBeenCalledTimes(1);
  });

  it('restores the local invitation revision and synchronized read head', async () => {
    webdb.getMeta.mockImplementation(async (key: string) => {
      if (key === 'relationshipRequestStateRevision') return 12;
      if (key === 'relationshipRequestReadHead')
        return { readThroughFeedId: 9 };
      return {
        id: 1,
        profileRev: 0,
        name: 'A',
        avatar: '',
        bio: '',
        domain: 'local',
      };
    });

    await svc.establishSession(1, 0);

    expect(svc.relationshipRequestStateRevision()).toBe(12);
    expect(svc.relationshipRequestReadThroughFeedId()).toBe(9);
    expect(svc.friendReqBadge()).toBe(true);
  });

  it('does not rebuild the database for an invalidated HELLO after an open failure', async () => {
    let rejectOpen!: (error: Error) => void;
    webdb.openExistingForUser.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOpen = reject;
        }),
    );
    const opening = svc.establishSession(1, 0);
    const rejected = expect(opening).rejects.toThrow(
      'account session expired during HELLO',
    );
    TestBed.inject(SessionLifecycleService).invalidateSession();
    rejectOpen(new Error('closed during logout'));
    await rejected;
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBeNull();
  });

  it('fresh login drops and initializes the cache before strictly opening it', async () => {
    svc.prepareFreshCache();

    await svc.establishSession(1, 0);

    expect(webdb.recreateForUser).toHaveBeenCalledTimes(1);

    expect(webdb.recreateForUser).toHaveBeenCalledWith('1');
    expect(webdb.openExistingForUser).toHaveBeenCalledTimes(1);
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('1');
  });

  it('rebuilds an unreadable cache discovered when HELLO establishes the session', async () => {
    webdb.openExistingForUser.mockRejectedValue(new Error('unreadable cache'));

    await expect(svc.establishSession(1, 0)).resolves.not.toThrow();

    expect(webdb.recreateForUser).toHaveBeenCalledTimes(1);

    expect(webdb.recreateForUser).toHaveBeenCalledWith('1');
  });

  it('establishSession is idempotent for the same user on reconnect', async () => {
    await svc.establishSession(1, 0);
    webdb.openExistingForUser.mockClear();
    await svc.establishSession(1, 0);
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBe(1);
  });

  it('establishSession on an account switch closes the previous DB + opens the new one', async () => {
    await svc.establishSession(1, 0);
    webdb.closeAndDelete.mockClear();
    webdb.openExistingForUser.mockClear();

    // Switch to user 2: gateSelfProfile cache-misses (cached id:1 ≠ 2) → flush its my-profile fetch.
    const done = svc.establishSession(2, 0);
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ id: 2 }),
    );
    await done;

    expect(webdb.closeAndDelete).toHaveBeenCalledWith('1'); // previous user's DB torn down
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('2'); // new user's DB opened
    expect(svc.sessionUserId()).toBe(2);
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBe(2);
  });

  it('clearSession closes the DB + clears sessionUserId + clears lastUserId', async () => {
    await svc.establishSession(1, 0);
    webdb.closeAndDelete.mockClear();

    await svc.clearSession();
    expect(webdb.closeAndDelete).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBeNull();
    // clearSession awaits the preference removal before it resolves — no drain needed.
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBeUndefined();
  });

  it('announces completed cleanup even when the session ended before HELLO', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 1);
    await svc.restoreWebdb();
    expect(svc.sessionUserId()).toBeNull();
    const ended = vi.fn();
    const subscription = TestBed.inject(
      SessionLifecycleService,
    ).ended$.subscribe(ended);
    let finishDeletion!: () => void;
    webdb.closeAndDelete.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDeletion = resolve;
        }),
    );

    const clearing = svc.clearSession();
    expect(TestBed.inject(SessionLifecycleService).accountEpoch).toBe(1);
    expect(ended).not.toHaveBeenCalled();
    finishDeletion();
    await clearing;

    expect(webdb.closeAndDelete).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
    await svc.clearSession();
    expect(ended).toHaveBeenCalledTimes(2);
    subscription.unsubscribe();
  });

  it('keeps the session retryable when durable cache deletion fails', async () => {
    await svc.establishSession(1, 0);
    const ended = vi.fn();
    const subscription = TestBed.inject(
      SessionLifecycleService,
    ).ended$.subscribe(ended);
    webdb.closeAndDelete.mockRejectedValue(new Error('cache busy'));

    await expect(svc.clearSession()).rejects.toThrowError('cache busy');
    expect(TestBed.inject(SessionLifecycleService).accountEpoch).toBe(1);
    expect(svc.sessionUserId()).toBe(1);
    expect(ended).not.toHaveBeenCalled();
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBe(1);

    webdb.closeAndDelete.mockResolvedValue(undefined);
    await svc.clearSession();
    expect(webdb.closeAndDelete).toHaveBeenCalledTimes(2);
    expect(TestBed.inject(SessionLifecycleService).accountEpoch).toBe(2);
    expect(svc.sessionUserId()).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });

  it('restoreWebdb opens the DB and restores the matching self profile for offline eager paint', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    const cached = profile({
      id: 7,
      name: 'Cached Alice',
      avatar: '/cached.webp',
    }).data;
    webdb.getMeta.mockResolvedValue(cached);
    await svc.restoreWebdb();
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('7');
    expect(webdb.getMeta).toHaveBeenCalledWith('selfProfile');
    expect(svc.sessionProfile()).toEqual(cached);
    // sessionUserId is NOT set by restoreWebdb — it stays HELLO-driven (establishSession owns it on HELLO).
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb rebuilds any invalid cache without ending the session', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.openExistingForUser.mockRejectedValue(
      new LocalCacheVersionMismatchError('soms-webdb-u7'),
    );
    webdb.getMeta.mockResolvedValue(undefined);

    await svc.restoreWebdb();

    expect(webdb.recreateForUser).toHaveBeenCalledTimes(1);

    expect(webdb.recreateForUser).toHaveBeenCalledWith('7');
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb also rebuilds a missing or unreadable cache', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.openExistingForUser.mockRejectedValue(new Error('unreadable cache'));
    webdb.getMeta.mockResolvedValue(undefined);

    await svc.restoreWebdb();

    expect(webdb.recreateForUser).toHaveBeenCalledTimes(1);

    expect(webdb.recreateForUser).toHaveBeenCalledWith('7');
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb ignores a self profile belonging to a different IDB partition owner', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.getMeta.mockResolvedValue(profile({ id: 8 }).data);
    await svc.restoreWebdb();
    expect(svc.sessionProfile()).toBeUndefined();
  });

  it('restoreWebdb is a no-op when no userId was persisted (first-ever launch)', async () => {
    await svc.restoreWebdb();
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
  });

  it('defers missing-account recovery to normal HELLO initialization', async () => {
    await svc.requestCacheRebuild();
    expect(reload).not.toHaveBeenCalled();
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
  });

  it('allows another automatic recovery only after a new login', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('account:1', 'soms.cacheRebuild', 'attempted');
    svc.prepareFreshCache();
    await svc.establishSession(1, 0);
    expect(
      await preferences.get('account:1', 'soms.cacheRebuild'),
    ).toBeUndefined();
    await svc.requestCacheRebuild();
    expect(reload).toHaveBeenCalledOnce();
    expect(await preferences.get('account:1', 'soms.cacheRebuild')).toBe(
      'pending',
    );
  });

  it('does not retry a failed rebuild when HELLO arrives after startup', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('device', 'soms.lastUserId', 7);
    await preferences.set('account:7', 'soms.cacheRebuild', 'attempted');
    const failure = new Error('database still unavailable');
    webdb.openExistingForUser.mockRejectedValue(failure);
    await svc.restoreWebdb();
    await expect(svc.establishSession(7, 0)).rejects.toBe(failure);
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBeNull();
  });

  it('coalesces recovery requests and rebuilds on the next boot without clearing the session', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('device', 'soms.lastUserId', 7);
    await svc.restoreWebdb();
    const ended = vi.fn();
    const subscription = TestBed.inject(
      SessionLifecycleService,
    ).ended$.subscribe(ended);
    await Promise.all([svc.requestCacheRebuild(), svc.requestCacheRebuild()]);
    expect(reload).toHaveBeenCalledOnce();
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(await preferences.get('account:7', 'soms.cacheRebuild')).toBe(
      'pending',
    );

    const nextBoot = TestBed.runInInjectionContext(
      () => new UserService(TestBed.inject(HttpClient)),
    );
    await nextBoot.restoreWebdb();
    expect(webdb.recreateForUser).toHaveBeenCalledOnce();
    expect(webdb.recreateForUser).toHaveBeenCalledWith('7');
    expect(await preferences.get('account:7', 'soms.cacheRebuild')).toBe(
      'attempted',
    );
    expect(await preferences.get('device', 'soms.lastUserId')).toBe(7);
    expect(nextBoot.stateFeedCursor()).toBeUndefined();
    expect(ended).not.toHaveBeenCalled();
    await nextBoot.requestCacheRebuild();
    expect(reload).toHaveBeenCalledOnce();
    subscription.unsubscribe();
  });

  it('warns and stops if the one automatic rebuild fails', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('device', 'soms.lastUserId', 7);
    await preferences.set('account:7', 'soms.cacheRebuild', 'pending');
    const failure = new Error('storage unavailable');
    webdb.recreateForUser.mockRejectedValue(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(svc.restoreWebdb()).resolves.toBeUndefined();
    await svc.requestCacheRebuild();
    expect(webdb.recreateForUser).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[cache-recovery] account cache rebuild unavailable',
      failure,
    );
    expect(await preferences.get('account:7', 'soms.cacheRebuild')).toBe(
      'attempted',
    );
  });

  it('rebuilds after cached profile reading fails, not only after opening fails', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.getMeta.mockRejectedValueOnce(new Error('corrupt profile'));
    await expect(svc.restoreWebdb()).resolves.toBeUndefined();
    expect(webdb.recreateForUser).toHaveBeenCalledOnce();
  });

  it('warns without rejecting if the recovery marker cannot be saved', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('device', 'soms.lastUserId', 7);
    await svc.restoreWebdb();
    const failure = new Error('preferences unavailable');
    vi.spyOn(preferences, 'set').mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(svc.requestCacheRebuild()).resolves.toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[cache-recovery] could not schedule cache rebuild',
      failure,
    );
  });
});
