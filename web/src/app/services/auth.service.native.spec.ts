import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
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
 * What this does NOT cover: the native backends themselves (the Rust keyring commands, Kotlin
 * EncryptedSharedPreferences) and real cross-restart persistence — those need a desktop build / APK smoke.
 */
describe('AuthService (native trusted-device storage, bridge-mock)', () => {
  // The navigator UA is saved for afterEach (the karma browser env has no Tauri/SomsFcm globals natively,
  // so those are simply removed to keep other suites seeing isTauri()=false).
  let originalUserAgent: string;

  let svc: AuthService;
  let httpMock: HttpTestingController;
  let invokeSpy: jasmine.Spy;
  // Spy on the toast so the keep-only keyring-write-failure test can assert the warn was surfaced.
  let toastWarn: jasmine.Spy;

  /** Permissive cast target for installing the Tauri/SomsFcm surfaces the runtime layer reads live. */
  type MockWindow = {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: { core: { invoke: jasmine.Spy } };
    SomsFcm?: { setSessionToken: jasmine.Spy; getSessionToken: jasmine.Spy };
  };

  /** Install the desktop-Tauri globals so isTauri()=true and tauriInvoke routes to invokeSpy. */
  function desktopGlobals(opts: { keyringToken?: string | null; secureSetOk?: boolean } = {}): void {
    const { keyringToken = null, secureSetOk = true } = opts;
    invokeSpy = jasmine.createSpy('invoke').and.callFake((cmd: string) => {
      if (cmd === 'secure_get_token') return Promise.resolve(keyringToken);
      if (cmd === 'secure_set_token') {
        return secureSetOk ? Promise.resolve(undefined) : Promise.reject(new Error('no secret service'));
      }
      return Promise.resolve(undefined); // set_session_token / clear_session_token / secure_clear_token
    });
    const w = window as unknown as MockWindow;
    w.__TAURI_INTERNALS__ = {};
    w.__TAURI__ = { core: { invoke: invokeSpy } };
  }

  /** Install the Android globals + UA so isAndroidNative()=true and the SomsFcm bridge is reachable. */
  function androidGlobals(storedToken: string | null): { set: jasmine.Spy; get: jasmine.Spy } {
    const set = jasmine.createSpy('setSessionToken');
    const get = jasmine.createSpy('getSessionToken').and.returnValue(storedToken);
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
      configurable: true,
    });
    const w = window as unknown as MockWindow;
    w.__TAURI_INTERNALS__ = {}; // isTauri() true; isAndroidNative() = isTauri() && UA has "Android"
    w.SomsFcm = { setSessionToken: set, getSessionToken: get };
    return { set, get };
  }

  /** Restore the process-wide globals/UA so the browser-path spec keeps seeing isTauri()=false. The karma
   *  browser env has none of these surfaces natively, so each is removed unconditionally. */
  function restoreGlobals(): void {
    const w = window as unknown as MockWindow;
    delete w.__TAURI_INTERNALS__;
    delete w.__TAURI__;
    delete w.SomsFcm;
    Object.defineProperty(navigator, 'userAgent', { value: originalUserAgent, configurable: true });
  }

  beforeEach(() => {
    originalUserAgent = navigator.userAgent;
    sessionStorage.clear();
    localStorage.clear();
    toastWarn = jasmine.createSpy('warn');

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        AuthService,
        // AuthService resolves i18n keys for its keyring-failure toasts; stub the translator (returns the key).
        { provide: TranslocoService, useValue: { translate: (k: string) => k } },
        { provide: ToastService, useValue: { warn: toastWarn, info: jasmine.createSpy('info') } },
        { provide: RouteService, useValue: { redirect: jasmine.createSpy('redirect'), openSettings: () => {} } },
        { provide: PushService, useValue: { onLogin: jasmine.createSpy('onLogin'), unregister: jasmine.createSpy('unregister') } },
        { provide: WebPushService, useValue: { onLogin: jasmine.createSpy('onLogin'), unregister: jasmine.createSpy('unregister') } },
        { provide: UserService, useValue: { clearSession: jasmine.createSpy('clearSession') } },
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

  /** Drive a password login with the given trust flag and flush the issued session token. */
  function passwordLogin(token: string, trustDevice: boolean): void {
    svc.login({ account: 'alice', password: 'pw', isKeep: trustDevice, trustDevice }).subscribe();
    httpMock
      .expectOne((r) => /\/auth\/login$/.test(r.url))
      .flush({ code: 0, message: 'ok', data: { session_token: token } });
  }

  describe('desktop (Tauri) keyring path', () => {
    it('a trusted login persists the token to the OS keyring and NEVER writes plaintext localStorage', () => {
      desktopGlobals({ secureSetOk: true });
      passwordLogin('st-trusted', /* trustDevice */ true);
      expect(svc.sessionToken).toBe('st-trusted');
      expect(invokeSpy).toHaveBeenCalledWith('secure_set_token', { token: 'st-trusted' });
      expect(localStorage.getItem('session_token')).toBeNull(); // no plaintext at rest
    });

    it('an untrusted desktop login keeps the token in memory only — no keyring write, no plaintext', () => {
      desktopGlobals();
      passwordLogin('st-mem', /* trustDevice */ false);
      expect(svc.sessionToken).toBe('st-mem'); // in-memory working copy
      expect(invokeSpy).not.toHaveBeenCalledWith('secure_set_token', jasmine.any(Object));
      expect(localStorage.getItem('session_token')).toBeNull();
    });

    it('a keep-but-untrusted desktop login (e.g. the register flow) STILL persists to the keyring', () => {
      // Mirrors register-page: isKeep true, trustDevice false → an untrusted (sliding) token that is STILL
      // persisted (survives restart). Persistence follows `keep`, not `trust`, so a freshly registered
      // desktop user is not logged out on every restart.
      desktopGlobals({ secureSetOk: true });
      svc.login({ account: 'newbie', password: 'pw', isKeep: true, trustDevice: false }).subscribe();
      httpMock
        .expectOne((r) => /\/auth\/login$/.test(r.url))
        .flush({ code: 0, message: 'ok', data: { session_token: 'st-keep' } });
      expect(svc.sessionToken).toBe('st-keep');
      expect(invokeSpy).toHaveBeenCalledWith('secure_set_token', { token: 'st-keep' });
      expect(localStorage.getItem('session_token')).toBeNull();
    });

    it('clearToken clears the keyring + the media-proxy in-memory copy', async () => {
      desktopGlobals();
      passwordLogin('st-x', true);
      await svc.clearToken();
      // Both commands take no args (tauriInvoke passes undefined): secure_clear_token idempotently drops
      // the keyring entry; clear_session_token drops the media-proxy's in-memory copy.
      expect(invokeSpy).toHaveBeenCalledWith('secure_clear_token', undefined);
      expect(invokeSpy).toHaveBeenCalledWith('clear_session_token', undefined);
      expect(svc.sessionToken).toBeNull();
    });

    it('clearToken resolves false when the keyring clear fails (so logout can surface a notice)', async () => {
      invokeSpy = jasmine.createSpy('invoke').and.callFake((cmd: string) =>
        cmd === 'secure_clear_token' ? Promise.reject(new Error('keyring locked')) : Promise.resolve(undefined),
      );
      const w = window as unknown as MockWindow;
      w.__TAURI_INTERNALS__ = {};
      w.__TAURI__ = { core: { invoke: invokeSpy } };
      const ok = await svc.clearToken();
      expect(ok).toBe(false);
      expect(svc.sessionToken).toBeNull();
    });

    it('a trusted login whose keyring write FAILS revokes the permanent token (no orphan) + notices + bounces', async () => {
      desktopGlobals({ secureSetOk: false }); // secure_set_token rejects
      passwordLogin('st-orphan', /* trustDevice */ true); // trusted → permanent token
      // The write-failure catch POSTs /auth/logout to revoke the orphan, then bounces to login.
      await new Promise((r) => setTimeout(r, 0)); // drain: rejecting write → async catch → revokeAndBounce
      const logoutReq = httpMock.expectOne((r) => /\/auth\/logout$/.test(r.url));
      expect(logoutReq.request.body.sessionToken).toBe('st-orphan');
      logoutReq.flush({ code: 0, message: 'ok' });
      await new Promise((r) => setTimeout(r, 0)); // drain: revokeAndBounce finish (clearToken + toast + redirect)
      expect(svc.sessionToken).toBeNull();
      // The bounce surfaces its reason as a global toast (longer duration), not the old per-page notice.
      expect(toastWarn).toHaveBeenCalledWith('auth.notice.trustPersistFailed', jasmine.any(Number));
    });

    it('a keep-only (untrusted) login whose keyring write FAILS warns via toast but does NOT revoke or bounce', async () => {
      desktopGlobals({ secureSetOk: false }); // secure_set_token rejects
      // Keep-but-untrusted (e.g. the register flow): isKeep true, trustDevice false → a SLIDING token that IS
      // persisted (so it survives restart) — but the keyring write fails, downgrading it to memory-only.
      svc.login({ account: 'newbie', password: 'pw', isKeep: true, trustDevice: false }).subscribe();
      httpMock
        .expectOne((r) => /\/auth\/login$/.test(r.url))
        .flush({ code: 0, message: 'ok', data: { session_token: 'st-keep' } });
      await new Promise((r) => setTimeout(r, 0)); // drain: rejecting write → catch → toast.warn

      // No orphan to revoke (sliding token self-expires in 14d) and no bounce (the session is valid
      // in-memory) → /auth/logout is NOT called and the user stays logged in. Just a warn toast.
      httpMock.expectNone((r) => /\/auth\/logout$/.test(r.url));
      expect(svc.sessionToken).toBe('st-keep');
      expect(svc.isLoggedIn()).toBe(true);
      expect(toastWarn).toHaveBeenCalledWith('auth.notice.keepPersistFailed');
    });

    it('restoreSession reads the token from the keyring, restores the session, and sets canTrust', async () => {
      desktopGlobals({ keyringToken: 'st-restored' });
      await svc.restoreSession();
      expect(svc.sessionToken).toBe('st-restored');
      expect(svc.isLoggedIn()).toBe(true);
      expect(svc.canTrust).toBe(true); // keyring reachable → device may be trusted
      expect(localStorage.getItem('session_token')).toBeNull();
    });

    it('restoreSession with an empty keyring leaves the user logged out but canTrust true (keyring works)', async () => {
      desktopGlobals({ keyringToken: null });
      await svc.restoreSession();
      expect(svc.sessionToken).toBeNull();
      expect(svc.isLoggedIn()).toBe(false);
      expect(svc.canTrust).toBe(true);
    });

    it('restoreSession PURGES a legacy plaintext localStorage token left by an older build', async () => {
      desktopGlobals({ keyringToken: null });
      localStorage.setItem('session_token', 'legacy-plaintext');
      await svc.restoreSession();
      expect(localStorage.getItem('session_token')).toBeNull();
    });

    it('restoreSession with an UNREACHABLE keyring sets canTrust false (toggle hidden → no orphan session)', async () => {
      // secure_get_token rejects → the boot probe fails → this desktop can't be trusted, so the trust
      // toggle stays hidden and the user can't request a permanent token the client then can't persist.
      invokeSpy = jasmine.createSpy('invoke').and.callFake((cmd: string) =>
        cmd === 'secure_get_token' ? Promise.reject(new Error('no secret service')) : Promise.resolve(undefined),
      );
      const w = window as unknown as MockWindow;
      w.__TAURI__ = { core: { invoke: invokeSpy } };
      await svc.restoreSession();
      expect(svc.canTrust).toBe(false);
      expect(svc.sessionToken).toBeNull();
    });
  });

  describe('Android EncryptedSharedPreferences path', () => {
    it('a login pushes the token to SomsFcm.setSessionToken and NEVER writes plaintext localStorage', () => {
      const { set } = androidGlobals(null);
      passwordLogin('st-android', true); // trustDevice is moot on Android (the app client is always trusted)
      expect(svc.sessionToken).toBe('st-android');
      expect(set).toHaveBeenCalledWith('st-android');
      expect(localStorage.getItem('session_token')).toBeNull();
    });

    it('restoreSession reads SomsFcm.getSessionToken → session restored + canTrust true', async () => {
      const { get } = androidGlobals('st-cold');
      await svc.restoreSession();
      expect(get).toHaveBeenCalledTimes(1);
      expect(svc.sessionToken).toBe('st-cold');
      expect(svc.isLoggedIn()).toBe(true);
      expect(svc.canTrust).toBe(true); // Android is always trusted
    });

    it('restoreSession with no stored token leaves the user logged out', async () => {
      androidGlobals(null);
      await svc.restoreSession();
      expect(svc.sessionToken).toBeNull();
      expect(svc.isLoggedIn()).toBe(false);
    });

    it('restoreSession survives a missing SomsFcm bridge (no APP_INITIALIZER rejection, canTrust false)', async () => {
      // The Android branch must not reject if the @JavascriptInterface wasn't injected (a shell wiring bug
      // or a renderer reclaim) — a rejection aborts bootstrap → a blank webview with no recovery.
      androidGlobals('st'); // sets UA Android + __TAURI_INTERNALS__
      delete (window as unknown as { SomsFcm?: unknown }).SomsFcm; // bridge missing
      // Awaiting must not throw — a rejection aborts the APP_INITIALIZER → a blank webview. (Jasmine's
      // typings lack .resolves, so the rejection-via-throw semantics ARE the assertion.)
      await svc.restoreSession();
      expect(svc.canTrust).toBe(false);
      expect(svc.sessionToken).toBeNull();
    });

    it('clearToken calls SomsFcm.setSessionToken(null)', async () => {
      const { set } = androidGlobals('st-y');
      passwordLogin('st-y', true);
      expect(await svc.clearToken()).toBe(true); // Android clear (sync JNI) succeeds
      expect(set).toHaveBeenCalledWith(null);
      expect(svc.sessionToken).toBeNull();
    });
  });
});
