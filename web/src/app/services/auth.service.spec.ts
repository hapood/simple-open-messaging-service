import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TranslocoService } from '@jsverse/transloco';
import { AuthService } from './auth.service';
import { RouteService } from './route.service';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';
import { ToastService } from './toast.service';

/**
 * AuthService session-token contract — BROWSER (pure-httpOnly) path.
 *
 * The native (Android/desktop) storage contract is covered by auth.service.native.spec.ts; this spec locks
 * down the headless-browser env (isTauri() false → client 'web'), where the session token lives in the
 * JS-unreadable httpOnly cookie the backend sets — JS NEVER holds it (XSS can't exfiltrate it). HttpTesting
 * Controller can't set cookies, so the presence-cookie-driven login state is simulated explicitly. Locked
 * down here:
 *  - login() sends `client:'web'` + a friendly `device` label + `trusted:false` (web can never be trusted);
 *    on success no token is held in JS (there is no sessionToken surface — the credential lives only in the
 *    httpOnly cookie);
 *  - logout() resolves the session from the httpOnly cookie (no JS token to send) and clears the presence
 *    cookie so isLoggedIn() flips at once;
 *  - revokeSession(id) sends `{ id }` by row id.
 */
describe('AuthService (session-token contract, browser path)', () => {
  let svc: AuthService;
  let httpMock: HttpTestingController;
  let closeNotification: Mock;

  beforeEach(() => {
    closeNotification = vi.fn();
    vi.spyOn(navigator.serviceWorker, 'getRegistration').mockResolvedValue({
      getNotifications: async () => [
        { tag: 'soms-thread-7', close: closeNotification },
      ],
    } as unknown as ServiceWorkerRegistration);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        AuthService,
        // AuthService resolves i18n keys for its rare keyring-failure toasts; stub the translator (returns
        // the key) so the spec has no transloco-config dependency. The browser path never reaches those
        // toasts, but the constructor deps must still resolve.
        {
          provide: TranslocoService,
          useValue: { translate: (k: string) => k },
        },
        {
          provide: ToastService,
          useValue: {
            warn: vi.fn().mockName('warn'),
            info: vi.fn().mockName('info'),
          },
        },
        {
          provide: RouteService,
          useValue: {
            redirect: vi.fn().mockName('redirect'),
            openSettings: () => {},
          },
        },
        {
          provide: PushService,
          useValue: {
            onLogin: vi.fn().mockName('onLogin'),
            unregister: vi.fn().mockName('unregister'),
          },
        },
        {
          provide: WebPushService,
          useValue: {
            onLogin: vi.fn().mockName('onLogin'),
            unregister: vi.fn().mockName('unregister'),
          },
        },
        {
          provide: UserService,
          useValue: {
            clearSession: vi.fn().mockName('clearSession'),
            prepareFreshCache: vi.fn().mockName('prepareFreshCache'),
            restoreWebdb: vi
              .fn()
              .mockName('restoreWebdb')
              .mockResolvedValue(undefined),
          },
        },
      ],
    });
    svc = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    // Clear any presence cookie a test set (document.cookie survives resetTestingModule).
    document.cookie = 'logged_in=; Max-Age=0; Path=/; SameSite=Strict';
  });

  it('login() sends client:web + a friendly device label; on the pure-httpOnly browser path no token is held in JS', async () => {
    expect(svc.isLoggedIn()).toBe(false); // no presence cookie before login
    svc.login({ account: 'alice', password: 'pw' }).subscribe();
    // login() runs through pickThen = `defer(() => pickLoginOrigin()).pipe(mergeMap(...))`. Even on the
    // browser path pickLoginOrigin() is `Promise.resolve(apiOrigin())`, so the POST fires on the next
    // microtask — NOT synchronously. Let that hop settle before asserting on the request (logout() and
    // revokeSession() post directly, so they need no such wait).
    await new Promise((r) => setTimeout(r));

    const req = httpMock.expectOne((r) => /\/auth\/login$/.test(r.url));
    expect(req.request.body.account).toBe('alice');
    // Headless browser test env → isTauri() false → client metadata is 'web'.
    expect(req.request.body.client).toBe('web');
    expect(req.request.body.trusted).toBeUndefined();
    expect(req.request.body.persistent).toBeUndefined();
    expect(typeof req.request.body.device).toBe('string');
    expect(req.request.body.device.length).toBeGreaterThan(0);

    req.flush({ code: 0, message: 'ok', data: { session_token: 'st-1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeNotification).toHaveBeenCalledTimes(1);
    // Pure-httpOnly browser: the token lives in the (JS-unreadable) httpOnly cookie the backend set — JS
    // NEVER holds it (there is no sessionToken surface at all). Login state rides the non-httpOnly
    // `logged_in` presence cookie, which HttpTestingController doesn't set, so isLoggedIn() stays false
    // until we simulate the backend setting it.
    expect(svc.isLoggedIn()).toBe(false);
    document.cookie = 'logged_in=1; Path=/';
    expect(svc.isLoggedIn()).toBe(true);
  });

  it('logout() resolves the session from the httpOnly cookie (no JS token to send) and clears the presence cookie', async () => {
    // Simulate a logged-in browser: the backend set the `logged_in` presence cookie at login; the session
    // token is JS-unreadable (httpOnly), so logout identifies the session via the cookie, not a JS-held token.
    document.cookie = 'logged_in=1; Path=/';
    expect(svc.isLoggedIn()).toBe(true);

    svc.logout().subscribe();
    await Promise.resolve();
    const req = httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url));
    // The logout body carries NO token — JS never holds one. The backend resolves the session from the
    // httpOnly cookie (browser) / Bearer (native). No refresh token (single session-token model).
    expect(req.request.body.sessionToken).toBeUndefined();
    expect(req.request.body.refreshToken).toBeUndefined();
    req.flush({ code: 0, message: 'ok' });

    // clearNativeToken() cleared the presence cookie client-side (synchronous on the browser branch).
    expect(svc.isLoggedIn()).toBe(false);
  });

  it('does not clear login state or start remote logout before local cache deletion succeeds', async () => {
    document.cookie = 'logged_in=1; Path=/';
    let finishCacheClear!: () => void;
    const cacheClear = new Promise<void>((resolve) => {
      finishCacheClear = resolve;
    });
    const user = TestBed.inject(UserService) as unknown as {
      clearSession: Mock;
    };
    user.clearSession.mockReturnValue(cacheClear);
    const exited = vi.fn().mockName('exited');

    svc.logout().subscribe(exited);

    expect(svc.isLoggedIn()).toBe(true);
    expect(exited).not.toHaveBeenCalled();
    httpMock.expectNone((request) => /\/auth\/logout$/.test(request.url));

    finishCacheClear();
    await Promise.resolve();

    expect(svc.isLoggedIn()).toBe(false);
    expect(exited).toHaveBeenCalledTimes(1);
    httpMock
      .expectOne((request) => /\/auth\/logout$/.test(request.url))
      .flush({ code: 0, message: 'ok' });
  });

  it('keeps login state and skips remote logout when local cache deletion fails', async () => {
    document.cookie = 'logged_in=1; Path=/';
    const user = TestBed.inject(UserService) as unknown as {
      clearSession: Mock;
    };
    user.clearSession.mockRejectedValue(new Error('cache busy'));

    svc.logout().subscribe({ error: () => {} });
    await Promise.resolve();

    expect(svc.isLoggedIn()).toBe(true);
    httpMock.expectNone((request) => /\/auth\/logout$/.test(request.url));
    expect(TestBed.inject(ToastService).warn).toHaveBeenCalled();
  });

  it('keeps the authenticated session when local-cache initialization fails', async () => {
    document.cookie = 'logged_in=1; Path=/';
    const user = TestBed.inject(UserService) as unknown as {
      restoreWebdb: Mock;
      clearSession: Mock;
    };
    user.restoreWebdb.mockRejectedValue(new Error('missing cache'));

    await svc.restoreSession();

    expect(user.clearSession).not.toHaveBeenCalled();
    expect(TestBed.inject(RouteService).redirect).not.toHaveBeenCalled();
    httpMock.expectNone((request) => /\/auth\/logout$/.test(request.url));
    expect(TestBed.inject(ToastService).warn).toHaveBeenCalledWith(
      'auth.notice.localCacheUnavailable',
    );
    expect(svc.isLoggedIn()).toBe(true);
  });

  it('revokeSession(id) sends { id } (by row id, not jti)', () => {
    svc.revokeSession(42).subscribe();
    const req = httpMock.expectOne((r) =>
      /\/auth\/revoke-session$/.test(r.url),
    );
    expect(req.request.body.id).toBe(42);
    req.flush({ code: 0, message: 'ok' });
  });

  it('preserves notifications and pending taps when restoring an existing session', async () => {
    document.cookie = 'logged_in=1; Path=/';
    await svc.restoreSession();
    expect(TestBed.inject(UserService).restoreWebdb).toHaveBeenCalledTimes(1);
    expect(closeNotification).not.toHaveBeenCalled();
    expect(svc.isLoggedIn()).toBe(true);
  });

  it('clears notifications when explicitly clearing the session', async () => {
    document.cookie = 'logged_in=1; Path=/';
    await svc.clearToken();
    expect(closeNotification).toHaveBeenCalledTimes(1);
    expect(svc.isLoggedIn()).toBe(false);
  });
});
