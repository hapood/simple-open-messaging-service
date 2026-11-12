import { notificationDouble, registrationDouble, workerDouble } from './service-worker-test-doubles';
import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
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
import { SESSION_STORE_KEY } from './session/session-store';
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
    vi.spyOn(navigator.serviceWorker, 'getRegistration').mockResolvedValue(registrationDouble({
      scope: new URL('/push/', location.href).href,
      active: workerDouble((_message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
        const port = Array.isArray(transfer) ? transfer[0] : transfer?.transfer?.[0];
        if (port instanceof MessagePort) port.postMessage({ ok: true });
      }),
      getNotifications: async () => [
        notificationDouble('soms-thread-7', closeNotification),
      ],
    }));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        AuthService,
        { provide: LogoutDecisionService, useValue: { decide: vi.fn().mockResolvedValue('localOnly') } },
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
            clearSession: vi.fn().mockName('clearSession'),
            prepareFreshCache: vi.fn().mockName('prepareFreshCache'),
            sessionProfile: () => undefined,
            resetSessionState: vi.fn(),
            clearSessionPreferences: vi.fn().mockResolvedValue(undefined),
            restoreWebdb: vi
              .fn()
              .mockName('restoreWebdb')
              .mockResolvedValue(undefined),
          },
        },
      ],
    });
    await TestBed.inject(PreferenceStore).remove('device', SESSION_STORE_KEY);
    svc = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });
  afterEach(async () => {
    await TestBed.inject(WebdbService).close();
    for (const { name } of await indexedDB.databases()) {
      if (name?.startsWith('soms-session-')) await deleteDB(name);
    }
    await TestBed.inject(PreferenceStore).remove('device', SESSION_STORE_KEY);
    await TestBed.inject(PreferenceStore).close();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    // Clear any presence cookie a test set (document.cookie survives resetTestingModule).
    document.cookie = 'logged_in=; Max-Age=0; Path=/; SameSite=Strict';
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

  it('logout() resolves the session from the httpOnly cookie (no JS token to send) and clears the presence cookie', async () => {
    // Simulate a logged-in browser: the backend set the `logged_in` presence cookie at login; the session
    // token is JS-unreadable (httpOnly), so logout identifies the session via the cookie, not a JS-held token.
    document.cookie = 'logged_in=1; Path=/';
    expect(svc.isLoggedIn()).toBe(true);

    await TestBed.inject(BROWSER_SESSION)!.authenticate((signal) => TestBed.inject(BROWSER_SESSION)!.activate(signal));
    const done = firstValueFrom(svc.logout());
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

    // Presence is cleared only after revocation and local cleanup finish.
    expect(svc.isLoggedIn()).toBe(false);
  });

  it('waits for explicit local-only consent after HTTP failure before unsubscribing', async () => {
    const browser = TestBed.inject(BROWSER_SESSION)!;
    await browser.authenticate((signal) => browser.activate(signal));
    document.cookie = 'logged_in=1; Path=/';
    let decide!: (choice: 'localOnly') => void;
    const decision = vi.spyOn(TestBed.inject(LogoutDecisionService), 'decide')
      .mockImplementation(() => new Promise((resolve) => { decide = resolve; }));
    const done = firstValueFrom(svc.logout());
    const duplicate = firstValueFrom(svc.logout());
    const req = await vi.waitFor(() => httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url)));
    req.flush({}, { status: 503, statusText: 'Service Unavailable' });
    await vi.waitFor(() => expect(decision).toHaveBeenCalledOnce());
    expect(decision).toHaveBeenCalledWith({ status: 'httpFailure', status_code: 503 });
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
    const decision = vi.spyOn(TestBed.inject(LogoutDecisionService), 'decide')
      .mockImplementation(() => new Promise((resolve) => { decide = resolve; }));
    const done = firstValueFrom(svc.logout());
    const first = await vi.waitFor(() => httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url)));
    first.flush({}, { status: 503, statusText: 'Service Unavailable' });
    await vi.waitFor(() => expect(decision).toHaveBeenCalledOnce());
    httpMock.expectNone((r) => /\/auth\/logout$/.test(r.url));
    expect(TestBed.inject(WebPushService).unsubscribe).not.toHaveBeenCalled();
    decide('retry');
    const retry = await vi.waitFor(() => httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url)));
    retry.flush({ code: 0, message: 'ok' });
    await done;
    expect(decision).toHaveBeenCalledOnce();
    expect(TestBed.inject(WebPushService).unsubscribe).toHaveBeenCalledOnce();
    expect(document.cookie).not.toContain('logged_in=1');
  });

  it('invalidates immediately, releases handles, and never invokes legacy cache deletion', async () => {
    document.cookie = 'logged_in=1; Path=/';
    await TestBed.inject(BROWSER_SESSION)!.authenticate((signal) => TestBed.inject(BROWSER_SESSION)!.activate(signal));
    let finishCacheClear!: () => void;
    const cacheClear = new Promise<void>((resolve) => {
      finishCacheClear = resolve;
    });
    const user = TestBed.inject(UserService) as unknown as {
      clearSession: Mock;
    };
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
    expect(user.clearSession).not.toHaveBeenCalled();
  });

  it('stays signed out and reports local resource release failure', async () => {
    document.cookie = 'logged_in=1; Path=/';
    await TestBed.inject(BROWSER_SESSION)!.authenticate((signal) => TestBed.inject(BROWSER_SESSION)!.activate(signal));
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

  it('preserves the credential but blocks business admission when local-cache initialization fails', async () => {
    await prepareTestSessionCache();
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
    expect(svc.isLoggedIn()).toBe(false);
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
