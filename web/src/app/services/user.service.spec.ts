import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, HttpRequest } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { UserService } from './user.service';
import { WebdbService } from './webdb.service';
import { ProfileRepository } from './profile-store.service';
import { User } from './model';

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
    id: 1, name: 'A', avatar: '', bio: '', domain: '', threadRevision: 5, ...over,
  } as User,
});

describe('UserService profile refresh', () => {
  let svc: UserService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
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
            openForUser: jasmine.createSpy('openForUser').and.resolveTo(undefined),
            closeAndDelete: jasmine.createSpy('closeAndDelete').and.resolveTo(undefined),
            getMeta: jasmine.createSpy('getMeta').and.resolveTo(undefined),
            putMeta: jasmine.createSpy('putMeta').and.resolveTo(undefined),
          },
        },
        {
          provide: ProfileRepository,
          useValue: { putProfile: jasmine.createSpy('putProfile').and.resolveTo(undefined) },
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
    await flush();
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
  // localStorage keys (client-only folders / emoji recents — no server copy) so a second account on the
  // same browser never sees the previous one's, while leaving device-level preferences (theme, language,
  // list-width, device_id) intact. The DB-layer in-memory caches are reset by each repo's own
  // session-end effect (watching sessionProfile) — covered in their specs.
  it('clearSession() clears user-scoped localStorage but keeps device-level prefs', () => {
    // Seed the previous account's client-only data + a device preference.
    localStorage.setItem('soms.chatFolders', '[{"id":"x"}]');
    localStorage.setItem('soms.chat.emojiRecents', '["😀"]');
    localStorage.setItem('soms.theme', 'dark');
    try {
      svc.clearSession();
      expect(svc.sessionProfile()).toBeUndefined();
      expect(localStorage.getItem('soms.chatFolders')).toBeNull();
      expect(localStorage.getItem('soms.chat.emojiRecents')).toBeNull();
      expect(localStorage.getItem('soms.theme')).toBe('dark'); // device pref preserved
    } finally {
      localStorage.removeItem('soms.theme'); // don't pollute other test files
    }
  });
});

describe('UserService session lifecycle (establishSession / restoreWebdb / clearSession)', () => {
  let svc: UserService;
  let httpMock: HttpTestingController;
  let webdb: {
    openForUser: jasmine.Spy;
    closeAndDelete: jasmine.Spy;
    getMeta: jasmine.Spy;
    putMeta: jasmine.Spy;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        UserService,
        {
          provide: WebdbService,
          useValue: {
            openForUser: jasmine.createSpy('openForUser').and.resolveTo(undefined),
            closeAndDelete: jasmine.createSpy('closeAndDelete').and.resolveTo(undefined),
            // Cache-hit self profile for {id:1, profileRev:0} → gateSelfProfile short-circuits with NO
            // fetch in these tests (the profile gate is orthogonal — covered by the refresh suite above).
            // A user/rev that cache-misses (account switch to id:2) falls through to a real fetch, matched
            // explicitly in that test.
            getMeta: jasmine.createSpy('getMeta').and.resolveTo({
              id: 1, profileRev: 0, name: 'A', avatar: '', bio: '', domain: '',
            }),
            putMeta: jasmine.createSpy('putMeta').and.resolveTo(undefined),
          },
        },
        { provide: ProfileRepository, useValue: { putProfile: jasmine.createSpy('putProfile').and.resolveTo(undefined) } },
      ],
    });
    svc = TestBed.inject(UserService);
    httpMock = TestBed.inject(HttpTestingController);
    webdb = TestBed.inject(WebdbService) as unknown as typeof webdb;
    localStorage.removeItem('soms.lastUserId'); // clean slate between tests
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.removeItem('soms.lastUserId');
  });

  it('establishSession opens the per-user IDB on userId + sets sessionUserId + persists lastUserId', async () => {
    await svc.establishSession(1, 0, null);
    expect(webdb.openForUser).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBe(1);
    expect(localStorage.getItem('soms.lastUserId')).toBe('1'); // eager-paint bootstrap remembers it
  });

  it('establishSession is idempotent for the same user (reconnect: no re-open, badge refreshed)', async () => {
    await svc.establishSession(1, 0, null);
    webdb.openForUser.calls.reset();
    // Same user (a reconnect) → short-circuit: the webdb is already open, just refresh the badge.
    await svc.establishSession(1, 0, 1000);
    expect(webdb.openForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBe(1);
  });

  it('establishSession on an account switch closes the previous DB + opens the new one', async () => {
    await svc.establishSession(1, 0, null);
    webdb.closeAndDelete.calls.reset();
    webdb.openForUser.calls.reset();

    // Switch to user 2: gateSelfProfile cache-misses (cached id:1 ≠ 2) → flush its my-profile fetch.
    const done = svc.establishSession(2, 0, null);
    await flush();
    httpMock.expectOne(isMyProfile).flush(profile({ id: 2 }));
    await done;

    expect(webdb.closeAndDelete).toHaveBeenCalledWith('1'); // previous user's DB torn down
    expect(webdb.openForUser).toHaveBeenCalledWith('2'); // new user's DB opened
    expect(svc.sessionUserId()).toBe(2);
    expect(localStorage.getItem('soms.lastUserId')).toBe('2');
  });

  it('clearSession closes the DB + clears sessionUserId + clears lastUserId', async () => {
    await svc.establishSession(1, 0, null);
    webdb.closeAndDelete.calls.reset();

    svc.clearSession();
    expect(webdb.closeAndDelete).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBeNull();
    expect(localStorage.getItem('soms.lastUserId')).toBeNull(); // cleared with the user-scoped keys
  });

  it('restoreWebdb opens the DB on the persisted lastUserId (the pre-HELLO eager-paint path)', async () => {
    localStorage.setItem('soms.lastUserId', '7');
    await svc.restoreWebdb();
    expect(webdb.openForUser).toHaveBeenCalledWith('7');
    // sessionUserId is NOT set by restoreWebdb — it stays HELLO-driven (establishSession owns it on HELLO).
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb is a no-op when no userId was persisted (first-ever launch)', async () => {
    await svc.restoreWebdb();
    expect(webdb.openForUser).not.toHaveBeenCalled();
  });
});
