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

/** A minimal my-profile response body; `over` overrides the badge + cursor fields under test. */
const profile = (over: Partial<User>): { code: number; data: User } => ({
  code: 0,
  data: {
    id: 1, name: 'A', avatar: '', bio: '', domain: '', threadRevision: 5, hasUrFriendReq: false, ...over,
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
        // The constructor effect touches WebdbService (open/close on id change) + ensureProfile writes
        // through to ProfileRepository — both are side effects irrelevant to the refresh contract, so
        // stub them. sessionProfile itself is the real signal under test.
        {
          provide: WebdbService,
          useValue: {
            openForUser: jasmine.createSpy('openForUser').and.resolveTo(undefined),
            closeAndDelete: jasmine.createSpy('closeAndDelete').and.resolveTo(undefined),
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

  // THE regression guard for the 2026-07-12 friend-request badge bug. updateSessionProfile() must
  // ALWAYS hit the network — it calls ensureProfile({ force: true }). Before the fix it passed no
  // `force`, so once sessionProfile was populated ensureProfile short-circuited to of(cached): a live
  // FRIEND_REQUEST never re-fetched, so the armed hasUrFriendReq never reached the rail/drawer badge
  // (and post-edit avatar/name-bio refresh + markInvitesRead-clear suffered the same staleness). The
  // second call here MUST issue a second request and adopt its CHANGED response — only force does that.
  it('updateSessionProfile() forces a re-fetch even when sessionProfile is already set', async () => {
    // First refresh seeds sessionProfile with hasUrFriendReq = false.
    svc.updateSessionProfile();
    await flush();
    httpMock.expectOne(isMyProfile).flush(profile({ hasUrFriendReq: false }));
    await flush();
    expect(svc.sessionProfile()?.hasUrFriendReq).toBe(false);

    // Second refresh — sessionProfile is already set. The bug would short-circuit here (no request,
    // stale false stays). The fix issues the request regardless and adopts the new value.
    svc.updateSessionProfile();
    await flush();
    httpMock.expectOne(isMyProfile).flush(profile({ hasUrFriendReq: true }));
    await flush();
    expect(svc.sessionProfile()?.hasUrFriendReq).toBe(true);
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
