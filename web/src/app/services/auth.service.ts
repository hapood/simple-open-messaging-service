import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import {
  EMPTY,
  Observable,
  defer,
  firstValueFrom,
  from,
  mergeMap,
  tap,
} from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { RouteService, RoutePage } from './route.service';
import { apiPrefix } from './constants';
import {
  apiOrigin,
  isTauri,
  isAndroidNative,
  tauriInvoke,
  sessionClient,
  pickLoginOrigin,
} from './runtime';
import {
  REQUEST_SCOPE,
  RequestScope,
  SUPPRESS_HTTP_ERROR_TOAST,
} from '../request-context';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';
import { ToastService } from './toast.service';
import { CALL_SESSION_ENDING_EVENT } from './web-call.adapter';
import { ThreadSendOutbox } from './thread-send-outbox.service';

import { SessionStateService } from './session-state.service';
import { BROWSER_SESSION } from './browser-session.service';
import { sessionRequest } from './session/session-request';
import {
  SessionSupersededError,
  parseLoginSessionId,
  type LoginSessionId,
} from './session/session-identity';
import {
  SessionLifecycleService,
  type SessionWorkScope,
} from './session-lifecycle.service';

/** On-screen duration (ms) for important auth notices (forced-logout / persist-failure) — longer than the
 *  default toast so a user looking away still catches why they're back at the sign-in screen. */
const IMPORTANT_NOTICE_MS = 6000;

import { clearSessionNotifications } from './notification-session';

type LoginRes = {
  code: number;
  message: string;
  data?: { session_token?: string; mustChangePassword?: boolean };
};
type LogoutRes = { code: number; message: string };
type NativeAuthentication = Readonly<{
  host: 'native';
  id: LoginSessionId;
  work: SessionWorkScope;
}>;
type Authentication =
  | NativeAuthentication
  | Readonly<{
      host: 'browser';
      signal: AbortSignal;
    }>;

/**
 * One opaque per-device session token authenticates every request — carried as an httpOnly cookie
 * (browser: auto-attached same-origin, JS-unreadable) or an `Authorization: Bearer` header (native). The
 * backend accepts cookie-or-Bearer on every route. No access JWT, no refresh token, no renewal. Issued at
 * login; revoked at logout / logout-all / change-password (`invalidateAllSessions`); a 401 → re-login
 * (`redoLoginAuth`).
 *
 * **JS DOES NOT HOLD THE TOKEN.** The login response brings the token into JS for exactly long enough to
 * hand it to Rust (the `set_session_token` IPC command → `ProxyState.token`) / Kotlin (`SomsFcm`) / the OS
 * keyring; it is never stored in a field, never read back, and never placed on the wire. Under the Tauri
 * shell the Rust `api_request` / `media_request` transports inject the Bearer from `ProxyState.token`, so
 * no JS code touches the credential after login. Login state in JS is a BOOLEAN (`loggedIn` signal on
 * native, the `logged_in` presence cookie on browser) — never the token value.
 *
 * **Storage (no persistent plaintext copy on any platform):**
 *  - Browser (pure httpOnly): the token is NEVER held in JS — XSS can't exfiltrate it. Login state rides
 *    the non-httpOnly `logged_in` presence cookie (`document.cookie`). "Keep me logged in" maps to the
 *    cookie lifetime (14-day sliding vs session) via the login `persistent` flag; the httpOnly cookie can
 *    only be cleared by the backend (logout).
 *  - Android: the raw token lives in EncryptedSharedPreferences (Android-Keystore-backed), read/written
 *    via the `SomsFcm` bridge — the SAME store the native RealtimeService/FCM/Worker read. It is ALSO
 *    pushed to Rust's `ProxyState.token` (via `set_session_token`) so the `api_request` IPC transport can
 *    inject the Bearer. No plaintext JS copy.
 *  - Desktop (Tauri): a TRUSTED device persists the token in the OS credential store (Windows Credential
 *    Manager / macOS Keychain / Linux Secret Service) via the `secure_*` Tauri commands; an UNTRUSTED
 *    device keeps it in memory only (lost on restart → re-login). Either way `ProxyState.token` (via
 *    `set_session_token`) holds the in-memory copy for `api_request` Bearer injection. No plaintext copy.
 */
