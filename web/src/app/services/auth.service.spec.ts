import {
  notificationDouble,
  registrationDouble,
  workerDouble,
} from './service-worker-test-doubles';
import { RESTART_APP_DOCUMENT } from './app-data-lifetime.service';
import { LOGOUT_REQUEST_AUTHORITY, LogoutRequestAuthority } from './session/logout-request-authority';
import { HttpClient, HttpContext } from '@angular/common/http';
import { SessionSupersededError } from './session/session-identity';
import { apiPrefix } from './constants';
import { DatabaseRestorationError } from './session/database-restoration-error';
import { SessionStartupService } from './session-startup.service';
import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HTTP_INTERCEPTORS, provideHttpClient, withInterceptors, withInterceptorsFromDi, withXhr } from '@angular/common/http';
import { AuthInterceptor } from '../auth.interceptor';
import { httpResilienceInterceptor, HTTP_RETRY_CONFIG, DEFAULT_HTTP_RETRY_CONFIG } from '../http-resilience.interceptor';
import { AppDataLifetime } from './app-data-lifetime.service';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { firstValueFrom, Observable } from 'rxjs';
import { BusinessCode } from './biz-code';
import { TranslocoService } from '@jsverse/transloco';
import { LogoutDecisionService } from './logout-decision.service';
import { BROWSER_SESSION } from './browser-session.service';
import { AuthService } from './auth.service';
import { REQUEST_SCOPE, RequestScope } from '../request-context';
import { RouteService } from './route.service';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';
import { ToastService } from './toast.service';
import {
  WebdbService,
  provideWebdbService,
  STATE_FEED_WORKER_FACTORY,
} from './webdb.service';
import { PreferenceStore } from './preference-store.service';
import { resetTestAppState } from './session/session-store.test-helper';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import { deleteDB } from 'idb';

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

  beforeEach(async () => {
    closeNotification = vi.fn();
    vi.spyOn(navigator.serviceWorker, 'getRegistration').mockResolvedValue(
      registrationDouble({
        scope: new URL('/push/', location.href).href,
        active: workerDouble(
          (
            _message: unknown,
            transfer?: Transferable[] | StructuredSerializeOptions,
          ) => {
            const port = Array.isArray(transfer)
              ? transfer[0]
              : transfer?.transfer?.[0];
            if (port instanceof MessagePort) port.postMessage({ ok: true });
          },
        ),
        getNotifications: async () => [
          notificationDouble('soms-thread-7', closeNotification),
        ],
      }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr(), withInterceptorsFromDi(), withInterceptors([httpResilienceInterceptor])),
        { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
        { provide: HTTP_RETRY_CONFIG, useValue: DEFAULT_HTTP_RETRY_CONFIG },
        provideHttpClientTesting(),
        AuthService,
        { provide: RESTART_APP_DOCUMENT, useValue: vi.fn() },
        {
          provide: LogoutDecisionService,
          useValue: { decide: vi.fn().mockResolvedValue('localOnly') },
        },
        provideWebdbService(),
        { provide: STATE_FEED_WORKER_FACTORY, useValue: () => null },
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
            unsubscribe: vi.fn().mockResolvedValue(undefined),
            onLogin: vi.fn().mockName('onLogin'),
            unregister: vi.fn().mockName('unregister'),
          },
        },
        {
          provide: UserService,
          useValue: {
            prepareFreshCache: vi.fn().mockName('prepareFreshCache'),
            sessionProfile: () => undefined,
            resetSessionState: vi.fn(),
            restoreWebdb: vi
              .fn()
              .mockName('restoreWebdb')
              .mockResolvedValue(undefined),
          },
        },
      ],
    });
    await resetTestAppState();
    svc = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });
  afterEach(async () => {
    try {
      await TestBed.inject(WebdbService).close();
      for (const { name } of await indexedDB.databases()) {
        if (name?.startsWith('soms-session')) await deleteDB(name);
      }
      await resetTestAppState();
    } finally {
      try {
        await TestBed.inject(PreferenceStore).close();
      } finally {
        TestBed.resetTestingModule();
        vi.restoreAllMocks();
        // Clear any presence cookie a test set (document.cookie survives resetTestingModule).
        document.cookie = 'logged_in=; Max-Age=0; Path=/; SameSite=Strict';
      }
    }
  });

  it('login() sends client:web + a friendly device label; on the pure-httpOnly browser path no token is held in JS', async () => {
    expect(svc.isLoggedIn()).toBe(false); // no presence cookie before login
    // login() awaits activateSession BEFORE its observable emits — `done` is the deterministic
    // whole-chain completion signal (logout() and revokeSession() post directly, so they need no wait).
    const done = firstValueFrom(
      svc.login({ account: 'alice', password: 'pw' }),
    );
    // Even on the browser path pickLoginOrigin() defers the POST to the next microtask — waitFor
    // its arrival at the mock instead of sleeping.
    const req = await vi.waitFor(() =>
      httpMock.expectOne((r) => /\/auth\/login$/.test(r.url)),
    );
    expect(req.request.context.get(REQUEST_SCOPE)).toBe(
      RequestScope.Authentication,
    );
    expect(req.request.body.account).toBe('alice');
    // Headless browser test env → isTauri() false → client metadata is 'web'.
    expect(req.request.body.client).toBe('web');
    expect(req.request.body.trusted).toBeUndefined();
    expect(req.request.body.persistent).toBeUndefined();
    expect(typeof req.request.body.device).toBe('string');
    expect(req.request.body.device.length).toBeGreaterThan(0);

    req.flush({ code: 0, message: 'ok', data: { session_token: 'st-1' } });
    await done;
    expect(closeNotification).toHaveBeenCalledTimes(1);
    // Pure-httpOnly browser: the token lives in the (JS-unreadable) httpOnly cookie the backend set — JS
    // NEVER holds it (there is no sessionToken surface at all). Login state rides the non-httpOnly
    // `logged_in` presence cookie, which HttpTestingController doesn't set, so isLoggedIn() stays false
    // until we simulate the backend setting it.
    expect(svc.isLoggedIn()).toBe(false);
    document.cookie = 'logged_in=1; Path=/';
    expect(svc.isLoggedIn()).toBe(true);
  });

  it('actively aborts ordinary HTTP without success completion or auth bounce', () => {
    const error = vi.fn();
    const complete = vi.fn();
    const next = vi.fn();
    const bounce = vi.spyOn(svc, 'redoLoginAuth');
    TestBed.inject(HttpClient).get('/api/v1/data').subscribe({ error, complete, next });
    const request = httpMock.expectOne('/api/v1/data');
    TestBed.inject(AppDataLifetime).end();
    expect(request.cancelled).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.any(SessionSupersededError));
    expect(complete).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(bounce).not.toHaveBeenCalled();
  });

  it('actively unsubscribes a retry delay on runtime termination', () => {
    const stopped = vi.fn();
    const retry = TestBed.inject(HTTP_RETRY_CONFIG);
    vi.spyOn(retry, 'retryDelay').mockReturnValue(new Observable(() => stopped));
    const error = vi.fn();
    TestBed.inject(HttpClient).get('/api/v1/data').subscribe({ error });
    httpMock.expectOne('/api/v1/data').flush({ code: BusinessCode.RATE_LIMITED }, { status: 429, statusText: 'Limited' });
    expect(stopped).not.toHaveBeenCalled();
    TestBed.inject(AppDataLifetime).end();
    expect(stopped).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.any(SessionSupersededError));
    httpMock.expectNone('/api/v1/data');
  });

  it('cancels cleanup by its own bounded authority while app data is already ended', () => {
    TestBed.inject(AppDataLifetime).end();
    const owner = new AbortController();
    const authority = new LogoutRequestAuthority(owner.signal);
    const context = new HttpContext().set(REQUEST_SCOPE, RequestScope.Authentication).set(LOGOUT_REQUEST_AUTHORITY, authority);
    const error = vi.fn();
    const complete = vi.fn();
    TestBed.inject(HttpClient).post(`${apiPrefix()}/auth/logout`, {}, { context }).subscribe({ error, complete });
    const request = httpMock.expectOne(`${apiPrefix()}/auth/logout`);
    expect(request.cancelled).toBe(false);
    owner.abort();
    expect(request.cancelled).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.any(SessionSupersededError));
    expect(complete).not.toHaveBeenCalled();
  });

  it('permits only bounded logout cleanup, not ordinary authentication after runtime end', async () => {
    TestBed.inject(AppDataLifetime).end();
    const owner = new AbortController();
    const authority = new LogoutRequestAuthority(owner.signal);
    const context = new HttpContext()
      .set(REQUEST_SCOPE, RequestScope.Authentication)
      .set(LOGOUT_REQUEST_AUTHORITY, authority);
    const http = TestBed.inject(HttpClient);
    await expect(firstValueFrom(http.post(`${apiPrefix()}/auth/login`, {}, { context })))
      .rejects.toBeInstanceOf(SessionSupersededError);
    await expect(firstValueFrom(http.post(`${apiPrefix()}/auth/logout`, {}, {
      context: new HttpContext().set(REQUEST_SCOPE, RequestScope.Authentication),
    }))).rejects.toBeInstanceOf(SessionSupersededError);
    owner.abort();
    await expect(firstValueFrom(http.post(`${apiPrefix()}/auth/logout`, {}, { context })))
      .rejects.toBeInstanceOf(SessionSupersededError);
    httpMock.expectNone(() => true);
  });

  it('logout() resolves the session from the httpOnly cookie (no JS token to send) and clears the presence cookie', async () => {
    // Simulate a logged-in browser: the backend set the `logged_in` presence cookie at login; the session
    // token is JS-unreadable (httpOnly), so logout identifies the session via the cookie, not a JS-held token.
    document.cookie = 'logged_in=1; Path=/';
    expect(svc.isLoggedIn()).toBe(true);

    await TestBed.inject(BROWSER_SESSION)!.authenticate((signal) =>
      TestBed.inject(BROWSER_SESSION)!.activate(signal),
    );
    const done = firstValueFrom(svc.logout());
    expect(TestBed.inject(AppDataLifetime).signal.aborted).toBe(true);
    expect(TestBed.inject(WebPushService).unsubscribe).not.toHaveBeenCalled();
    const req = await vi.waitFor(() =>
      httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url)),
    );
    // The logout body carries NO token — JS never holds one. The backend resolves the session from the
    // httpOnly cookie (browser) / Bearer (native). No refresh token (single session-token model).
    expect(req.request.body.sessionToken).toBeUndefined();
    expect(req.request.body.refreshToken).toBeUndefined();
    req.flush({ code: 0, message: 'ok' });
    await done;
    expect(TestBed.inject(WebPushService).unsubscribe).toHaveBeenCalledOnce();
    expect(TestBed.inject(LogoutDecisionService).decide).not.toHaveBeenCalled();
    expect(TestBed.inject(RESTART_APP_DOCUMENT)).toHaveBeenCalledOnce();

    // Presence is cleared only after revocation and local cleanup finish.
    expect(svc.isLoggedIn()).toBe(false);
  });

  it('waits for explicit local-only consent after HTTP failure before unsubscribing', async () => {
    const browser = TestBed.inject(BROWSER_SESSION)!;
    await browser.authenticate((signal) => browser.activate(signal));
    document.cookie = 'logged_in=1; Path=/';
    let decide!: (choice: 'localOnly') => void;
    const decision = vi
      .spyOn(TestBed.inject(LogoutDecisionService), 'decide')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            decide = resolve;
          }),
      );
    const done = firstValueFrom(svc.logout());
    const duplicate = firstValueFrom(svc.logout());
    const req = await vi.waitFor(() =>
      httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url)),
    );
    req.flush({}, { status: 503, statusText: 'Service Unavailable' });
    await vi.waitFor(() => expect(decision).toHaveBeenCalledOnce());
    expect(decision).toHaveBeenCalledWith({
      status: 'httpFailure',
      status_code: 503,
    });
    expect(document.cookie).toContain('logged_in=1');
    expect(TestBed.inject(WebPushService).unsubscribe).not.toHaveBeenCalled();
    decide('localOnly');
    await Promise.all([done, duplicate]);
    expect(TestBed.inject(WebPushService).unsubscribe).toHaveBeenCalledOnce();
    expect(document.cookie).not.toContain('logged_in=1');
  });

  it('sends another revocation only after an explicit retry decision', async () => {
    const browser = TestBed.inject(BROWSER_SESSION)!;
    await browser.authenticate((signal) => browser.activate(signal));
    document.cookie = 'logged_in=1; Path=/';
    let decide!: (choice: 'retry') => void;
    const decision = vi
      .spyOn(TestBed.inject(LogoutDecisionService), 'decide')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            decide = resolve;
          }),
      );
    const done = firstValueFrom(svc.logout());
    const first = await vi.waitFor(() =>
      httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url)),
    );
    first.flush({}, { status: 503, statusText: 'Service Unavailable' });
    await vi.waitFor(() => expect(decision).toHaveBeenCalledOnce());
    httpMock.expectNone((r) => /\/auth\/logout$/.test(r.url));
    expect(TestBed.inject(WebPushService).unsubscribe).not.toHaveBeenCalled();
    decide('retry');
    const retry = await vi.waitFor(() =>
      httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url)),
    );
    retry.flush({ code: 0, message: 'ok' });
    await done;
    expect(decision).toHaveBeenCalledOnce();
    expect(TestBed.inject(WebPushService).unsubscribe).toHaveBeenCalledOnce();
    expect(document.cookie).not.toContain('logged_in=1');
  });

  it('waits for local handles to close before remote logout', async () => {
    document.cookie = 'logged_in=1; Path=/';
    await TestBed.inject(BROWSER_SESSION)!.authenticate((signal) =>
      TestBed.inject(BROWSER_SESSION)!.activate(signal),
    );
    let finishCacheClear!: () => void;
    const cacheClear = new Promise<void>((resolve) => {
      finishCacheClear = resolve;
    });
    vi.spyOn(TestBed.inject(WebdbService), 'close').mockReturnValueOnce(
      cacheClear,
    );
    const exited = vi.fn().mockName('exited');

    svc.logout().subscribe(exited);

    expect(exited).not.toHaveBeenCalled();
    httpMock.expectNone((request) => /\/auth\/logout$/.test(request.url));

    finishCacheClear();
    const request = await vi.waitFor(() =>
      httpMock.expectOne((request) => /\/auth\/logout$/.test(request.url)),
    );
    request.flush({ code: 0, message: 'ok' });
    await vi.waitFor(() => expect(exited).toHaveBeenCalledTimes(1));
    expect(svc.isLoggedIn()).toBe(false);
  });

  it('stays signed out and reports local resource release failure', async () => {
    document.cookie = 'logged_in=1; Path=/';
    await TestBed.inject(BROWSER_SESSION)!.authenticate((signal) =>
      TestBed.inject(BROWSER_SESSION)!.activate(signal),
    );
    vi.spyOn(TestBed.inject(WebdbService), 'close').mockRejectedValueOnce(
      new Error('cache busy'),
    );

    svc.logout().subscribe({ error: () => {} });
    await vi.waitFor(() =>
      expect(TestBed.inject(ToastService).warn).toHaveBeenCalled(),
    );

    // Failure before revocation must preserve the credential and avoid remote dispatch.
    expect(document.cookie).toContain('logged_in=1');
    httpMock.expectNone((request) => /\/auth\/logout$/.test(request.url));
  });

  it('clears local databases and stays signed out when local-cache initialization fails', async () => {
    await prepareTestSessionCache();
    document.cookie = 'logged_in=1; Path=/';
    const user = TestBed.inject(UserService) as unknown as {
      restoreWebdb: Mock;
    };
    user.restoreWebdb.mockRejectedValue(
      new DatabaseRestorationError(new Error('missing cache')),
    );
    const startup = TestBed.inject(SessionStartupService);
    void vi.waitFor(() => expect(startup.databaseFailure()).toBe('structural')).then(() =>
      startup.answerDatabase('rebuild'),
    );

    await svc.restoreSession();

    expect(TestBed.inject(RouteService).redirect).not.toHaveBeenCalled();
    httpMock.expectNone((request) => /\/auth\/logout$/.test(request.url));
    expect(document.cookie).not.toContain('logged_in=1');
    expect(svc.isLoggedIn()).toBe(false);
  });

  it.each(['login', 'logout'] as const)(
    'does not recover an old restore after %s takes ownership',
    async (action) => {
      await prepareTestSessionCache();
      document.cookie = 'logged_in=1; Path=/';
      let fail!: (error: Error) => void;
      vi.mocked(TestBed.inject(UserService).restoreWebdb).mockReturnValueOnce(
        new Promise((_, reject) => {
          fail = reject;
        }),
      );
      const restoring = svc.restoreSession();
      await vi.waitFor(() =>
        expect(TestBed.inject(UserService).restoreWebdb).toHaveBeenCalledOnce(),
      );
      const next =
        action === 'login'
          ? firstValueFrom(svc.login({ account: 'next', password: 'pw' }))
          : svc.clearToken();
      await Promise.resolve();
      fail(new Error('old cache read failed'));
      await restoring;
      if (action === 'login') {
        const req = await vi.waitFor(() =>
          httpMock.expectOne((r) => /auth\/login$/.test(r.url)),
        );
        document.cookie = 'logged_in=1; Path=/';
        req.flush({ code: 0, data: { session_token: 'next-token' } });
      }
      await next;
      expect(svc.isLoggedIn()).toBe(action === 'login');
      expect(TestBed.inject(BROWSER_SESSION)!.currentSession !== null).toBe(
        action === 'login',
      );
    },
  );

  it('revokeSession(id) sends { id } (by row id, not jti)', () => {
    svc.revokeSession(42).subscribe();
    const req = httpMock.expectOne((r) =>
      /\/auth\/revoke-session$/.test(r.url),
    );
    expect(req.request.body.id).toBe(42);
    req.flush({ code: 0, message: 'ok' });
  });

  it('preserves notifications and pending taps when restoring an existing session', async () => {
    await prepareTestSessionCache();
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
