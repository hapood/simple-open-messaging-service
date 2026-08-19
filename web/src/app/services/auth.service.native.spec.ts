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
 * AuthService NATIVE trusted-device storage — bridge-mock tests.
 *
 * The browser-path spec (auth.service.spec.ts) can't reach the native branches: isTauri() /
 * isAndroidNative() / tauriInvoke all read `window` globals at CALL time, so here we INSTALL those globals
 * (the Tauri IPC invoke, the Android SomsFcm bridge, the Android UA) and route them to spies. This verifies
 * the JS-side CONTRACT — each auth action reaches the RIGHT native backend with the right args, the trust
 * flag is plumbed, the boot keyring probe sets canTrust, and (the security invariant) NO plaintext
 * session_token is ever left in localStorage on a native client.
 *
 * The token is NEVER held in JS (there is no `sessionToken` surface): login/restore HAND it to Rust
 * (`set_session_token` → ProxyState.token, always under Tauri — both desktop AND Android, since both route
 * /api/v1 through the `api_request` IPC) / Kotlin (`SomsFcm`) / the OS keyring, then drop it. Login state
 * in JS is the `loggedIn` boolean signal.
 *
 * What this does NOT cover: the native backends themselves (the Rust keyring commands, Kotlin
 * EncryptedSharedPreferences) and real cross-restart persistence — those need a desktop build / APK smoke.
 */