@Injectable({
  providedIn: 'root',
})
export class AuthService {
  /** Whether this session's token is durable — kept in OS secure storage (Android EncryptedSharedPreferences,
   *  or the desktop OS keyring) and therefore server-issued as permanent (revocation-only). False on web
   *  (cookie-only) and on an untrusted desktop (memory-only, sliding). */
  /** Whether THIS client is capable of being a trusted device — i.e. it has a working OS secure store
   *  (Android EncryptedSharedPreferences always; the desktop OS keyring when a boot-time probe reaches it;
   *  never on web). Gates the "Trust this device" toggle so a desktop without a usable keyring can't request
   *  a permanent token it then can't persist (which would orphan a server-side permanent session). */
  /** True when this client has a working OS secure store and may therefore be trusted (hold a permanent
   *  token). Probed once at boot by {@link restoreSession}. */
  /** Reactive login state — true while a session is active. Drives the realtime transport's
   *  connect/disconnect lifecycle (SseLifecycleService) + the auth guards. On native this is
   *  the single source of truth for login (the token value is never held in JS); on browser it mirrors the
   *  non-httpOnly `logged_in` presence cookie (the session credential itself is JS-unreadable). Initialized
   *  from the cookie on browser so a page refresh while signed in starts `true`; native starts `false` and
   *  {@link restoreSession} flips it after re-establishing the session from secure storage. */
  private readonly sessionState = inject(SessionStateService);
  private readonly browserSession = inject(BROWSER_SESSION);
  private readonly lifecycle = inject(SessionLifecycleService);
  readonly loggedIn = this.sessionState.loggedIn;

  constructor(
    private http: HttpClient,
    private routeService: RouteService,
    private push: PushService,
    private webPush: WebPushService,
    private userService: UserService,
    private transloco: TranslocoService,
    private toast: ToastService,
    private sendOutbox: ThreadSendOutbox,
  ) {}

  /** Resolve a transloco key to the active-locale string (falls back to the key). Mirrors WebPushService.t. */
  private t(key: string): string {
    return this.transloco.translate(key) ?? key;
  }

  /** True when logged in. Native: the `loggedIn` signal (the token is never held in JS, so login state is a
   *  boolean). Browser (pure httpOnly): the token is JS-unreadable, so login state is the non-httpOnly
   *  `logged_in` presence cookie the backend sets/clears in lockstep with the session cookie. */
  isLoggedIn(): boolean {
    return this.sessionState.isLoggedIn();
  }

  /** Drop the non-httpOnly presence cookie (JS can clear this; the httpOnly session cookie is cleared
   *  server-side on logout, or overwritten on next login). Used on logout / 401 so isLoggedIn() flips
   *  false immediately — avoids a stale-logged-in redirect loop with the guest guard. */
  private clearPresenceCookie() {
    this.sessionState.clearPresenceCookie();
  }

  /** Run the login-init origin race (once) before the auth request, so login targets a reachable origin
   *  (the boot-time pick may be stale if the network changed before login). No-op outside Tauri. On
   *  Tauri this also performs native fresh-login preparation FIRST: the old cache is released and the
   *  new login UUID minted before any authentication request is issued. */
  private pickThen<T>(
    request: (context: Authentication) => Observable<T>,
  ): Observable<T> {
    if (isTauri()) {
      return defer(() =>
        from(this.prepareNativeLogin()).pipe(
          mergeMap(async (context) => {
            await pickLoginOrigin();
            this.lifecycle.assertCurrent(context.work);
            return context;
          }),
          mergeMap(request),
        ),
      );
    }
    const browser = this.requireBrowserSession();
    return defer(() =>
      browser.authenticate(async (signal) => {
        await pickLoginOrigin();
        return sessionRequest(
          request({ host: 'browser', signal }),
          signal,
          30_000,
        );
      }),
    );
  }

  private requireBrowserSession() {
    if (!this.browserSession) {
      throw new Error('Browser session service is missing on the browser host');
    }
    return this.browserSession;
  }

  /** Mirror for explicit termination of the latest Rust-prepared/admitted login. Authentication
   *  completions use their immutable operation context, never this mutable reference. */
  private nativeLoginUuid: LoginSessionId | null = null;

