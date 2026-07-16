import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, tap } from 'rxjs';
import { RouteService, RoutePage } from './route.service';
import { apiPrefix } from './constants';
import { isTauri, isAndroidNative, tauriInvoke } from './runtime';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';

const SESSION_TOKEN = 'session_token',
  IS_KEEP_LOGIN = 'is_keep_login',
  // Non-httpOnly presence cookie the backend sets/clears in lockstep with the httpOnly session cookie
  // (name mirrors src/auth/media-token.ts LOGGED_IN_COOKIE). On the pure-httpOnly browser build the
  // session token is JS-unreadable, so this flag is how the SPA tells whether a session exists.
  LOGGED_IN_COOKIE = 'logged_in'

type LoginRes = { code: number, message: string, data?: { session_token?: string } }
type LogoutRes = { code: number, message: string }

/**
 * One opaque per-device session token authenticates every request — carried as an httpOnly cookie
 * (browser: auto-attached same-origin, JS-unreadable) or an `Authorization: Bearer` header (native: the
 * interceptor + Rust media proxy + Kotlin SSE/FCM/Worker). The backend accepts cookie-or-Bearer on every
 * route. No access JWT, no refresh token, no renewal. Issued at login; revoked at logout / logout-all /
 * change-password (`invalidateAllSessions`); a 401 → re-login (`redoLoginAuth`).
 *
 * **Storage (branched on `isTauri()`):**
 *  - Browser (pure httpOnly): the token is NEVER held in JS — XSS can't exfiltrate it. Login state rides
 *    the non-httpOnly `logged_in` presence cookie (`document.cookie`). "Keep me logged in" maps to the
 *    cookie lifetime (30-day vs session) via the login `persistent` flag; the httpOnly cookie can only
 *    be cleared by the backend (logout).
 *  - Native (Tauri desktop + Android): the raw token IS held in JS storage (localStorage when "keep me
 *    logged in", sessionStorage otherwise) — the desktop SSE worker + Android push need the raw value,
 *    which is also pushed to the Rust media proxy (`set_session_token`) and Kotlin
 *    (`syncNativeSessionToken`). The interceptor sends it as `Authorization: Bearer`.
 */
