import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, HttpRequest } from '@angular/common/http';
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
const profile = (over: Partial<User>): { code: number; data: User } => ({
  code: 0,
  data: {
    id: 1,
    name: 'A',
    avatar: '',
    bio: '',
    domain: '',
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
        provideHttpClient(),
        provideHttpClientTesting(),
        UserService,
        // The constructor effect touches WebdbService (open/close on id change) + ensureProfile writes the
        // self-profile through to BOTH ProfileRepository and WebdbService.putMeta('selfProfile') — all side
        // effects irrelevant to the refresh contract, so stub them. sessionProfile is the real signal under test.
        {
          provide: WebdbService,
          useValue: {
            openForUser: jasmine
              .createSpy('openForUser')
              .and.resolveTo(undefined),
            openExistingForUser: jasmine
              .createSpy('openExistingForUser')
              .and.resolveTo(undefined),
            recreateForUser: jasmine
              .createSpy('recreateForUser')
              .and.resolveTo(undefined),
            closeAndDelete: jasmine
              .createSpy('closeAndDelete')
              .and.resolveTo(undefined),
            getMeta: jasmine.createSpy('getMeta').and.resolveTo(undefined),
            putMeta: jasmine.createSpy('putMeta').and.resolveTo(undefined),
          },
        },
        {
          provide: ProfileRepository,
          useValue: {
            putProfile: jasmine
              .createSpy('putProfile')
              .and.resolveTo(undefined),
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

  // The friend-request badge is derived from SERVER-state: friendReqRev (latest incoming-FRIEND-invite
  // update epoch-ms, from HELLO/FRIEND_REQ_REV_UPDATED) > friendReqAckRev (the read cursor). No client IDB —
  // both signals are fed by the server, so the badge is multi-device consistent.
  it('friendReqBadge = friendReqRev > friendReqAckRev, cleared by markFriendReqRead (optimistic + POST)', () => {
    expect(svc.friendReqBadge()).toBe(false); // both 0/null initially → 0 > 0 false

    // HELLO/push carries the server-state pair: rev ahead of ack → badge.
    svc.applyFriendReqRev(2000, 0);
    expect(svc.friendReqBadge()).toBe(true);

    // Opening the panel: optimistic local clear (ack → rev) + POSTs /invite/mark-read (server bumps + pushes).
    svc.markFriendReqRead();
    expect(svc.friendReqBadge()).toBe(false); // optimistic clear
    httpMock
      .expectOne(
        (r) => r.method === 'POST' && r.url.endsWith('/invite/mark-read'),
      )
      .flush({ code: 0, message: 'ok' });

    // A later FRIEND_REQ_REV_UPDATED (new request, ack unchanged) re-arms it.
    svc.applyFriendReqRev(3000, 2000);
    expect(svc.friendReqBadge()).toBe(true);
  });
});

describe('UserService session lifecycle (establishSession / restoreWebdb / clearSession)', () => {
  let svc: UserService;
  let httpMock: HttpTestingController;
  let webdb: {
    openForUser: jasmine.Spy;
    openExistingForUser: jasmine.Spy;
    recreateForUser: jasmine.Spy;
    closeAndDelete: jasmine.Spy;
    getMeta: jasmine.Spy;
    putMeta: jasmine.Spy;
  };

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        UserService,
        {
          provide: WebdbService,
          useValue: {
            openForUser: jasmine
              .createSpy('openForUser')
              .and.resolveTo(undefined),
            openExistingForUser: jasmine
              .createSpy('openExistingForUser')
              .and.resolveTo(undefined),
            recreateForUser: jasmine
              .createSpy('recreateForUser')
              .and.resolveTo(undefined),
            closeAndDelete: jasmine
              .createSpy('closeAndDelete')
              .and.resolveTo(undefined),
            // Cache-hit self profile for {id:1, profileRev:0} → gateSelfProfile short-circuits with NO
            // fetch in these tests (the profile gate is orthogonal — covered by the refresh suite above).
            // A user/rev that cache-misses (account switch to id:2) falls through to a real fetch, matched
            // explicitly in that test.
            getMeta: jasmine.createSpy('getMeta').and.resolveTo({
              id: 1,
              profileRev: 0,
              name: 'A',
              avatar: '',
              bio: '',
              domain: '',
            }),
            putMeta: jasmine.createSpy('putMeta').and.resolveTo(undefined),
          },
        },
        {
          provide: ProfileRepository,
          useValue: {
            putProfile: jasmine
              .createSpy('putProfile')
              .and.resolveTo(undefined),
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
    await svc.establishSession(1, 0, null, 0);
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBe(1);
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBe(1);
  });

  it('fresh login drops and initializes the cache before strictly opening it', async () => {
    svc.prepareFreshCache();

    await svc.establishSession(1, 0, null, 0);

    expect(webdb.recreateForUser).toHaveBeenCalledOnceWith('1');
    expect(webdb.openExistingForUser).toHaveBeenCalledOnceWith('1');
  });

  it('rebuilds an unreadable cache discovered when HELLO establishes the session', async () => {
    webdb.openExistingForUser.and.rejectWith(new Error('unreadable cache'));

    await expectAsync(svc.establishSession(1, 0, null, 0)).toBeResolved();

    expect(webdb.recreateForUser).toHaveBeenCalledOnceWith('1');
  });

  it('establishSession is idempotent for the same user (reconnect: no re-open, badge refreshed)', async () => {
    await svc.establishSession(1, 0, null, 0);
    webdb.openExistingForUser.calls.reset();
    // Same user (a reconnect) → short-circuit: the webdb is already open, just refresh the badge.
    await svc.establishSession(1, 0, 1000, 0);
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBe(1);
  });

  it('establishSession on an account switch closes the previous DB + opens the new one', async () => {
    await svc.establishSession(1, 0, null, 0);
    webdb.closeAndDelete.calls.reset();
    webdb.openExistingForUser.calls.reset();

    // Switch to user 2: gateSelfProfile cache-misses (cached id:1 ≠ 2) → flush its my-profile fetch.
    const done = svc.establishSession(2, 0, null, 0);
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
    await svc.establishSession(1, 0, null, 0);
    webdb.closeAndDelete.calls.reset();

    await svc.clearSession();
    expect(webdb.closeAndDelete).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBeNull();
    await flush();
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBeUndefined();
  });

  it('keeps the session retryable when durable cache deletion fails', async () => {
    await svc.establishSession(1, 0, null, 0);
    webdb.closeAndDelete.and.rejectWith(new Error('cache busy'));

    await expectAsync(svc.clearSession()).toBeRejectedWithError('cache busy');
    expect(svc.sessionUserId()).toBe(1);
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBe(1);

    webdb.closeAndDelete.and.resolveTo(undefined);
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
    webdb.getMeta.and.resolveTo(cached);
    await svc.restoreWebdb();
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('7');
    expect(webdb.getMeta).toHaveBeenCalledWith('selfProfile');
    expect(svc.sessionProfile()).toEqual(cached);
    // sessionUserId is NOT set by restoreWebdb — it stays HELLO-driven (establishSession owns it on HELLO).
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb rebuilds any invalid cache without ending the session', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.openExistingForUser.and.rejectWith(
      new LocalCacheVersionMismatchError('soms-webdb-u7'),
    );
    webdb.getMeta.and.resolveTo(undefined);

    await svc.restoreWebdb();

    expect(webdb.recreateForUser).toHaveBeenCalledOnceWith('7');
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb also rebuilds a missing or unreadable cache', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.openExistingForUser.and.rejectWith(new Error('unreadable cache'));
    webdb.getMeta.and.resolveTo(undefined);

    await svc.restoreWebdb();

    expect(webdb.recreateForUser).toHaveBeenCalledOnceWith('7');
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb ignores a self profile belonging to a different IDB partition owner', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.getMeta.and.resolveTo(profile({ id: 8 }).data);
    await svc.restoreWebdb();
    expect(svc.sessionProfile()).toBeUndefined();
  });

  it('restoreWebdb is a no-op when no userId was persisted (first-ever launch)', async () => {
    await svc.restoreWebdb();
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
  });
});