  /** Native fresh-login boundary, run before the authentication request: Rust releases admitted cache
   *  work, deletes retired login caches and mints the new UUID. Account-scoped preferences of the
   *  previous login are removed here too, so nothing of the old login survives into the new one. */
  private async prepareNativeLogin(): Promise<NativeAuthentication> {
    this.userService.prepareFreshCache();
    this.sessionState.setAuthenticated(false);
    const work = this.lifecycle.capture();
    const id = parseLoginSessionId(
      await tauriInvoke<string>('native_db_begin_login'),
    );
    this.lifecycle.assertCurrent(work);
    this.nativeLoginUuid = id;
    await this.userService.clearSessionPreferences();
    this.lifecycle.assertCurrent(work);
    return Object.freeze({ host: 'native', id, work });
  }

  login(params: { account: string; password: string }) {
    // `client` is the device platform (badge in the device list); the token's lifetime is driven by
    // `trusted`, not `client`. `trusted`: the native app is always trusted (its token lives in OS secure
    // storage); a desktop is trusted only on explicit opt-in (OS keyring); web can never be trusted.
    // `persistent` maps "keep me logged in" to the cookie lifetime on the pure-httpOnly browser path.
    const client = this.resolveClient();
    return this.pickThen((context) =>
      this.http
        .post<LoginRes>(
          `${apiPrefix()}/auth/login`,
          {
            ...params,
            client,
            device: this.getDeviceLabel(),
          },
          {
            context: new HttpContext().set(
              REQUEST_SCOPE,
              RequestScope.Authentication,
            ),
          },
        )
        .pipe(
          mergeMap(async (res) => {
            if (res.code === 0 && res.data?.session_token) {
              // Await activation so Rust's ProxyState.token is populated BEFORE this observable emits — the
              // caller's post-login navigation then issues its first authenticated request with the Bearer
              // already in place (closes the login race; no JS-side token needed on the wire).
              await this.activateSession(res.data.session_token, context);
            }
            return res;
          }),
        ),
    );
  }

  /** One-time-code (admin-issued) login → a session whose lifetime follows the platform's trust: a trusted
   *  native client (app/desktop) keeps a permanent session (token in OS secure storage); the browser gets a
   *  14-day sliding one. `client` is sent so the backend issues the matching session kind. */
  otpLogin(params: { account: string; code: string; device?: string }) {
    const client = sessionClient();
    return this.pickThen((context) =>
      this.http
        .post<LoginRes>(
          `${apiPrefix()}/auth/otp/login`,
          {
            account: params.account,
            code: params.code,
            client,
            device: params.device ?? this.getDeviceLabel(),
          },
          {
            context: new HttpContext().set(
              REQUEST_SCOPE,
              RequestScope.Authentication,
            ),
          },
        )
        .pipe(
          mergeMap(async (res) => {
            if (res.code === 0 && res.data?.session_token) {
              await this.activateSession(res.data.session_token, context);
            }
            return res;
          }),
        ),
    );
  }

  /** QR-login: a client mints a sign-in token to render as a QR. `client` is the real platform
   *  ('app'/'web'/'desktop' — see {@link sessionClient}); `trusted` opts a desktop into a permanent session
   *  (its token kept in OS keyring), is implicit-true for 'app', and ignored for 'web' (never trusted). */
  qrCreate(client: 'app' | 'web' | 'desktop') {
    return this.pickThen(() =>
      this.http.post<{
        code: number;
        data?: { qrToken: string; expiresAt: number };
      }>(
        `${apiPrefix()}/auth/qr/create`,
        { client },
        {
          context: new HttpContext()
            .set(REQUEST_SCOPE, RequestScope.Authentication)
            .set(SUPPRESS_HTTP_ERROR_TOAST, true),
        },
      ),
    );
  }

  /** QR-login: poll the sign-in token's status. On 'confirmed' the response carries the session token,
   *  which activates a permanent session (if `trusted` was chosen at create) or a 14-day sliding one. */
  qrPoll(qrToken: string, device?: string) {
    return this.pickThen((context) =>
      this.http
        .post<{
          code: number;
          data?: {
            status: string;
            session_token?: string;
            mustChangePassword?: boolean;
          };
        }>(
          `${apiPrefix()}/auth/qr/poll`,
          {
            qrToken,
            device: device ?? this.getDeviceLabel(),
          },
          {
            context: new HttpContext()
              .set(REQUEST_SCOPE, RequestScope.Authentication)
              .set(SUPPRESS_HTTP_ERROR_TOAST, true),
          },
        )
        .pipe(
          mergeMap(async (res) => {
            if (res.code === 0 && res.data?.session_token) {
              await this.activateSession(res.data.session_token, context);
            }
            return res;
          }),
        ),
    );
  }

