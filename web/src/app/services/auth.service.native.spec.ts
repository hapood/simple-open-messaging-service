import '@angular/compiler';
import 'fake-indexeddb/auto';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { AuthService } from './auth.service';
import { RouteService } from './route.service';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';
import { ToastService } from './toast.service';
import { BROWSER_SESSION } from './browser-session.service';

/**
 * AuthService NATIVE trusted-device storage — bridge-mock tests.
 *
 * The browser-path spec (auth.service.spec.ts) can't reach the native branches: isTauri() /
 * isAndroidNative() / tauriInvoke all read `window` globals at CALL time, so here we INSTALL those globals
 * (the Tauri IPC invoke, the Android SomsFcm bridge, the Android UA) and route them to spies. This verifies
 * the JS-side CONTRACT — each auth action reaches the RIGHT native backend with the right args, the trust
 * flag is plumbed, the boot keyring probe sets canTrust, and session tokens only reach the platform's
 * secure persistence and in-memory request transport.
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
      clearMessageNotifications: Mock;
    };
  };

  /** Model the registered IPC commands explicitly; unknown commands must not silently succeed. */
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
        if (cmd === 'native_db_begin_login')
          return Promise.resolve('11111111-2222-4d9e-af01-234567890abc');
        if (cmd === 'login_session_for_token')
          return Promise.resolve(
            keyringToken ? '22222222-3333-4444-8555-666666666666' : null,
          );
        if (cmd === 'begin_logout')
          return Promise.resolve({
            ticket: 'logout-operation',
            localClearFailed: !secureClearOk,
          });
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
        if (cmd === 'init_pick_origin')
          return Promise.resolve('https://native.example.test');
        if (
          [
            'set_session_token',
            'clear_session_token',
            'set_active_origin',
            'native_db_validate_cache',
            'native_db_recreate_cache',
            'desktop_notifications_clear',
            'wait_for_logout',
          ].includes(cmd)
        )
          return Promise.resolve(undefined);
        return Promise.reject(
          new Error(`Unexpected native IPC command: ${cmd}`),
        );
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
    clear: Mock;
  } {
    invokeSpy = makeInvokeSpy({ keyringToken: storedToken });
    const set = vi.fn().mockName('setSessionToken');
    const clear = vi.fn().mockName('clearMessageNotifications');
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
      clearMessageNotifications: clear,
    };
    return { set, get, pick, clear };
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

  /** The POST arrives on the next microtask (pickLoginOrigin defers it) — waitFor its arrival at
   *  the mock instead of sleeping, then answer it. */
  function loginRequest() {
    return vi.waitFor(() =>
      httpMock.expectOne((r) => /\/auth\/login$/.test(r.url)),
    );
  }

  beforeEach(() => {
    originalUserAgent = navigator.userAgent;
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
          },
        },
        {
          provide: WebPushService,
          useValue: {
            onLogin: vi.fn().mockName('onLogin'),
          },
        },
        // restoreSession() now awaits userService.restoreWebdb() (opens the per-user IDB before the router
        // resolves) — stub it as an async no-op. The IDB restore itself is covered by webdb/thread-store specs.
        {
          provide: BROWSER_SESSION,
          useValue: null,
        },
        {
          provide: UserService,
          useValue: {
            releaseSession: vi
              .fn()
              .mockName('releaseSession')
              .mockResolvedValue(undefined),
            prepareFreshCache: vi.fn().mockName('prepareFreshCache'),
            clearSessionPreferences: vi.fn().mockResolvedValue(undefined),
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
  });

  /** Drive a password login with the given trust flag and await full activation: login() awaits
   *  activateSession BEFORE its observable emits (so ProxyState.token is populated first), making
   *  the emitted promise the deterministic whole-chain completion signal. */
  async function passwordLogin(token: string): Promise<void> {
    const done = firstValueFrom(
      svc.login({
        account: 'alice',
        password: 'pw',
      }),
    );
    (await loginRequest()).flush({
      code: 0,
      message: 'ok',
      data: { session_token: token },
    });
    await done;
  }

  describe('desktop (Tauri) keyring path', () => {
    it('clears message notifications on login but not on cold session restoration', async () => {
      desktopGlobals({ keyringToken: 'st-restored' });
      await svc.restoreSession();
      expect(
        invokeSpy.mock.calls.some(
          ([command]) => command === 'desktop_notifications_clear',
        ),
      ).toBe(false);
      await passwordLogin('st-new');
      expect(invokeSpy).toHaveBeenCalledWith('desktop_notifications_clear', {
        resetNavigation: true,
      });
      const commands = invokeSpy.mock.calls.map(([command]) => command);
      // Fresh-login cleanup moved BEFORE the authentication request; the post-auth recreation is gone.
      expect(commands).toContain('native_db_begin_login');
      expect(commands.indexOf('native_db_begin_login')).toBeLessThan(
        commands.indexOf('desktop_notifications_clear'),
      );
      expect(commands).not.toContain('native_db_recreate_cache');
    });
    it('a trusted login pushes the token to ProxyState and the keyring', async () => {
      desktopGlobals({ secureSetOk: true });
      await passwordLogin('st-trusted');
      expect(svc.loggedIn()).toBe(true);
      expect(
        invokeSpy.mock.calls.filter(
          ([command]) => command === 'set_session_token',
        ),
      ).toHaveLength(1);
      // Always under Tauri: set_session_token (ProxyState.token, so api_request injects the Bearer).
      expect(invokeSpy).toHaveBeenCalledWith('set_session_token', {
        token: 'st-trusted',
        sessionUuid: '11111111-2222-4d9e-af01-234567890abc',
      });
      // Trusted → persisted to the OS keyring.
      expect(invokeSpy).toHaveBeenCalledWith('secure_set_token', {
        token: 'st-trusted',
      });
    });

    it('every desktop login persists to the keyring without plaintext storage', async () => {
      desktopGlobals();
      await passwordLogin('st-mem');
      expect(svc.loggedIn()).toBe(true);
      expect(invokeSpy).toHaveBeenCalledWith('set_session_token', {
        token: 'st-mem',
        sessionUuid: '11111111-2222-4d9e-af01-234567890abc',
      });
      expect(invokeSpy).toHaveBeenCalledWith('secure_set_token', {
        token: 'st-mem',
      });
    });

    it('a keep-but-untrusted desktop login (e.g. the register flow) STILL persists to the keyring', async () => {
      // Mirrors register-page: isKeep true, trustDevice false → an untrusted (sliding) token that is STILL
      // persisted (survives restart). Persistence follows `keep`, not `trust`, so a freshly registered
      // desktop user is not logged out on every restart.
      desktopGlobals({ secureSetOk: true });
      const done = firstValueFrom(
        svc.login({
          account: 'newbie',
          password: 'pw',
        }),
      );
      (await loginRequest()).flush({
        code: 0,
        message: 'ok',
        data: { session_token: 'st-keep' },
      });
      await done;
      expect(svc.loggedIn()).toBe(true);
      expect(invokeSpy).toHaveBeenCalledWith('set_session_token', {
        token: 'st-keep',
        sessionUuid: '11111111-2222-4d9e-af01-234567890abc',
      });
      expect(invokeSpy).toHaveBeenCalledWith('secure_set_token', {
        token: 'st-keep',
      });
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
      invokeSpy.mockClear();

      // Completion waits for resource release and the Rust-owned bounded revoke.
      await firstValueFrom(svc.logout());

      expect(svc.loggedIn()).toBe(false);
      expect(invokeSpy).toHaveBeenCalledWith('desktop_notifications_clear', {
        resetNavigation: true,
      });
      const commands = invokeSpy.mock.calls.map(([command]) => command);
      expect(commands.indexOf('begin_logout')).toBeLessThan(
        commands.indexOf('desktop_notifications_clear'),
      );
      expect(invokeSpy).toHaveBeenCalledWith('wait_for_logout', {
        ticket: 'logout-operation',
      });
      expect(invokeSpy).toHaveBeenCalledWith('begin_logout', {
        origin: '',
        sessionUuid: '11111111-2222-4d9e-af01-234567890abc',
      });
      httpMock.expectNone((r) => /\/auth\/logout$/.test(r.url));
    });

    it('a keep-only (untrusted) login whose keyring write FAILS warns via toast but does NOT revoke or bounce', async () => {
      desktopGlobals({ secureSetOk: false }); // secure_set_token rejects
      // Keep-but-untrusted (e.g. the register flow): isKeep true, trustDevice false → a SLIDING token that IS
      // persisted (so it survives restart) — but the keyring write fails, downgrading it to memory-only.
      const done = firstValueFrom(
        svc.login({
          account: 'newbie',
          password: 'pw',
        }),
      );
      (await loginRequest()).flush({
        code: 0,
        message: 'ok',
        data: { session_token: 'st-keep' },
      });
      // The rejecting keyring write is caught inside activateSession (warn → toast), so login
      // still emits — `done` covers the whole failure-handling path too.
      await done;

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
        sessionUuid: '22222222-3333-4444-8555-666666666666',
      });
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
    it('a login pushes the token to SomsFcm and ProxyState', async () => {
      const { set, clear } = androidGlobals(null);
      await passwordLogin('st-android');
      expect(svc.loggedIn()).toBe(true);
      expect(set).toHaveBeenCalledWith('st-android');
      expect(clear).toHaveBeenCalledExactlyOnceWith();
      // Android now ALSO reaches set_session_token (ProxyState.token) — api_request runs on Android too.
      expect(invokeSpy).toHaveBeenCalledWith('set_session_token', {
        token: 'st-android',
        sessionUuid: '11111111-2222-4d9e-af01-234567890abc',
      });
    });

    it('a residual credential whose login was ended locally is discarded, never restored', async () => {
      const { set } = androidGlobals('st-dead');
      invokeSpy.mockImplementation((cmd: string) =>
        cmd === 'login_session_for_token'
          ? Promise.resolve(null)
          : Promise.resolve(undefined),
      );
      await svc.restoreSession();
      expect(set).toHaveBeenCalledExactlyOnceWith(null);
      expect(svc.loggedIn()).toBe(false);
      expect(svc.isLoggedIn()).toBe(false);
      expect(
        invokeSpy.mock.calls.some(
          ([command]) => command === 'set_session_token',
        ),
      ).toBe(false);
    });

    it('restoreSession reads SomsFcm.getSessionToken → session restored + canTrust true', async () => {
      const { get, clear } = androidGlobals('st-cold');
      await svc.restoreSession();
      expect(get).toHaveBeenCalledTimes(1);
      expect(clear).not.toHaveBeenCalled();
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

    it('logout clears the Android secure token after Rust captures it for revocation', async () => {
      const { set } = androidGlobals('st-logout');
      await passwordLogin('st-logout');

      // Rust must acknowledge capture before the adapter clears both native token copies.
      await firstValueFrom(svc.logout());

      expect(set).toHaveBeenCalledWith(null);
      expect(invokeSpy).toHaveBeenCalledWith('begin_logout', {
        origin: '',
        sessionUuid: '11111111-2222-4d9e-af01-234567890abc',
      });
      expect(svc.loggedIn()).toBe(false);
    });
  });
});
