import type { Mock } from 'vitest';
import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, HttpRequest, withXhr } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { UserService } from './user.service';
import { LocalCacheVersionMismatchError, WebdbService } from './webdb.service';
import { ProfileRepository } from './profile-store.service';
import { User } from './model';
import { PreferenceStore } from './preference-store.service';

/** Flush microtasks + macrotasks so the cold HttpClient POST (subscribed inside updateSessionProfile)
 *  settles through to the sessionProfile signal. */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    ...over,
  } as User,
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
            cleanupRelationshipRequests: vi
              .fn()
              .mockName('cleanupRelationshipRequests')
              .mockResolvedValue(undefined),
          },
        },
        {
          provide: ProfileRepository,
          useValue: {
            putProfile: vi
              .fn()
              .mockName('putProfile')
              .mockResolvedValue(undefined),
          },
        },
      ],
    });
    svc = TestBed.inject(UserService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('treats a join-request head covered by the optimistic read watermark as an acknowledgement', () => {
    svc.groupJoinRequestHeads.set(
      new Map([[7, { latestFeedId: 12, readFeedId: 12 }]]),
    );

    expect(svc.applyGroupJoinRequestHead(7, 12, 12)).toBe(false);
    expect(svc.groupJoinRequestHeads().get(7)).toEqual({
      latestFeedId: 12,
      readFeedId: 12,
    });
  });

  it('reports only a head newer than the local read watermark as new attention', () => {
    svc.groupJoinRequestHeads.set(
      new Map([[7, { latestFeedId: 12, readFeedId: 12 }]]),
    );

    expect(svc.applyGroupJoinRequestHead(7, 13, 12)).toBe(true);
    expect(svc.groupJoinRequestHeads().get(7)).toEqual({
      latestFeedId: 13,
      readFeedId: 12,
    });
  });

  it('garbage-collects one group head from memory and durable metadata', async () => {
    const webdb = TestBed.inject(WebdbService) as unknown as {
      putMeta: Mock;
    };
    webdb.putMeta.mockClear();
    svc.groupJoinRequestHeads.set(
      new Map([
        [7, { latestFeedId: 13, readFeedId: 12 }],
        [8, { latestFeedId: 20, readFeedId: 19 }],
      ]),
    );

    svc.clearGroupJoinRequestHead(7);
    await flush();

    expect(svc.groupJoinRequestHeads()).toEqual(
      new Map([[8, { latestFeedId: 20, readFeedId: 19 }]]),
    );
    expect(webdb.putMeta).toHaveBeenCalledWith('groupJoinRequestHeads', {
      '8': 20,
    });
    expect(webdb.putMeta).toHaveBeenCalledWith('groupJoinRequestReadFeedIds', {
      '8': 19,
    });
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
    // First refresh seeds sessionProfile with name = 'A'.
    svc.updateSessionProfile();
    await flush(50);
    httpMock.expectOne(isMyProfile).flush(profile({ name: 'A' }));
    await flush();
    expect(svc.sessionProfile()?.name).toBe('A');

    // Second refresh — sessionProfile is already set. The bug would short-circuit here (no request,
    // stale 'A' stays). The fix issues the request regardless and adopts the new value.
    svc.updateSessionProfile();
    await flush();
    httpMock.expectOne(isMyProfile).flush(profile({ name: 'B' }));
    await flush();
    expect(svc.sessionProfile()?.name).toBe('B');
  });

  // Contrast: ensureProfile() (no force) is the idempotent get-or-load — it DOES short-circuit to the
  // cached sessionProfile on a second call (of(cached), no HTTP). This is precisely the behavior
  // updateSessionProfile must NOT inherit; pinning both keeps the two accessors' contracts explicit
  // so the force cannot be "simplified" back out of the refresh path.
  it('ensureProfile() (no force) short-circuits to the cached profile on the second call', async () => {
    const first = firstValueFrom(svc.ensureProfile());
    await flush();
    httpMock.expectOne(isMyProfile).flush(profile({ name: 'A' }));
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
  let svc: UserService;
  let httpMock: HttpTestingController;
  let webdb: {
    openForUser: Mock;
    openExistingForUser: Mock;
    recreateForUser: Mock;
    closeAndDelete: Mock;
    getMeta: Mock;
    putMeta: Mock;
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
            // Cache-hit self profile for {id:1, profileRev:0} → gateSelfProfile short-circuits with NO
            // fetch in these tests (the profile gate is orthogonal — covered by the refresh suite above).
            // A user/rev that cache-misses (account switch to id:2) falls through to a real fetch, matched
            // explicitly in that test.
            getMeta: vi.fn().mockName('getMeta').mockResolvedValue({
              id: 1,
              profileRev: 0,
              name: 'A',
              avatar: '',
              bio: '',
              domain: 'local',
            }),
            putMeta: vi.fn().mockName('putMeta').mockResolvedValue(undefined),
            cleanupRelationshipRequests: vi
              .fn()
              .mockName('cleanupRelationshipRequests')
              .mockResolvedValue(undefined),
          },
        },
        {
          provide: ProfileRepository,
          useValue: {
            putProfile: vi
              .fn()
              .mockName('putProfile')
              .mockResolvedValue(undefined),
          },
        },
      ],
    });
    svc = TestBed.inject(UserService);
    httpMock = TestBed.inject(HttpTestingController);
    webdb = TestBed.inject(WebdbService) as unknown as typeof webdb;
    await TestBed.inject(PreferenceStore).remove('device', 'soms.lastUserId');
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
    await flush();

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
    await flush();

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
    await flush();

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
    await flush();
    httpMock.expectOne(isMyProfile).flush(profile({ id: 2 }));
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
    await flush();
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBeUndefined();
  });

  it('keeps the session retryable when durable cache deletion fails', async () => {
    await svc.establishSession(1, 0);
    webdb.closeAndDelete.mockRejectedValue(new Error('cache busy'));

    await expect(svc.clearSession()).rejects.toThrowError('cache busy');
    expect(svc.sessionUserId()).toBe(1);
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBe(1);

    webdb.closeAndDelete.mockResolvedValue(undefined);
    await svc.clearSession();
    expect(webdb.closeAndDelete).toHaveBeenCalledTimes(2);
    expect(svc.sessionUserId()).toBeNull();
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
});