describe('AuthService (native trusted-device storage, bridge-mock)', () => {
  // The navigator UA is saved for afterEach (the test environment has no Tauri/SomsFcm globals natively,
  // so those are simply removed to keep other suites seeing isTauri()=false).
  let originalUserAgent: string;

  let svc: AuthService;
  let httpMock: HttpTestingController;
  let invokeSpy: Mock;
  // Spy on the toast so the keep-only keyring-write-failure test can assert the warn was surfaced.
  let toastWarn: Mock;

  /** Permissive cast target for installing the Tauri/SomsFcm surfaces the runtime layer reads live. */
  type MockWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: {
      core: {
        invoke: Mock;
      };
    };
    SomsFcm?: {
      setSessionToken: Mock;
      getSessionToken: Mock;
      pickActiveOrigin: Mock;
    };
  };

  /** Build an invoke spy that resolves the given commands per `opts` and resolves everything else. */
  function makeInvokeSpy(
    opts: {
      keyringToken?: string | null;
      secureSetOk?: boolean;
      secureClearOk?: boolean;
      secureGetOk?: boolean;
    } = {},
  ): Mock {
    const {
      keyringToken = null,
      secureSetOk = true,
      secureClearOk = true,
      secureGetOk = true,
    } = opts;
    return vi
      .fn()
      .mockName('invoke')
      .mockImplementation((cmd: string) => {
        if (cmd === 'secure_get_token')
          return secureGetOk
            ? Promise.resolve(keyringToken)
            : Promise.reject(new Error('no secret service'));
        if (cmd === 'secure_set_token')
          return secureSetOk
            ? Promise.resolve(undefined)
            : Promise.reject(new Error('no secret service'));
        if (cmd === 'secure_clear_token')
          return secureClearOk
            ? Promise.resolve(undefined)
            : Promise.reject(new Error('keyring locked'));
        return Promise.resolve(undefined); // set_session_token / clear_session_token
      });
  }

  /** Install the desktop-Tauri globals so isTauri()=true and tauriInvoke routes to invokeSpy. */
  function desktopGlobals(
    opts: {
      keyringToken?: string | null;
      secureSetOk?: boolean;
      secureClearOk?: boolean;
      secureGetOk?: boolean;
    } = {},
  ): void {
    invokeSpy = makeInvokeSpy(opts);
    const w = window as unknown as MockWindow;
    w.__TAURI_INTERNALS__ = {};
    w.__TAURI__ = { core: { invoke: invokeSpy } };
  }

  /** Install the Android globals + UA so isAndroidNative()=true and the SomsFcm bridge is reachable. Also
   *  installs `__TAURI__.core.invoke` (Android now reaches `set_session_token` / `clear_session_token`). */
  function androidGlobals(storedToken: string | null): {
    set: Mock;
    get: Mock;
    pick: Mock;
  } {
    invokeSpy = makeInvokeSpy();
    const set = vi.fn().mockName('setSessionToken');
    const get = vi
      .fn()
      .mockName('getSessionToken')
      .mockReturnValue(storedToken);
    const pick = vi
      .fn()
      .mockName('pickActiveOrigin')
      .mockReturnValue('http://lan.test');
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
      configurable: true,
    });
    const w = window as unknown as MockWindow;
    w.__TAURI_INTERNALS__ = {}; // isTauri() true; isAndroidNative() = isTauri() && UA has "Android"
    w.__TAURI__ = { core: { invoke: invokeSpy } };
    w.SomsFcm = {
      setSessionToken: set,
      getSessionToken: get,
      pickActiveOrigin: pick,
    };
    return { set, get, pick };
  }

  /** Restore the process-wide globals/UA so the browser-path spec keeps seeing isTauri()=false. The test
   *  browser env has none of these surfaces natively, so each is removed unconditionally. */
  function restoreGlobals(): void {
    const w = window as unknown as MockWindow;
    delete w.__TAURI_INTERNALS__;
    delete w.__TAURI__;
    delete w.SomsFcm;
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    });
  }

  /** Drain pending microtasks (activateSession awaits `set_session_token` before flipping the login flag). */
  function drain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    originalUserAgent = navigator.userAgent;
    sessionStorage.clear();
    localStorage.clear();
    toastWarn = vi.fn().mockName('warn');

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        AuthService,
        // AuthService resolves i18n keys for its keyring-failure toasts; stub the translator (returns the key).
        {
          provide: TranslocoService,
          useValue: { translate: (k: string) => k },
        },
        {
          provide: ToastService,
          useValue: { warn: toastWarn, info: vi.fn().mockName('info') },
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
        // restoreSession() now awaits userService.restoreWebdb() (opens the per-user IDB before the router
        // resolves) — stub it as an async no-op. The IDB restore itself is covered by webdb/thread-store specs.
        {
          provide: UserService,
          useValue: {
            clearSession: vi
              .fn()
              .mockName('clearSession')
              .mockResolvedValue(undefined),
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
    restoreGlobals();
    sessionStorage.clear();
    localStorage.clear();
  });

  /** Drive a password login with the given trust flag, flush the issued token, and drain activateSession
   *  (it awaits `set_session_token` before the login flag flips). */
  async function passwordLogin(token: string): Promise<void> {
    svc
      .login({
        account: 'alice',
        password: 'pw',
      })
      .subscribe();
    // login() runs through pickThen = `defer(() => pickLoginOrigin()).pipe(mergeMap(...))` — on the Tauri
    // path pickLoginOrigin awaits the native origin selection, so the POST fires
    // on the next microtask, NOT synchronously. Drain once so the request is pending before expectOne.
    await drain();
    httpMock
      .expectOne((r) => /\/auth\/login$/.test(r.url))
      .flush({ code: 0, message: 'ok', data: { session_token: token } });
    await drain();
  }

  describe('desktop (Tauri) keyring path', () => {
    it('a trusted login pushes the token to ProxyState + the keyring and NEVER writes plaintext localStorage', async () => {
      desktopGlobals({ secureSetOk: true });
      await passwordLogin('st-trusted');
      expect(svc.loggedIn()).toBe(true);
      // Always under Tauri: set_session_token (ProxyState.token, so api_request injects the Bearer).
      expect(invokeSpy).toHaveBeenCalledWith('set_session_token', {
        token: 'st-trusted',
      });
      // Trusted → persisted to the OS keyring.
      expect(invokeSpy).toHaveBeenCalledWith('secure_set_token', {
        token: 'st-trusted',
      });
      expect(localStorage.getItem('session_token')).toBeNull(); // no plaintext at rest
    });

    it('every desktop login persists to the keyring without plaintext storage', async () => {
      desktopGlobals();
      await passwordLogin('st-mem');
      expect(svc.loggedIn()).toBe(true);
      expect(invokeSpy).toHaveBeenCalledWith('set_session_token', {
        token: 'st-mem',
      });
      expect(invokeSpy).toHaveBeenCalledWith('secure_set_token', {
        token: 'st-mem',
      });
      expect(localStorage.getItem('session_token')).toBeNull();
    });

    it('a keep-but-untrusted desktop login (e.g. the register flow) STILL persists to the keyring', async () => {
      // Mirrors register-page: isKeep true, trustDevice false → an untrusted (sliding) token that is STILL
      // persisted (survives restart). Persistence follows `keep`, not `trust`, so a freshly registered
      // desktop user is not logged out on every restart.
      desktopGlobals({ secureSetOk: true });
      svc
        .login({
          account: 'newbie',
          password: 'pw',
        })
        .subscribe();
      await drain(); // login() runs through pickThen → the POST fires on the next microtask, not synchronously
      httpMock
        .expectOne((r) => /\/auth\/login$/.test(r.url))
        .flush({ code: 0, message: 'ok', data: { session_token: 'st-keep' } });
      await drain();
      expect(svc.loggedIn()).toBe(true);
      expect(invokeSpy).toHaveBeenCalledWith('set_session_token', {
        token: 'st-keep',
      });
      expect(invokeSpy).toHaveBeenCalledWith('secure_set_token', {
        token: 'st-keep',
      });
      expect(localStorage.getItem('session_token')).toBeNull();
    });

    it('clearToken clears the keyring + ProxyState.token + the login flag', async () => {
      desktopGlobals();
      await passwordLogin('st-x');
      await svc.clearToken();
      // secure_clear_token idempotently drops the keyring entry; clear_session_token drops ProxyState.token.
      expect(invokeSpy).toHaveBeenCalledWith('secure_clear_token', undefined);
      expect(invokeSpy).toHaveBeenCalledWith('clear_session_token', undefined);
      expect(svc.loggedIn()).toBe(false);
    });

    it('clearToken resolves false when the keyring clear fails (so logout can surface a notice)', async () => {
      desktopGlobals({ secureClearOk: false });
      const ok = await svc.clearToken();
      expect(ok).toBe(false);
      expect(svc.loggedIn()).toBe(false);
    });

    it('logout detaches the native token with begin_logout and does not issue a JS HTTP revoke', async () => {
      desktopGlobals();
      await passwordLogin('st-logout');

      svc.logout().subscribe();
      await drain();

      expect(svc.loggedIn()).toBe(false);
      expect(invokeSpy).toHaveBeenCalledWith('begin_logout', {
        origin: '',
      });
      httpMock.expectNone((r) => /\/auth\/logout$/.test(r.url));
    });

    it('a keep-only (untrusted) login whose keyring write FAILS warns via toast but does NOT revoke or bounce', async () => {
      desktopGlobals({ secureSetOk: false }); // secure_set_token rejects
      // Keep-but-untrusted (e.g. the register flow): isKeep true, trustDevice false → a SLIDING token that IS
      // persisted (so it survives restart) — but the keyring write fails, downgrading it to memory-only.
      svc
        .login({
          account: 'newbie',
          password: 'pw',
        })
        .subscribe();
      await drain(); // login() runs through pickThen → the POST fires on the next microtask, not synchronously
      httpMock
        .expectOne((r) => /\/auth\/login$/.test(r.url))
        .flush({ code: 0, message: 'ok', data: { session_token: 'st-keep' } });
      await drain(); // rejecting write → catch → toast.warn

      // No orphan to revoke (sliding token self-expires in 14d) and no bounce (the session is valid
      // in-memory) → /auth/logout is NOT called and the user stays logged in. Just a warn toast.
      httpMock.expectNone((r) => /\/auth\/logout$/.test(r.url));
      expect(svc.loggedIn()).toBe(true);
      expect(svc.isLoggedIn()).toBe(true);
      expect(toastWarn).toHaveBeenCalledWith('auth.notice.keepPersistFailed');
    });

    it('restoreSession reads the token from the keyring, pushes it to ProxyState, restores the session, sets canTrust', async () => {
      desktopGlobals({ keyringToken: 'st-restored' });
      await svc.restoreSession();
      expect(svc.loggedIn()).toBe(true);
      expect(svc.isLoggedIn()).toBe(true);
      expect(invokeSpy).toHaveBeenCalledWith('set_session_token', {
        token: 'st-restored',
      });
      expect(localStorage.getItem('session_token')).toBeNull();
    });

    it('restoreSession with an empty keyring leaves the user logged out but canTrust true (keyring works)', async () => {
      desktopGlobals({ keyringToken: null });
      await svc.restoreSession();
      expect(svc.loggedIn()).toBe(false);
      expect(svc.isLoggedIn()).toBe(false);
    });

    it('restoreSession with an UNREACHABLE keyring sets canTrust false (toggle hidden → no orphan session)', async () => {
      // secure_get_token rejects → the boot probe fails → this desktop can't be trusted, so the trust
      // toggle stays hidden and the user can't request a permanent token the client then can't persist.
      desktopGlobals({ secureGetOk: false });
      await svc.restoreSession();
      expect(svc.loggedIn()).toBe(false);
    });
  });

  describe('Android EncryptedSharedPreferences path', () => {
    it('a login pushes the token to SomsFcm AND ProxyState and NEVER writes plaintext localStorage', async () => {
      const { set } = androidGlobals(null);
      await passwordLogin('st-android');
      expect(svc.loggedIn()).toBe(true);
      expect(set).toHaveBeenCalledWith('st-android');
      // Android now ALSO reaches set_session_token (ProxyState.token) — api_request runs on Android too.
      expect(invokeSpy).toHaveBeenCalledWith('set_session_token', {
        token: 'st-android',
      });
      expect(localStorage.getItem('session_token')).toBeNull();
    });

    it('restoreSession reads SomsFcm.getSessionToken → session restored + canTrust true', async () => {
      const { get } = androidGlobals('st-cold');
      await svc.restoreSession();
      expect(get).toHaveBeenCalledTimes(1);
      expect(svc.loggedIn()).toBe(true);
      expect(svc.isLoggedIn()).toBe(true);
    });

    it('restoreSession with no stored token leaves the user logged out', async () => {
      const { pick } = androidGlobals(null);
      await svc.restoreSession();
      expect(pick).toHaveBeenCalledTimes(1);
      expect(invokeSpy).toHaveBeenCalledWith('set_active_origin', {
        url: 'http://lan.test',
      });
      expect(invokeSpy).not.toHaveBeenCalledWith('init_pick_origin', undefined);
      expect(svc.loggedIn()).toBe(false);
      expect(svc.isLoggedIn()).toBe(false);
    });

    it('restoreSession survives a missing SomsFcm bridge (no APP_INITIALIZER rejection, canTrust false)', async () => {
      // The Android branch must not reject if the @JavascriptInterface wasn't injected (a shell wiring bug
      // or a renderer reclaim) — a rejection aborts bootstrap → a blank webview with no recovery.
      androidGlobals('st'); // sets UA Android + __TAURI_INTERNALS__
      delete (
        window as unknown as {
          SomsFcm?: unknown;
        }
      ).SomsFcm; // bridge missing
      // Awaiting must not throw — a rejection aborts the APP_INITIALIZER → a blank webview.
      await svc.restoreSession();
      expect(svc.loggedIn()).toBe(false);
    });

    it('clearToken calls SomsFcm.setSessionToken(null) + clears ProxyState.token', async () => {
      const { set } = androidGlobals('st-y');
      await passwordLogin('st-y');
      expect(await svc.clearToken()).toBe(true); // Android clear (SomsFcm sync JNI + clear_session_token) succeeds
      expect(set).toHaveBeenCalledWith(null);
      expect(invokeSpy).toHaveBeenCalledWith('clear_session_token', undefined);
      expect(svc.loggedIn()).toBe(false);
    });

    it('logout clears the Android secure token before beginning the captured native revoke', async () => {
      const { set } = androidGlobals('st-logout');
      await passwordLogin('st-logout');

      svc.logout().subscribe();
      await drain();

      expect(set).toHaveBeenCalledWith(null);
      expect(invokeSpy).toHaveBeenCalledWith('begin_logout', {
        origin: '',
      });
      expect(svc.loggedIn()).toBe(false);
    });
  });
});
