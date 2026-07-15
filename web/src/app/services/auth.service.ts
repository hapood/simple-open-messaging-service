import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, tap } from 'rxjs';
import { RouteService, RoutePage } from './route.service';
import { apiPrefix } from './constants';
import { isTauri, isAndroidNative, tauriInvoke } from './runtime';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';

const SESSION_TOKEN = 'session_token',
  IS_KEEP_LOGIN = 'is_keep_login'

type LoginRes = { code: number, message: string, data?: { session_token?: string } }
type LogoutRes = { code: number, message: string }

/**
 * The single long-lived web credential: one opaque per-device session token (sliding 30-day on
 * web/desktop) authenticates EVERY request via the interceptor's Bearer header — no access JWT, no
 * refresh token, no renewal. Issued at login; revoked at logout / logout-all / change-password
 * (`invalidateAllSessions` kills the row server-side + bumps tokenVersion); a 401 means the row is
 * revoked/expired → re-login (`redoLoginAuth`). There is no renew endpoint and no token rotation, so
 * there is no renew race, no refresh-reuse family, and no 15-min-expiry churn.
 *
 * **Persistence:** held in JS memory AND mirrored to storage (localStorage when "keep me logged in",
 * sessionStorage otherwise), REPLACING the old refresh token's storage role so a page refresh survives.
 * The XSS tradeoff is identical to the refresh-token-before-it (both are 14–30d storage-resident,
 * both grabbable by an XSS) — the session model is strictly simpler. The same token also auths the
 * httpOnly media cookie (the backend sets it from this token) + the Rust media proxy
 * (`set_session_token` on desktop) + Kotlin's `/events` (pushed via `syncNativeSessionToken` on Android).
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

  /** True when a session token is held (persisted across refresh per "keep me logged in"). */
  isLoggedIn(): boolean {
    return this._sessionToken !== null
  }

  login(params: { account: string, password: string, isKeep: boolean }) {
    // isKeep is the frontend's "keep me logged in" storage policy (whether the session token lives in
    // localStorage or sessionStorage). The backend does not consume it, so it is stripped from the
    // request body; it is still used after success to decide where to persist the token.
    const { isKeep, ...credentials } = params
    // `client` selects the session-token lifetime policy (app=no-expiry, web/desktop=sliding 30d) and is
    // shown as a badge in the device list; `device` is a human-readable label for that list (distinct from
    // the device_id uuid, which is the push-token device identifier).
    return this.http.post<LoginRes>(
      `${apiPrefix()}/auth/login`, {
        ...credentials,
        client: this.resolveClient(),
        device: this.getDeviceLabel(),
      }).pipe(tap((res) => {
        if (res.code === 0 && res.data?.session_token) {
          this._isKeep = isKeep
          // Fresh login: clear both stores so an isKeep switch leaves no orphaned old token.
          sessionStorage.removeItem(SESSION_TOKEN)
          localStorage.removeItem(SESSION_TOKEN)
          if (isKeep) localStorage.setItem(IS_KEEP_LOGIN, '1')
          else localStorage.removeItem(IS_KEEP_LOGIN)
          this.setSessionToken(res.data.session_token)
          // Now that the session token is active, register (or re-register) this device's FCM token so
          // the server can push to it. No-op outside the Tauri shell.
          this.push.onLogin()
          // Web Push (browser/PWA) — also re-attempts subscription post-login. No-op in the Tauri shell.
          void this.webPush.onLogin()
        }
      }))
  }

  redoLoginAuth() {
    this.clearToken()
    this.routeService.redirect(RoutePage.AUTH_LOGIN)
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

  /** Read the persisted session token (sessionStorage first so a non-keep tab doesn't read a stale
   *  keep-tab token), or null when none / not logged in. */
  private readSessionToken(): string | null {
    return sessionStorage.getItem(SESSION_TOKEN) || localStorage.getItem(SESSION_TOKEN)
  }

  /** Clear THIS tab's session token (storage per isKeep + in-memory + native + media proxy). */
  clearToken() {
    this._sessionToken = null
    if (this._isKeep) localStorage.removeItem(SESSION_TOKEN)
    else sessionStorage.removeItem(SESSION_TOKEN)
    this._sessionTokenSub.next(null)
    this.syncNativeSessionToken()
    // Clear the proxy's stashed token so a logged-out shell can't fetch media. No-op in the browser.
    if (isTauri()) tauriInvoke('clear_session_token').catch(() => {})
  }

  logout() {
    const sessionToken = this._sessionToken
    if (sessionToken) {
      // Unregister the FCM token BEFORE clearing the session token, so the DELETE /devices/register
      // still carries the Authorization header. Best-effort — a stale token is pruned server-side on the
      // next send anyway. No-op outside the Tauri shell.
      this.push.unregister()
      // Web Push (browser/PWA) — unsubscribe + unregister the endpoint. No-op in the Tauri shell.
      void this.webPush.unregister()
      this.clearToken()
      // Drop the in-memory session → UserService's lifecycle effect closes + deletes this user's DB.
      this.userService.clearSession()
      return this.http.post<LogoutRes>(`${apiPrefix()}/auth/logout`, { sessionToken })
    }
    return EMPTY
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