  /** QR-login: the phone (already logged in) scans a desktop QR → marks it 'scanned'. Authenticated. */
  qrScan(qrToken: string) {
    return this.http.post<{ code: number }>(`${apiPrefix()}/auth/qr/scan`, {
      qrToken,
    });
  }

  /** QR-login: the phone confirms a scanned QR → the desktop's next poll receives its session. Authenticated. */
  qrConfirm(qrToken: string) {
    return this.http.post<{ code: number }>(`${apiPrefix()}/auth/qr/confirm`, {
      qrToken,
    });
  }

  /** Activate a freshly obtained session token (login/OTP/QR success). Persists it to OS secure storage
   *  (Android EncryptedSharedPreferences / desktop keyring) when trusted, pushes it to Rust's
   *  `ProxyState.token` (so `api_request` can inject the Bearer) — AWAITED so the token is live before this
   *  resolves — and fires the push + web-push login hooks. Extracted so the password, OTP, and QR login
   *  paths activate identically. The token is never stored in JS. */
  private async activateSession(
    token: string,
    context: Authentication,
  ): Promise<void> {
    let admitted: SessionWorkScope;
    if (!isTauri()) {
      if (context.host !== 'browser') throw new SessionSupersededError();
      await this.requireBrowserSession().activate(context.signal);
      admitted = this.lifecycle.capture();
    } else {
      if (context.host !== 'native') throw new SessionSupersededError();
      admitted = await this.setSessionToken(token, context);
    }
    await clearSessionNotifications().catch((error) =>
      console.warn('[notification] login cleanup failed', error),
    );
    this.lifecycle.assertCurrent(admitted);
    // Browser credentials remain in the httpOnly cookie; this is only an admission mirror.
    this.sessionState.setAuthenticated(true);
    this.push.onLogin();
    void this.webPush.onLogin();
  }

  /** Drop the session and route to login. The kick `reason` (e.g. 'device_revoke', 'all_devices') is
   *  accepted for call-site compatibility with the realtime transport's FORCE_LOGOUT handler but no longer
   *  maps to a tailored login notice (the one-app-session 'app_session_replaced' notice was removed when
   *  multiple trusted devices became allowed); the login page itself signals the session ended. */
  redoLoginAuth(_reason?: string) {
    this.announceSessionEnding();
    if (!isTauri()) {
      void this.endBrowserSession(false).catch((error) =>
        console.warn('[session] local termination failed', error),
      );
      this.routeService.redirect(RoutePage.AUTH_LOGIN);
      return;
    }
    void this.clearToken().catch((error) =>
      console.warn('[session] native local termination failed', error),
    );
    this.routeService.redirect(RoutePage.AUTH_LOGIN);
  }

  /** Push a freshly obtained (login) or restored (cold-start) session token to the platforms that need the
   *  RAW value — WITHOUT storing it in JS:
   *   - Android: `SomsFcm.setSessionToken` (Kotlin EncryptedSharedPreferences — the store RealtimeService /
   *     FCM / Worker read) AND `set_session_token` (Rust `ProxyState.token` — so `api_request` injects the
   *     Bearer). Both are needed: Kotlin owns the native realtime layers, Rust owns the IPC HTTP transport.
   *   - Desktop: `set_session_token` (Rust `ProxyState.token`, AWAITED so login completes with the token
   *     live — closes the race) + `secure_set_token` (OS keyring, when the session should survive restart).
   *  The token passes THROUGH JS only to reach Rust/Kotlin/the keyring; it is never retained. */
  private async setSessionToken(
    token: string,
    context: NativeAuthentication,
  ): Promise<SessionWorkScope> {
    if (!isTauri())
      throw new Error('Native token installation requires the native host');
    this.lifecycle.assertCurrent(context.work);
    // The original operation supplies the UUID, never the mutable current-login mirror.
    await tauriInvoke('set_session_token', {
      token,
      sessionUuid: context.id,
    });
    this.lifecycle.assertCurrent(context.work);
    this.nativeLoginUuid = context.id;
    this.lifecycle.bindSession(context.id);
    const admitted = this.lifecycle.capture();
    if (isAndroidNative()) {
      // Persist only after Rust admits this exact operation and the renderer lease is still current.
      window.SomsFcm!.setSessionToken(token, context.id);
    } else {
      void tauriInvoke('secure_set_token', {
        token,
        sessionUuid: context.id,
      }).catch(() => {
        if (this.lifecycle.isCurrent(admitted))
          this.toast.warn(this.t('auth.notice.keepPersistFailed'));
      });
    }
    return admitted;
  }

