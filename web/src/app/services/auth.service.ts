import { Injectable } from '@angular/core';
import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { BehaviorSubject, EMPTY, Observable, finalize, shareReplay, tap } from 'rxjs';
import { RouteService, RoutePage } from './route.service';
import { apiPrefix } from './constants';
import { isTauri, isAndroidNative, tauriInvoke } from './runtime';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';
import { uuid } from '../lib/uuid';

const REFRESH_TOKEN = 'refresh_token',
  IS_KEEP_LOGIN = 'is_keep_login'

type AccessTokenRes = { code: number, message: string, data?: { access_token: string, refresh_token: string, session_token?: string } }

/**
 * Per-request directive for {@link AuthInterceptor}: authenticate with the long-lived session token
 * instead of the short-lived access JWT. The server stamps the requesting session's id on req.user only
 * when the credential IS a session token, so `/auth/sessions` must present one for the device list to
 * flag the current row `isCurrent`. Device-management calls set this; everything else defaults to false
 * (the access-JWT path). When no session token is held (e.g. right after a page refresh, before a fresh
 * login reissues one) the interceptor falls back to the access JWT and `isCurrent` is simply false.
 */
export const USE_SESSION_TOKEN = new HttpContextToken(() => false);

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

/**
 * When the tab returns to the foreground, proactively renew the access token if it is likely stale.
 * The access TTL is 15m; renewing when the token was set more than 13m ago leaves a 2m skew margin.
 * The renew call also re-sets the httpOnly `media_token` cookie on the backend, so same-origin
 * /uploads/* <img>/<a> requests on the just-foregrounded tab stay authenticated instead of 401ing
 * until the next HttpClient call happens to refresh it. Conservative threshold + single-flight renew
 * keep this from churning (a quick tab switch does nothing; refresh rotation races are unchanged).
 */
const FOCUS_REFRESH_AFTER_MS = 13 * 60 * 1000

/**
 * Token management (simplified):
 * - Everything goes through `/auth/renew-access` (the backend's renew-access and renew-refresh are fully
 *   synonymous; both rotate the refresh token). Access tokens expire after 15m → passive refresh; every
 *   renew-access also rotates the refresh token, so there is no need for a 7-day proactive refresh.
 * - Removed the old 7-day timer / renewRefreshToken / tokenCreateTime machinery (it spawned multiple
 *   bugs: _connecting lock-up, 401 loops, keep-login timer stalling).
 * - acTkSub = the current access token (or null). The interceptor uses it directly when present; when
 *   absent it proactively drives renewAccessToken (which has a deterministic endpoint — on failure →
 *   redoLoginAuth → drop the request), instead of "waiting for acTkSub to emit non-null" which could
 *   hang forever.
 */