@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private _isKeep = localStorage.getItem(IS_KEEP_LOGIN) === '1' || false
  /** The session token: in-memory copy of the persisted credential (null when logged out / pre-login).
   *  Seeded from storage at construction so a page refresh re-establishes the session without a re-login. */
  private _sessionToken: string | null = this.readSessionToken()
  get sessionToken(): string | null { return this._sessionToken }
  /** Reactive view of the session token for the realtime transport: the SSE worker is spawned at boot
   *  (pre-login) and asks for the token via `need-token` — it must BLOCK until login provides one, so the
   *  transport awaits the first non-null emission here rather than busy-looping. Emits the current value
   *  to new subscribers (so a post-login spawn resolves at once). */
  private readonly _sessionTokenSub = new BehaviorSubject<string | null>(this._sessionToken)
  readonly sessionToken$ = this._sessionTokenSub.asObservable()

  /** A transient, one-shot i18n key shown on the login page after a server-initiated kick (FORCE_LOGOUT).
   *  Set by {@link redoLoginAuth} from the kick reason (e.g. 'app_session_replaced' → "signed in elsewhere"
   *  when a new OTP login replaced this app session); consumed + cleared by the login page on render. Null
   *  when there's nothing to surface. */
  readonly loginNotice = signal<string | null>(null)
  /** Kicks whose reason maps to a specific (non-generic) login-page notice. Unmapped reasons fall back to
   *  no notice (the login page itself is the signal that the session ended). */
  private static readonly KICK_NOTICE_KEY: Record<string, string> = {
    app_session_replaced: 'auth.notice.signedInElsewhere',
  }

  /** Push the current session token to the Android shell so Kotlin's RealtimeService can authenticate
   *  /events and the background fetchers (FCM/WorkManager) can authenticate /notifications/missed while
   *  the WebView is suspended. null clears it (logout) and stops the native stream. No-op off Android
   *  (no SomsFcm surface — web/desktop don't own a native connection). */
  private syncNativeSessionToken() {
    if (!isAndroidNative()) return // off Android there is no native bridge to push to
    // On Android the shell injects SomsFcm before any page script — call it directly so a missing
    // bridge surfaces as an error instead of being silently swallowed by optional chaining.
    window.SomsFcm!.setSessionToken(this._sessionToken)
  }

  constructor(
    private http: HttpClient,
    private routeService: RouteService,
    private push: PushService,
    private webPush: WebPushService,
    private userService: UserService,
  ) {}

  /** True when logged in. Native: a raw token is held in JS storage. Browser (pure httpOnly): the
   *  token is JS-unreadable, so login state is the non-httpOnly `logged_in` presence cookie the backend
   *  sets/clears in lockstep with the session cookie. */
  isLoggedIn(): boolean {
    return isTauri() ? this._sessionToken !== null : this.hasPresenceCookie()
  }

  private hasPresenceCookie(): boolean {
    return typeof document !== 'undefined'
      && document.cookie.split(';').some((c) => c.trim().startsWith(`${LOGGED_IN_COOKIE}=`))
  }

  /** Drop the non-httpOnly presence cookie (JS can clear this; the httpOnly session cookie is cleared
   *  server-side on logout, or overwritten on next login). Used on logout / 401 so isLoggedIn() flips
   *  false immediately — avoids a stale-logged-in redirect loop with the guest guard. */
  private clearPresenceCookie() {
    if (typeof document !== 'undefined') {
      document.cookie = `${LOGGED_IN_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`
    }
  }

  login(params: { account: string, password: string, isKeep: boolean }) {
    const { isKeep, ...credentials } = params
    // `client` selects the session-token lifetime policy (app=no-expiry, web/desktop=sliding 30d) and is
    // shown as a badge in the device list; `device` is a human-readable label for that list (distinct from
    // the device_id uuid, which is the push-token device identifier). `persistent` maps "keep me logged
    // in" to the cookie lifetime on the pure-httpOnly browser path (native ignores the cookie).
    return this.http.post<LoginRes>(
      `${apiPrefix()}/auth/login`, {
        ...credentials,
        client: this.resolveClient(),
        device: this.getDeviceLabel(),
        persistent: isKeep,
      }).pipe(tap((res) => {
        if (res.code === 0 && res.data?.session_token) {
          this.activateSession(res.data.session_token, isKeep)
        }
      }))
  }

  /** One-time-code (admin-issued) login → a long-term `app` session (Android). The server sets the httpOnly
   *  cookie; native persists the raw token. Always persistent (the app session is long-lived). */
  otpLogin(params: { account: string, code: string, device?: string }) {
    return this.http.post<LoginRes>(
      `${apiPrefix()}/auth/otp/login`, {
        account: params.account,
        code: params.code,
        device: params.device ?? this.getDeviceLabel(),
      }).pipe(tap((res) => {
        if (res.code === 0 && res.data?.session_token) {
          this.activateSession(res.data.session_token, true)
        }
      }))
  }

  /** QR-login: desktop/web mints a sign-in token to render as a QR. */
  qrCreate(client: 'web' | 'desktop') {
    return this.http.post<{ code: number, data?: { qrToken: string, expiresAt: number } }>(
      `${apiPrefix()}/auth/qr/create`, { client },
    )
  }

  /** QR-login: poll the sign-in token's status. On 'confirmed' the response carries the session token,
   *  which activates a 14-day sliding web/desktop session. */
  qrPoll(qrToken: string, device?: string) {
    return this.http.post<{ code: number, data?: { status: string, session_token?: string } }>(
      `${apiPrefix()}/auth/qr/poll`, { qrToken, device: device ?? this.getDeviceLabel() },
    ).pipe(tap((res) => {
      if (res.code === 0 && res.data?.session_token) {
        this.activateSession(res.data.session_token, true)
      }
    }))
  }

  /** QR-login: the phone (already logged in) scans a desktop QR → marks it 'scanned'. Authenticated. */
  qrScan(qrToken: string) {
    return this.http.post<{ code: number }>(`${apiPrefix()}/auth/qr/scan`, { qrToken })
  }

  /** QR-login: the phone confirms a scanned QR → the desktop's next poll receives its session. Authenticated. */
  qrConfirm(qrToken: string) {
    return this.http.post<{ code: number }>(`${apiPrefix()}/auth/qr/confirm`, { qrToken })
  }

  /** Activate a freshly obtained session token (login/OTP/QR success). Mirrors it to storage (per isKeep),
   *  the Android shell, and the desktop media proxy; fires the push + web-push login hooks. Extracted so the
   *  password, OTP, and QR login paths activate identically. */
  private activateSession(token: string, isKeep: boolean) {
    this._isKeep = isKeep
    if (isKeep) localStorage.setItem(IS_KEEP_LOGIN, '1')
    else localStorage.removeItem(IS_KEEP_LOGIN)
    if (isTauri()) {
      // Native: persist the raw token (desktop SSE worker + Android push need it). Clear both stores so an
      // isKeep switch leaves no orphaned old token, then activate + push to native.
      sessionStorage.removeItem(SESSION_TOKEN)
      localStorage.removeItem(SESSION_TOKEN)
      this.setSessionToken(token)
    }
    // Browser (pure httpOnly): the backend set the httpOnly session cookie + presence cookie; no token is
    // held in JS.
    this.push.onLogin()
    void this.webPush.onLogin()
  }

  redoLoginAuth(reason?: string) {
    if (reason && AuthService.KICK_NOTICE_KEY[reason]) {
      this.loginNotice.set(AuthService.KICK_NOTICE_KEY[reason])
    }
    this.clearToken()
    this.routeService.redirect(RoutePage.AUTH_LOGIN)
  }

  /** Read + clear the one-shot login notice (the login page calls this on render). */
  consumeLoginNotice(): string | null {
    const key = this.loginNotice()
    if (key) this.loginNotice.set(null)
    return key
  }

  /** Persist + activate a freshly obtained session token (login). Mirrors it to storage (per isKeep),
   *  the Android shell, and the desktop media proxy. */
  private setSessionToken(token: string) {
    this._sessionToken = token
    if (this._isKeep) localStorage.setItem(SESSION_TOKEN, token)
    else sessionStorage.setItem(SESSION_TOKEN, token)
    this._sessionTokenSub.next(token)
    this.syncNativeSessionToken()
    // Hand the token to the Tauri media proxy so /uploads/* <img>/<a> requests it injects the Bearer
    // header. Fire-and-forget — if the proxy is briefly stale the worst case is a 401 image; never block
    // login on it. No-op in the browser (isTauri()).
    if (isTauri()) tauriInvoke('set_session_token', { token }).catch(() => {})
  }

  /** Read the persisted session token, or null. Browser build is pure-httpOnly → the token never lives
   *  in JS storage, so this returns null (login state comes from the presence cookie, see isLoggedIn).
   *  Native reads sessionStorage first so a non-keep tab doesn't pick up a stale keep-tab token. */
  private readSessionToken(): string | null {
    if (!isTauri()) return null
    return sessionStorage.getItem(SESSION_TOKEN) || localStorage.getItem(SESSION_TOKEN)
  }

  /** Clear local session state + notify native. Native: drop the stored token (per isKeep) + push null
   *  to Android/Rust so native SSE + the media proxy stop authenticating. Browser (pure httpOnly): the
   *  httpOnly cookie can't be cleared from JS (the backend clears it on logout, or it's overwritten on
   *  next login), so only the JS-readable presence cookie is dropped — enough for isLoggedIn() to flip. */
  clearToken() {
    this._sessionToken = null
    if (isTauri()) {
      if (this._isKeep) localStorage.removeItem(SESSION_TOKEN)
      else sessionStorage.removeItem(SESSION_TOKEN)
      this.syncNativeSessionToken()
      // Clear the proxy's stashed token so a logged-out shell can't fetch media. No-op in the browser.
      tauriInvoke('clear_session_token').catch(() => {})
    } else {
      this.clearPresenceCookie()
    }
    this._sessionTokenSub.next(null)
  }

  logout() {
    if (!this.isLoggedIn()) return EMPTY
    // Native: unregister push BEFORE clearing the token, so DELETE /devices/register still carries the
    // credential (the interceptor injects it from _sessionToken). Best-effort — a stale token is pruned
    // server-side on the next send anyway. Browser: push/webpush are no-ops in the shell.
    this.push.unregister()
    void this.webPush.unregister()
    // Capture the raw token before clearing (native only — null on browser, where the backend resolves
    // the session from the httpOnly cookie).
    const sessionToken = this._sessionToken
    this.clearToken()
    // Drop the in-memory session → UserService's lifecycle effect closes + deletes this user's DB.
    this.userService.clearSession()
    return this.http.post<LogoutRes>(
      `${apiPrefix()}/auth/logout`,
      sessionToken ? { sessionToken } : {},
    )
  }

  /** Change password: the server invalidates ALL sessions (`invalidateAllSessions` revokes every session
   *  token row + bumps tokenVersion) and returns a legacy access/refresh pair — but NO new session token.
   *  The current device's session token is dead, so drop it + re-login for a fresh one. (Online clients
   *  also receive a FORCE_LOGOUT frame, whose handler calls redoLoginAuth too — this is the immediate
   *  path for the device that initiated the change.) */
  changePassword(params: { oldPassword: string, newPassword: string }) {
    return this.http.post<LogoutRes>(
      `${apiPrefix()}/auth/change-password`, params
    ).pipe(tap((res) => {
      if (res.code === 0) this.redoLoginAuth()
    }))
  }

  /** List the current user's active sessions. Every request carries the session token (the interceptor),
   *  so the server can flag the requesting row `isCurrent`. */
  getSessions() {
    return this.http.post<{ code: number, message: string, data?: SessionInfo[] }>(
      `${apiPrefix()}/auth/sessions`, {},
    )
  }

  /** Revoke a single session by its device-list row id. Ownership is verified server-side. */
  revokeSession(id: number) {
    return this.http.post<{ code: number, message: string }>(
      `${apiPrefix()}/auth/revoke-session`, { id },
    )
  }

  /** Client kind for the session-token lifetime policy + the device-list badge: the Android Tauri shell is
   *  'app' (no-expiry, native secure store), the desktop Tauri shell is 'desktop', the browser is 'web'. */
  private resolveClient(): SessionClient {
    if (isAndroidNative()) return 'app'
    if (isTauri()) return 'desktop'
    return 'web'
  }

  /** Human-readable label for this device/browser, sent on login so the Active-sessions list shows a
   *  recognizable name instead of an opaque uuid. Best-effort navigator.userAgent parse (dependency-free);
   *  stable per device so re-login keeps the same label. */
  private getDeviceLabel(): string {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    const os =
      /Windows NT/i.test(ua) ? 'Windows'
        : /iPhone|iPad|iPod|iOS/i.test(ua) ? 'iOS'
          : /Mac OS X/i.test(ua) ? 'macOS'
            : /Android/i.test(ua) ? 'Android'
              : /CrOS/i.test(ua) ? 'ChromeOS'
                : /Linux/i.test(ua) ? 'Linux'
                  : (typeof navigator !== 'undefined' && navigator.platform) || 'Unknown'
    if (isAndroidNative()) return 'Android'        // native app — the OS is the device identity
    if (isTauri()) return `Desktop · ${os}`         // Tauri desktop shell
    const browser =
      /Edg\//i.test(ua) ? 'Edge'
        : /OPR\//i.test(ua) ? 'Opera'
          : /Chrome\//i.test(ua) ? 'Chrome'
            : /Firefox\//i.test(ua) ? 'Firefox'
              : /Safari\//i.test(ua) ? 'Safari'
                : 'Browser'
    return `${browser} · ${os}`
  }
}

/** The client kind, selecting the session-token lifetime policy server-side and shown as a badge in the
 *  device list. Mirrors the backend LoginDto.client union. */
export type SessionClient = 'app' | 'web' | 'desktop';

/** One row of GET /auth/sessions — the active-session credential behind the "Devices" settings page.
 *  Dates arrive as ISO strings (Prisma DateTime over the wire); `expiresAt` is null for no-expiry app
 *  tokens. `isCurrent` is server-stamped against the requesting session token. */
export interface SessionInfo {
  id: number;
  client: SessionClient;
  device: string | null;
  userAgent: string | null;
  ip: string | null;
  lastSeenIp: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  isCurrent: boolean;
}