  /** Re-establish the session on a cold start by reading the token back from OS secure storage (Android
   *  EncryptedSharedPreferences via the SomsFcm bridge; desktop OS keyring via the `secure_*` commands),
   *  handing it to Rust/Kotlin (the same {@link setSessionToken} path login uses), and flipping the login
   *  flag. Wired as an APP_INITIALIZER so it completes before the router resolves — `isLoggedIn()` then
   *  reflects the restored session with no race. No-op on the pure-httpOnly browser build (the cookie
   *  carries the session; there is no JS token to restore). The token passes through JS only to reach Rust;
   *  it is not retained. */
  async restoreSession(): Promise<void> {
    const work = this.lifecycle.capture();
    // Pick the reachable origin before Angular releases APP_INITIALIZER and mounts the routed page.
    // The logged-out login page immediately loads public `/config`, so deferring this race until the user
    // submits the login form makes every cold-start request hit the persisted primary even when the LAN
    // secondary is the reachable endpoint. This is intentionally independent of token restoration: a
    // device with no stored session still needs the correct backend for its first public request.
    if (isTauri()) {
      try {
        await pickLoginOrigin(true);
      } catch {
        // Origin selection is best-effort. If both probes fail (or native IPC is temporarily unavailable),
        // let the UI start and show its normal retry/error state rather than rejecting APP_INITIALIZER and
        // leaving a blank webview. A login attempt retries because pickLoginOrigin clears its failed cache.
      }
    }

    if (isTauri() && !this.lifecycle.isCurrent(work)) return;

    // Open the per-user IDB on the persisted lastUserId FIRST (awaited) so the threadlist can eager-paint
    // the cached list before the SSE/HELLO round-trip — the DB is open before the router resolves, so the
    // list reads it on mount. No-op on a first-ever launch (no userId persisted yet).
    if (!isTauri()) {
      const browser = this.requireBrowserSession();
      const hint = this.sessionState.hasBrowserSessionHint();
      this.sessionState.setAuthenticated(false);
      try {
        const restored = await browser.restore(hint);
        this.sessionState.setAuthenticated(restored);
        if (!restored) this.clearPresenceCookie();
      } catch {
        // Preserve the credential for a retry, but admit no business work while local recovery failed.
        this.toast.warn(this.t('auth.notice.localCacheUnavailable'));
      }
      return;
    }
    if (isAndroidNative()) {
      try {
        const t = window.SomsFcm!.getSessionToken(); // synchronous JNI
        if (t) await this.restoreNativeSession(t, work);
      } catch {
        // SomsFcm bridge missing (shell wiring bug / renderer reclaimed before the @JavascriptInterface
        // registered). Stay logged out + canTrust false rather than reject the APP_INITIALIZER — a rejection
        // aborts bootstrap → a blank webview with no recovery path.
      }
    } else if (isTauri()) {
      try {
        const t = await tauriInvoke<string | null>('secure_get_token');
        if (t) await this.restoreNativeSession(t, work);
      } catch {
        // Keyring unavailable (e.g. headless Linux without Secret Service): this desktop CANNOT be
        // trusted → the trust toggle stays hidden, so the user can't request a permanent token the client
        // then can't persist (which would orphan a server-side permanent session).
      }
    }
    // Browser: _canTrust stays false (web can never be trusted).
  }

