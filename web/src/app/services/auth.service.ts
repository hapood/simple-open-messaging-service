import { Injectable, signal } from '@angular/core';
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
import { SUPPRESS_HTTP_ERROR_TOAST } from '../request-context';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';
import { ToastService } from './toast.service';
import { CALL_SESSION_ENDING_EVENT } from './web-call.adapter';
import { ThreadSendOutbox } from './thread-send-outbox.service';

// Non-httpOnly presence cookie the backend sets/clears in lockstep with the httpOnly session cookie
// (name mirrors src/auth/media-token.ts LOGGED_IN_COOKIE). On the pure-httpOnly browser build the
// session token is JS-unreadable, so this flag is how the SPA tells whether a session exists.
const LOGGED_IN_COOKIE = 'logged_in';

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
   *  connect/disconnect lifecycle (WebsocketService's login effect) + the auth guards. On native this is
   *  the single source of truth for login (the token value is never held in JS); on browser it mirrors the
   *  non-httpOnly `logged_in` presence cookie (the session credential itself is JS-unreadable). Initialized
   *  from the cookie on browser so a page refresh while signed in starts `true`; native starts `false` and
   *  {@link restoreSession} flips it after re-establishing the session from secure storage. */
  readonly loggedIn = signal<boolean>(
    isTauri() ? false : this.hasPresenceCookie(),
  );

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
    return isTauri() ? this.loggedIn() : this.hasPresenceCookie();
  }

  private hasPresenceCookie(): boolean {
    return (
      typeof document !== 'undefined' &&
      document.cookie
        .split(';')
        .some((c) => c.trim().startsWith(`${LOGGED_IN_COOKIE}=`))
    );
  }

  /** Drop the non-httpOnly presence cookie (JS can clear this; the httpOnly session cookie is cleared
   *  server-side on logout, or overwritten on next login). Used on logout / 401 so isLoggedIn() flips
   *  false immediately — avoids a stale-logged-in redirect loop with the guest guard. */
  private clearPresenceCookie() {
    if (typeof document !== 'undefined') {
      document.cookie = `${LOGGED_IN_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`;
    }
  }

  /** Run the login-init origin race (once) before the auth request, so login targets a reachable origin
   *  (the boot-time pick may be stale if the network changed before login). No-op outside Tauri. */
  private pickThen<T>(req: Observable<T>): Observable<T> {
    return defer(() => pickLoginOrigin()).pipe(mergeMap(() => req));
  }

  login(params: { account: string; password: string }) {
    // `client` is the device platform (badge in the device list); the token's lifetime is driven by
    // `trusted`, not `client`. `trusted`: the native app is always trusted (its token lives in OS secure
    // storage); a desktop is trusted only on explicit opt-in (OS keyring); web can never be trusted.
    // `persistent` maps "keep me logged in" to the cookie lifetime on the pure-httpOnly browser path.
    const client = this.resolveClient();
    return this.pickThen(
      this.http
        .post<LoginRes>(`${apiPrefix()}/auth/login`, {
          ...params,
          client,
          device: this.getDeviceLabel(),
        })
        .pipe(
          mergeMap(async (res) => {
            if (res.code === 0 && res.data?.session_token) {
              // Await activation so Rust's ProxyState.token is populated BEFORE this observable emits — the
              // caller's post-login navigation then issues its first authenticated request with the Bearer
              // already in place (closes the login race; no JS-side token needed on the wire).
              await this.activateSession(res.data.session_token);
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
    return this.pickThen(
      this.http
        .post<LoginRes>(`${apiPrefix()}/auth/otp/login`, {
          account: params.account,
          code: params.code,
          client,
          device: params.device ?? this.getDeviceLabel(),
        })
        .pipe(
          mergeMap(async (res) => {
            if (res.code === 0 && res.data?.session_token) {
              await this.activateSession(res.data.session_token);
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
    return this.pickThen(
      this.http.post<{
        code: number;
        data?: { qrToken: string; expiresAt: number };
      }>(
        `${apiPrefix()}/auth/qr/create`,
        { client },
        {
          context: new HttpContext().set(SUPPRESS_HTTP_ERROR_TOAST, true),
        },
      ),
    );
  }

  /** QR-login: poll the sign-in token's status. On 'confirmed' the response carries the session token,
   *  which activates a permanent session (if `trusted` was chosen at create) or a 14-day sliding one. */
  qrPoll(qrToken: string, device?: string) {
    return this.pickThen(
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
            context: new HttpContext().set(SUPPRESS_HTTP_ERROR_TOAST, true),
          },
        )
        .pipe(
          mergeMap(async (res) => {
            if (res.code === 0 && res.data?.session_token) {
              await this.activateSession(res.data.session_token);
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
  private async activateSession(token: string): Promise<void> {
    this.userService.prepareFreshCache();
    if (isTauri()) {
      // A real login starts a fresh cache generation. Ordinary native DB commands never create or repair
      // account-cache tables; this is the single explicit initialization boundary.
      await tauriInvoke('native_db_recreate_cache');
    }
    await clearSessionNotifications().catch((error) =>
      console.warn('[notification] login cleanup failed', error),
    );
    if (isTauri()) await this.setSessionToken(token);
    // Browser (pure httpOnly): the backend set the httpOnly session cookie + presence cookie; no token is
    // held in JS.
    this.loggedIn.set(true);
    this.push.onLogin();
    void this.webPush.onLogin();
  }

  /** Drop the session and route to login. The kick `reason` (e.g. 'device_revoke', 'all_devices') is
   *  accepted for call-site compatibility with the realtime transport's FORCE_LOGOUT handler but no longer
   *  maps to a tailored login notice (the one-app-session 'app_session_replaced' notice was removed when
   *  multiple trusted devices became allowed); the login page itself signals the session ended. */
  redoLoginAuth(_reason?: string) {
    this.announceSessionEnding();
    void this.clearToken();
    // Drop the in-memory session (sessionProfile / sessionUserId / per-user DB) on the same terms as logout
    // — a 401 / FORCE_LOGOUT means this session is over, so the next account must not inherit its view state
    // (open chat, mobile section, dialogs) nor its cached data. Successful cleanup explicitly notifies
    // in-memory consumers, including when the session ended before HELLO identified the user.
    void this.userService.clearSession().catch(() => {});
    this.sendOutbox.clear();
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
  private async setSessionToken(token: string): Promise<void> {
    if (isAndroidNative()) {
      window.SomsFcm!.setSessionToken(token);
    }
    if (isTauri()) {
      // Await so ProxyState.token is populated before this resolves — the login flow (which awaits
      // activateSession → this) then issues its first authenticated request with the Bearer in place.
      // Needed on BOTH desktop AND Android: both route /api/v1 through the `api_request` IPC transport,
      // which reads ProxyState.token. (Awaiting also closes the pre-login/first-request race.)
      await tauriInvoke('set_session_token', { token });
      // Desktop persistence to the OS keyring (Android persists via SomsFcm above). Fire-and-forget: a
      // failure revokes a TRUSTED (permanent) token server-side (no orphan) + bounces to login; a keep-only
      // token gets a toast. set_session_token above already set ProxyState.token to THIS token, so
      // revokeAndBounce's logout POST (Bearer-injected by Rust) revokes exactly it.
      if (!isAndroidNative()) {
        tauriInvoke('secure_set_token', { token }).catch(() => {
          this.toast.warn(this.t('auth.notice.keepPersistFailed'));
        });
      }
    }
    // Browser (pure httpOnly): no JS token — the backend holds the credential in the cookie.
  }

  /** Re-establish the session on a cold start by reading the token back from OS secure storage (Android
   *  EncryptedSharedPreferences via the SomsFcm bridge; desktop OS keyring via the `secure_*` commands),
   *  handing it to Rust/Kotlin (the same {@link setSessionToken} path login uses), and flipping the login
   *  flag. Wired as an APP_INITIALIZER so it completes before the router resolves — `isLoggedIn()` then
   *  reflects the restored session with no race. No-op on the pure-httpOnly browser build (the cookie
   *  carries the session; there is no JS token to restore). The token passes through JS only to reach Rust;
   *  it is not retained. */
  async restoreSession(): Promise<void> {
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

    // Open the per-user IDB on the persisted lastUserId FIRST (awaited) so the threadlist can eager-paint
    // the cached list before the SSE/HELLO round-trip — the DB is open before the router resolves, so the
    // list reads it on mount. No-op on a first-ever launch (no userId persisted yet).
    if (!isTauri()) {
      try {
        await this.userService.restoreWebdb();
      } catch {
        // Rebuild failure is a local storage fault, not an authentication event. Keep the cookie/session;
        // HELLO establishment retries the same rebuild and the storage error remains visible to callers.
        this.toast.warn(this.t('auth.notice.localCacheUnavailable'));
      }
    }
    if (isAndroidNative()) {
      try {
        const t = window.SomsFcm!.getSessionToken(); // synchronous JNI
        if (t) await this.restoreNativeSession(t);
      } catch {
        // SomsFcm bridge missing (shell wiring bug / renderer reclaimed before the @JavascriptInterface
        // registered). Stay logged out + canTrust false rather than reject the APP_INITIALIZER — a rejection
        // aborts bootstrap → a blank webview with no recovery path.
      }
    } else if (isTauri()) {
      try {
        const t = await tauriInvoke<string | null>('secure_get_token');
        if (t) await this.restoreNativeSession(t);
      } catch {
        // Keyring unavailable (e.g. headless Linux without Secret Service): this desktop CANNOT be
        // trusted → the trust toggle stays hidden, so the user can't request a permanent token the client
        // then can't persist (which would orphan a server-side permanent session).
      }
    }
    // Browser: _canTrust stays false (web can never be trusted).
  }

  /** Apply a token restored from secure storage: push it to Rust/Kotlin (the same {@link setSessionToken}
   *  path login uses) + flip the login flag. A restored token is by definition durable/trusted (it came
   *  from the keyring / EncryptedSharedPreferences). */
  private async applyRestoredToken(token: string): Promise<void> {
    await this.setSessionToken(token);
    this.loggedIn.set(true);
  }

  /** Cold-start native restore reads and validates first. A missing, old, or damaged cache is rebuildable
   *  state, not an authentication failure: recreate the current schema and keep the restored token. */
  private async restoreNativeSession(token: string): Promise<void> {
    try {
      await tauriInvoke('native_db_validate_cache');
    } catch {
      await tauriInvoke('native_db_recreate_cache');
    }
    await this.userService.restoreWebdb();
    await this.applyRestoredToken(token);
  }

  /** Synchronous local-state clear: flip the login flag + drop the in-memory trust/keep flags. Does NOT
   *  touch the native token (Rust `ProxyState.token` / OS secure store) — an in-flight authenticated
   *  request must still carry the Bearer, so the native clear is ordered after it (see {@link logout}). */
  private clearLocalSessionState(): void {
    this.loggedIn.set(false);
  }

  /** Clear the native token (Rust `ProxyState.token` via `clear_session_token` + the OS secure store).
   *  Returns whether the PERSISTENT (keyring / EncryptedSharedPreferences) clear succeeded (false → the
   *  logout-failed toast). The Rust in-memory clear is best-effort. */
  private async clearNativeToken(): Promise<boolean> {
    let nativeOk = true;
    if (isAndroidNative()) {
      // Android: clear Kotlin's EncryptedSharedPreferences (SomsFcm) AND Rust's ProxyState.token. The Rust
      // clear is needed because login now pushes the token to BOTH stores (setSessionToken) — leaving
      // ProxyState.token set would keep `api_request` sending the revoked Bearer after logout.
      try {
        window.SomsFcm!.setSessionToken(null);
      } catch {
        nativeOk = false;
      }
      try {
        await tauriInvoke('clear_session_token');
      } catch {
        /* ProxyState.token in-memory copy */
      }
    } else if (isTauri()) {
      // Desktop: clear the persistent keyring + the Rust in-memory token independently — a locked keyring
      // must not skip the proxy clear. nativeOk tracks the persistent keyring (the failure that leaves a
      // stale token). (secure_clear_token is a desktop-only command — not reachable on Android.)
      try {
        await tauriInvoke('secure_clear_token');
      } catch {
        nativeOk = false;
      } // idempotent: NoEntry → Ok
      try {
        await tauriInvoke('clear_session_token');
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
    this.clearLocalSessionState();
    return this.clearNativeToken();
  }

  logout() {
    if (!this.isLoggedIn()) return EMPTY;
    // Renderer-owned WebRTC must end while this session credential is still usable. Android ignores this
    // DOM signal: its native call owner has its own lifecycle and survives WebView recreation.
    this.announceSessionEnding();
    // Local cache deletion is a controllable logout precondition. Keep the authenticated UI and token
    // intact until it succeeds; a failure remains retryable instead of producing a half-logged-out state.
    let cacheClear: Promise<void>;
    try {
      cacheClear = Promise.resolve(this.userService.clearSession()).then(
        async () => {
          if (!isTauri()) {
            const { resetNotificationSince } = await import(
              './browser-notification-checkpoint'
            );
            await resetNotificationSince();
          }
          await clearSessionNotifications().catch((error) =>
            console.warn('[notification] logout cleanup failed', error),
          );
        },
      );
    } catch (error) {
      cacheClear = Promise.reject(error);
    }
    return from(cacheClear).pipe(
      tap({
        next: () => {
          this.clearLocalSessionState();
          this.sendOutbox.clear();

          if (isTauri()) {
            if (isAndroidNative()) {
              try {
                window.SomsFcm!.setSessionToken(null);
              } catch {
                this.toast.warn(
                  this.t('auth.notice.logoutClearFailed'),
                  IMPORTANT_NOTICE_MS,
                );
              }
            }
            void tauriInvoke('begin_logout', { origin: apiOrigin() }).catch(
              () =>
                this.toast.warn(
                  this.t('auth.notice.logoutClearFailed'),
                  IMPORTANT_NOTICE_MS,
                ),
            );
          } else {
            this.clearPresenceCookie();
            this.http
              .post<LogoutRes>(`${apiPrefix()}/auth/logout`, {})
              .subscribe({ error: () => {} });
          }
        },
        error: () =>
          this.toast.warn(
            this.t('auth.notice.logoutCacheClearFailed'),
            IMPORTANT_NOTICE_MS,
          ),
      }),
    );
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