@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private _isKeep = localStorage.getItem(IS_KEEP_LOGIN) === '1' || false
  private _renewAccessInFlight?: Observable<AccessTokenRes>
  /** Wall-clock ms when the current access token was stored, or null when none is held. Drives the
   *  focus-refresh below; not decoded from the JWT (kept simple — see FOCUS_REFRESH_AFTER_MS). */
  private _accessSetAt: number | null = null
  /** Current access token (null = none held yet, e.g. during startup or an in-flight renew). The interceptor
   *  reads this to decide whether to send immediately or renew first. */
  public acTkSub = new BehaviorSubject<string | null>(null)

  /** The long-lived session token minted at login (the per-device credential behind the "Devices" list).
   *  Held in JS memory only — NOT persisted (an XSS-grabbable 30d token in storage is the cookie risk the
   *  bearer-in-memory model exists to avoid). Lost on page refresh; reissued by the next login, so the
   *  device-management calls simply fall back to the access JWT (isCurrent=false) until then. Phase 3 will
   *  promote this to the primary web credential. */
  private _sessionToken: string | null = null
  /** Current session token (synchronous snapshot), or null when none is held. */
  get sessionToken(): string | null { return this._sessionToken }

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
  ) {
    // Keep the access token (and thus the media cookie) fresh when the tab is foregrounded after
    // being idle long enough that the 15m token has likely expired. Guarded by a refresh-token check
    // so a logged-out tab focusing never triggers a redirect-to-login.
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  }

  private onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return
    const stale = this._accessSetAt === null || Date.now() - this._accessSetAt > FOCUS_REFRESH_AFTER_MS
    if (stale && this.getRefreshToken() !== undefined) {
      // Fire and forget — single-flight dedupes concurrent triggers; the tap stores the new token.
      this.renewAccessToken().subscribe()
    }
  }

  /** Current access token (synchronous snapshot), for the interceptor to check with no latency. */
  get accessToken(): string | null {
    return this.acTkSub.value
  }

  login(params: { account: string, password: string, isKeep: boolean }) {
    // isKeep is the frontend's "keep me logged in" storage policy (whether the refresh token lives in
    // localStorage or sessionStorage). The backend does not consume it, so it is stripped from the
    // request body; it is still used after success to decide where to persist the token.
    const { isKeep, ...credentials } = params;
    // `client` selects the session-token lifetime policy (app=no-expiry, web/desktop=sliding 30d) and is
    // shown as a badge in the device list; `device` is a human-readable label for that list (distinct from
    // the device_id uuid, which is the push-token device identifier).
    return this.http.post<AccessTokenRes>
      (`${apiPrefix()}/auth/login`, {
        ...credentials,
        client: this.resolveClient(),
        device: this.getDeviceLabel(),
      }).pipe(tap((res) => {
        if (res.code === 0) {
          const data = res.data!
          this._isKeep = isKeep
          // Fresh login: clear both stores so an isKeep switch leaves no orphaned old token.
          // (Contrast with logout's clearToken, which clears only THIS tab — logout must respect the
          // independent sessions of other tabs on the same account.)
          sessionStorage.removeItem(REFRESH_TOKEN)
          localStorage.removeItem(REFRESH_TOKEN)
          this.setReToken(data.refresh_token, isKeep)
          this.setAcToken(data.access_token)
          this._sessionToken = data.session_token ?? null
          // Hand the session token to the Android shell so Kotlin's RealtimeService can authenticate
          // /events (no-op on web/desktop, which have no native connection).
          this.syncNativeSessionToken()
          // Now that the access token is in the interceptor, register (or re-register) this device's
          // FCM token so the server can push to it. No-op outside the Tauri shell.
          this.push.onLogin()
          // Web Push (browser/PWA) — also re-attempts subscription post-login. No-op in Tauri shell.
          void this.webPush.onLogin()
        }
      }))
  }

  redoLoginAuth() {
    this.clearToken()
    this.routeService.redirect(RoutePage.AUTH_LOGIN)
  }

  /**
   * Refresh the access token via renew-access (the backend rotates the refresh token too).
   * Single-flight: concurrent callers share the same in-flight request (shareReplay bufferSize:1);
   * refCount:true tears down the inner subscription once the last subscriber leaves, avoiding a leak
   * under a long-lived service; finalize clears _renewAccessInFlight so the next expiry triggers a
   * fresh renew. Success → store the new access + rotated refresh; code≠0 (reuse 10006 / invalidated
   * 10003, etc.) → redoLoginAuth forces a re-login.
   */
  renewAccessToken(): Observable<AccessTokenRes> {
    if (this._renewAccessInFlight) {
      return this._renewAccessInFlight
    }
    const rfToken = this.getRefreshToken()
    if (rfToken === undefined) {
      this.redoLoginAuth()
      return EMPTY
    }
    this.acTkSub.next(null) // pause protected requests until the new token arrives
    this._accessSetAt = null
    const req$ = this.http.post<AccessTokenRes>(
      `${apiPrefix()}/auth/renew-access`,
      { refreshToken: rfToken, device: this.getDeviceLabel() },
    ).pipe(
      tap((res) => {
        if (res.code === 0) {
          this.setAcToken(res.data!.access_token)
          this.setReToken(res.data!.refresh_token)
        } else {
          this.redoLoginAuth()
        }
      }),
      finalize(() => { this._renewAccessInFlight = undefined }),
      shareReplay({ bufferSize: 1, refCount: true }),
    )
    this._renewAccessInFlight = req$
    return req$
  }

  setAcToken(accessToken: string) {
    this._accessSetAt = Date.now()
    this.acTkSub.next(accessToken)
    // Hand the token to the Tauri media proxy so /uploads/* <img>/<a> requests it injects the
    // Bearer header. Fire-and-forget — if the proxy is briefly stale the worst case is a 401 image
    // that reloads on the next renew; never block login on it. No-op in the browser (isTauri()).
    if (isTauri()) tauriInvoke('set_access_token', { token: accessToken }).catch(() => {})
  }

  setReToken(refreshToken: string, isKeep?: boolean) {
    if (isKeep === true) {
      this._isKeep = true
      localStorage.setItem(IS_KEEP_LOGIN, '1')
    } else if (isKeep === false) {
      this._isKeep = false
      localStorage.removeItem(IS_KEEP_LOGIN)
    }
    if (this._isKeep) {
      localStorage.setItem(REFRESH_TOKEN, refreshToken)
    } else {
      sessionStorage.setItem(REFRESH_TOKEN, refreshToken)
    }
  }

  getRefreshToken(): string | undefined {
    return sessionStorage.getItem(REFRESH_TOKEN) || localStorage.getItem(REFRESH_TOKEN) || undefined
  }

  isLoggedIn(): boolean {
    return this.getRefreshToken() !== undefined
  }

  /**
   * Clears only THIS tab's token storage (sessionStorage or localStorage, per isKeep): a non-keep tab
   * logging out no longer wipes the localStorage token shared with another keep tab. sessionStorage is
   * already per-tab, so only the localStorage case needs care — here it is cleared precisely by isKeep.
   */
  clearToken() {
    this.acTkSub.next(null)
    this._accessSetAt = null
    this._sessionToken = null
    this.syncNativeSessionToken()
    if (this._isKeep) {
      localStorage.removeItem(REFRESH_TOKEN)
    } else {
      sessionStorage.removeItem(REFRESH_TOKEN)
    }
    // Clear the proxy's stashed token so a logged-out shell can't fetch media. No-op in the browser.
    if (isTauri()) tauriInvoke('clear_access_token').catch(() => {})
  }

  logout() {
    const refreshToken = this.getRefreshToken()
    if (refreshToken) {
      // Unregister the FCM token BEFORE clearing the access token, so the DELETE /devices/register
      // still carries the Authorization header. Best-effort — a stale token is pruned server-side on
      // the next send anyway. No-op outside the Tauri shell.
      this.push.unregister()
      // Web Push (browser/PWA) — unsubscribe + unregister the endpoint. No-op in the Tauri shell.
      void this.webPush.unregister()
      this.clearToken()
      // Drop the in-memory session → UserService's lifecycle effect closes + deletes this user's DB.
      this.userService.clearSession()
      return this.http.post<{ code: number; message: string }>(`${apiPrefix()}/auth/logout`, {
        refreshToken
      })
    }
    return EMPTY
  }

  /** Change password: on success the server revokes every session (including this device's session token)
   *  and returns a fresh access/refresh pair — but NOT a new session token. Drop the now-revoked session
   *  token so the device-management calls don't present a dead credential; the next login reissues one. */
  changePassword(params: { oldPassword: string, newPassword: string }) {
    return this.http.post<{ code: number, message: string, data?: { access_token: string, refresh_token: string } }>(
      `${apiPrefix()}/auth/change-password`, params
    ).pipe(tap((res) => {
      if (res.code === 0) {
        this.setAcToken(res.data!.access_token)
        this.setReToken(res.data!.refresh_token)
        this._sessionToken = null
        this.syncNativeSessionToken()
      }
    }))
  }

  /** List the current user's active sessions. Auths with the session token ({@link USE_SESSION_TOKEN}) so
   *  the server can flag the requesting row `isCurrent`; falls back to the access JWT (no isCurrent) when
   *  no session token is held. */
  getSessions() {
    return this.http.post<{ code: number, message: string, data?: SessionInfo[] }>(
      `${apiPrefix()}/auth/sessions`, {},
      { context: new HttpContext().set(USE_SESSION_TOKEN, true) },
    )
  }

  /** Revoke a single session by its device-list row id. Same session-token auth so the server records the
   *  revocation against the requester's own session lineage; ownership is verified server-side. */
  revokeSession(id: number) {
    return this.http.post<{ code: number, message: string }>(
      `${apiPrefix()}/auth/revoke-session`, { id },
      { context: new HttpContext().set(USE_SESSION_TOKEN, true) },
    )
  }

  /** Push-device identifier: a persistent localStorage uuid used to dedup the FCM/Web-Push endpoint
   *  registration. Unrelated to the session `device` label — do not reuse it for that (it is opaque, not
   *  human-readable). */
  private getDeviceId(): string {
    let id = localStorage.getItem('device_id')
    if (!id) {
      id = uuid()
      localStorage.setItem('device_id', id)
    }
    return id
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
    if (isTauri()) return `Desktop · ${os}`                // Tauri desktop shell
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