  /** Cold-start native restore validates the credential against the durable login record FIRST: a
   *  residual credential whose login was ended locally is discarded, never restored. A missing, old, or
   *  damaged cache is rebuildable state, not an authentication failure: recreate the current schema and
   *  keep the restored token. */
  private async restoreNativeSession(
    token: string,
    work: SessionWorkScope,
  ): Promise<void> {
    this.lifecycle.assertCurrent(work);
    const uuid = await tauriInvoke<string | null>('login_session_for_token', {
      token,
    });
    this.lifecycle.assertCurrent(work);
    if (!uuid) {
      await this.discardResidualNativeToken();
      return;
    }
    const id = parseLoginSessionId(uuid);
    this.nativeLoginUuid = id;
    try {
      await tauriInvoke('native_db_validate_cache');
    } catch {
      this.lifecycle.assertCurrent(work);
      await tauriInvoke('native_db_recreate_cache');
    }
    this.lifecycle.assertCurrent(work);
    // Rust must admit the recovered owner before account-cache reads. The renderer remains
    // unauthenticated until those reads finish, and carries the admitted scope across them.
    const admitted = await this.setSessionToken(token, {
      host: 'native',
      id,
      work,
    });
    await this.userService.restoreWebdb();
    this.lifecycle.assertCurrent(admitted);
    this.sessionState.setAuthenticated(true);
  }

  /** Drop a credential that no longer belongs to any admitted login, from the store that still holds
   *  it. Local recovery to a clean signed-out state; the server-side token keeps its own expiry. */
  private async discardResidualNativeToken(): Promise<boolean> {
    let nativeOk = true;
    if (isAndroidNative()) {
      try {
        window.SomsFcm!.discardResidualToken();
      } catch {
        nativeOk = false;
      }
    } else if (isTauri()) {
      try {
        await tauriInvoke('secure_clear_residual_token');
      } catch {
        nativeOk = false;
      }
    } else {
      this.clearPresenceCookie();
    }
    await clearSessionNotifications().catch((error) =>
      console.warn('[notification] logout cleanup failed', error),
    );
    return nativeOk;
  }

  /** Synchronous local-state clear: flip the login flag + drop the in-memory trust/keep flags. Does NOT
   *  touch the native token (Rust `ProxyState.token` / OS secure store) — an in-flight authenticated
   *  request must still carry the Bearer, so the native clear is ordered after it (see {@link logout}). */
  private clearLocalSessionState(): void {
    this.sessionState.setAuthenticated(false);
  }

  /** Clear the native token (Rust `ProxyState.token` via `clear_session_token` + the OS secure store).
   *  Returns whether the PERSISTENT (keyring / EncryptedSharedPreferences) clear succeeded (false → the
   *  logout-failed toast). The Rust in-memory clear is best-effort. */
  private async clearNativeToken(sessionUuid: string): Promise<boolean> {
    let nativeOk = true;
    if (isAndroidNative()) {
      // Android: clear Kotlin's EncryptedSharedPreferences (SomsFcm) AND Rust's ProxyState.token. The Rust
      // clear is needed because login now pushes the token to BOTH stores (setSessionToken) — leaving
      // ProxyState.token set would keep `api_request` sending the revoked Bearer after logout.
      try {
        window.SomsFcm!.setSessionToken(null, sessionUuid);
      } catch {
        nativeOk = false;
      }
      try {
        await tauriInvoke('clear_session_token', { sessionUuid });
      } catch {
        /* ProxyState.token in-memory copy */
      }
    } else if (isTauri()) {
      // Desktop: clear the persistent keyring + the Rust in-memory token independently — a locked keyring
      // must not skip the proxy clear. nativeOk tracks the persistent keyring (the failure that leaves a
      // stale token). (secure_clear_token is a desktop-only command — not reachable on Android.)
      try {
        await tauriInvoke('secure_clear_token', { sessionUuid });
      } catch {
        nativeOk = false;
      } // idempotent: NoEntry → Ok
      try {
        await tauriInvoke('clear_session_token', { sessionUuid });
      } catch {
        /* ProxyState.token in-memory copy */
      }
    } else {
      this.clearPresenceCookie();
    }
    await clearSessionNotifications().catch((error) =>
      console.warn('[notification] logout cleanup failed', error),
    );
    return nativeOk;
  }

  /** Full clear (local state + native token). Used by {@link redoLoginAuth} / {@link revokeAndBounce},
   *  where NO authenticated request follows, so the native token can be cleared at once. */
  async clearToken(): Promise<boolean> {
    if (!isTauri()) {
      await this.endBrowserSession(false);
      return true;
    }
    return this.endNativeSession(false);
  }

  /** One browser teardown path for explicit logout, forced logout and local token clear. */
  private async endBrowserSession(remote: boolean): Promise<void> {
    const browser = this.requireBrowserSession();
    this.clearLocalSessionState();
    this.clearPresenceCookie();
    this.sendOutbox.clear();
    const ending = remote
      ? browser.logout((signal) =>
          sessionRequest(
            this.http.post<LogoutRes>(
              `${apiPrefix()}/auth/logout`,
              {},
              {
                context: new HttpContext()
                  .set(REQUEST_SCOPE, RequestScope.Authentication)
                  .set(SUPPRESS_HTTP_ERROR_TOAST, true),
              },
            ),
            signal,
          ).then(() => undefined),
        )
      : browser.end();
    await Promise.all([
      ending,
      clearSessionNotifications().catch((error) =>
        console.warn('[notification] logout cleanup failed', error),
      ),
    ]);
  }

  logout() {
    if (!isTauri()) {
      this.announceSessionEnding();
      return from(this.endBrowserSession(true)).pipe(
        tap({
          error: () =>
            this.toast.warn(
              this.t('auth.notice.logoutCacheClearFailed'),
              IMPORTANT_NOTICE_MS,
            ),
        }),
      );
    }
    if (!this.isLoggedIn()) return EMPTY;
    // Renderer-owned WebRTC must end while this session credential is still usable. Android ignores this
    // DOM signal: its native call owner has its own lifecycle and survives WebView recreation.
    this.announceSessionEnding();
    return from(
      this.endNativeSession(true).then((nativeOk) => {
        if (!nativeOk)
          this.toast.warn(
            this.t('auth.notice.logoutClearFailed'),
            IMPORTANT_NOTICE_MS,
          );
      }),
    ).pipe(
      tap({
        error: () =>
          this.toast.warn(
            this.t('auth.notice.logoutClearFailed'),
            IMPORTANT_NOTICE_MS,
          ),
      }),
    );
  }

  private async endNativeSession(remote: boolean): Promise<boolean> {
    const origin = apiOrigin();
    const endedLogin = this.nativeLoginUuid;
    this.nativeLoginUuid = null;
    this.clearLocalSessionState();
    this.sendOutbox.clear();
    // Invalidate admission synchronously, but retain the physical cache and account preferences.
    let release: Promise<void>;
    try {
      release = this.userService.releaseSession();
    } catch (error) {
      release = Promise.reject(error);
    }
    const released = release.then(
      () => ({ failed: false as const }),
      (error: unknown) => ({ failed: true as const, error }),
    );
    let nativeOk = true;
    if (remote) {
      let ticket: string | null = null;
      let platformCleared = false;
      try {
        const admitted = await tauriInvoke<{
          ticket: string | null;
          localClearFailed: boolean;
        }>('begin_logout', { origin, sessionUuid: endedLogin });
        ticket = admitted.ticket;
        nativeOk = !admitted.localClearFailed;
      } catch (error) {
        console.warn('[session] native logout admission failed', error);
        if (endedLogin) {
          nativeOk = await this.clearNativeToken(endedLogin);
          platformCleared = true;
        }
      }
      // The acknowledgement proves Rust captured the ended token before Android clears both copies.
      if (isAndroidNative() && !platformCleared && endedLogin) {
        try {
          window.SomsFcm!.setSessionToken(null, endedLogin);
        } catch {
          nativeOk = false;
        }
      }
      await Promise.all([
        platformCleared
          ? Promise.resolve()
          : clearSessionNotifications().catch((error) =>
              console.warn('[notification] logout cleanup failed', error),
            ),
        ticket
          ? tauriInvoke('wait_for_logout', { ticket }).catch((error) =>
              console.warn('[session] logout wait failed', error),
            )
          : Promise.resolve(),
      ]);
    } else if (endedLogin) {
      nativeOk = await this.clearNativeToken(endedLogin);
    } else {
      nativeOk = await this.discardResidualNativeToken();
    }
    const outcome = await released;
    if (outcome.failed) throw outcome.error;
    return nativeOk;
  }

  private announceSessionEnding(): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(CALL_SESSION_ENDING_EVENT));
    }
  }

  /** Change password: the server invalidates ALL sessions (`invalidateAllSessions` revokes every session
   *  token row + bumps tokenVersion) and returns NO new session token. The current device's session token
   *  is dead, so drop it + re-login for a fresh one. (Online clients also receive a FORCE_LOGOUT frame,
   *  whose handler calls redoLoginAuth too — this is the immediate path for the device that initiated
   *  the change.) */
  changePassword(params: { oldPassword: string; newPassword: string }) {
    return this.http
      .post<LogoutRes>(`${apiPrefix()}/auth/change-password`, params)
      .pipe(
        tap((res) => {
          if (res.code === 0) this.redoLoginAuth();
        }),
      );
  }

  /** Set the user's OWN password — the forced first-time set right after an admin-generated initial
   *  password. The backend clears `mustChangePassword` and KEEPS this session (no sessions are invalidated,
   *  unlike {@link changePassword}); the caller is already session-authenticated, so no old password is
   *  sent. On success the app unlocks — the caller routes to HOME. */
  setPassword(newPassword: string) {
    return this.http.post<{ code: number; message: string }>(
      `${apiPrefix()}/auth/set-password`,
      { newPassword },
    );
  }

  /** List the current user's active sessions. Every request carries the session token (Rust-injected
   *  Bearer on native), so the server can flag the requesting row `isCurrent`. */
  getSessions() {
    return this.http.post<{
      code: number;
      message: string;
      data?: SessionInfo[];
    }>(`${apiPrefix()}/auth/sessions`, {});
  }

  getSessionSettings() {
    return this.http.get<{
      code: number;
      message: string;
      data?: { autoTerminateDays: AutoTerminateDays };
    }>(`${apiPrefix()}/auth/session-settings`);
  }

  setSessionAutoTerminateDays(days: AutoTerminateDays) {
    return this.http.put<{ code: number; message: string }>(
      `${apiPrefix()}/auth/session-settings`,
      { days },
    );
  }

  /** Revoke a single session by its device-list row id. Ownership is verified server-side. */
  revokeSession(id: number) {
    return this.http.post<{ code: number; message: string }>(
      `${apiPrefix()}/auth/revoke-session`,
      { id },
    );
  }

  /** Client kind for the session-token lifetime policy + the device-list badge: the Android Tauri shell is
   *  'app' (no-expiry, native secure store), the desktop Tauri shell is 'desktop', the browser is 'web'. */
  private resolveClient(): SessionClient {
    if (isAndroidNative()) return 'app';
    if (isTauri()) return 'desktop';
    return 'web';
  }

  /** Human-readable label for this device/browser, sent on login so the Active-sessions list shows a
   *  recognizable name instead of an opaque uuid. Best-effort navigator.userAgent parse (dependency-free);
   *  stable per device so re-login keeps the same label. */
  private getDeviceLabel(): string {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const os = /Windows NT/i.test(ua)
      ? 'Windows'
      : /iPhone|iPad|iPod|iOS/i.test(ua)
        ? 'iOS'
        : /Mac OS X/i.test(ua)
          ? 'macOS'
          : /Android/i.test(ua)
            ? 'Android'
            : /CrOS/i.test(ua)
              ? 'ChromeOS'
              : /Linux/i.test(ua)
                ? 'Linux'
                : (typeof navigator !== 'undefined' && navigator.platform) ||
                  'Unknown';
    if (isAndroidNative()) return 'Android'; // native app — the OS is the device identity
    if (isTauri()) return `Desktop · ${os}`; // Tauri desktop shell
    const browser = /Edg\//i.test(ua)
      ? 'Edge'
      : /OPR\//i.test(ua)
        ? 'Opera'
        : /Chrome\//i.test(ua)
          ? 'Chrome'
          : /Firefox\//i.test(ua)
            ? 'Firefox'
            : /Safari\//i.test(ua)
              ? 'Safari'
              : 'Browser';
    return `${browser} · ${os}`;
  }
}

/** The client kind, selecting the session-token lifetime policy server-side and shown as a badge in the
 *  device list. Mirrors the backend LoginDto.client union. */
export type SessionClient = 'app' | 'web' | 'desktop';
export type AutoTerminateDays = 7 | 30 | 90 | 180 | 365;

/** One row of GET /auth/sessions — the active-session credential behind the "Devices" settings page.
 *  Dates arrive as epoch milliseconds; `expiresAt` is null for trusted (permanent)
 *  devices. `trusted` flags a device whose token lives in OS secure storage. `isCurrent` is server-stamped
 *  against the requesting session token. */
export interface SessionInfo {
  id: number;
  client: SessionClient;
  device: string | null;
  userAgent: string | null;
  ip: string | null;
  lastSeenIp: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number | null;
  autoTerminateDays: AutoTerminateDays;
  isCurrent: boolean;
}
