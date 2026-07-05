import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, Observable, finalize, shareReplay, tap } from 'rxjs';
import { RouteService, RoutePage } from './route.service';
import { apiPrefix } from './constants';
import { isTauri, tauriInvoke } from './runtime';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { uuid } from '../lib/uuid';

const REFRESH_TOKEN = 'refresh_token',
  IS_KEEP_LOGIN = 'is_keep_login'

type AccessTokenRes = { code: number, message: string, data?: { access_token: string, refresh_token: string } }

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

  constructor(
    private http: HttpClient,
    private routeService: RouteService,
    private push: PushService,
    private webPush: WebPushService,
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

  login(params: { uniqName: string, password: string, isKeep: boolean }) {
    // isKeep is the frontend's "keep me logged in" storage policy (whether the refresh token lives in
    // localStorage or sessionStorage). The backend does not consume it, so it is stripped from the
    // request body; it is still used after success to decide where to persist the token.
    const { isKeep, ...credentials } = params;
    return this.http.post<AccessTokenRes>
      (`${apiPrefix}/auth/login`, { ...credentials, device: this.getDeviceId() }).pipe(tap((res) => {
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
      `${apiPrefix}/auth/renew-access`,
      { refreshToken: rfToken, device: this.getDeviceId() },
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
      return this.http.post<{ code: number; message: string }>(`${apiPrefix}/auth/logout`, {
        refreshToken
      })
    }
    return EMPTY
  }

  /** Change password: on success the server revokes other sessions and returns a fresh login pair; the
   *  local tokens are replaced with the new ones. */
  changePassword(params: { oldPassword: string, newPassword: string }) {
    return this.http.post<{ code: number, message: string, data?: { access_token: string, refresh_token: string } }>(
      `${apiPrefix}/auth/change-password`, params
    ).pipe(tap((res) => {
      if (res.code === 0) {
        this.setAcToken(res.data!.access_token)
        this.setReToken(res.data!.refresh_token)
      }
    }))
  }

  /** Session management: list active sessions / kick a single device. */
  getSessions() {
    return this.http.post<{ code: number, message: string, data?: any[] }>(`${apiPrefix}/auth/sessions`, {})
  }
  revokeSession(jti: string) {
    return this.http.post<{ code: number, message: string }>(`${apiPrefix}/auth/revoke-session`, { jti })
  }

  /** Device identifier: a persistent localStorage uuid (distinguishes multi-device sessions). */
  private getDeviceId(): string {
    let id = localStorage.getItem('device_id')
    if (!id) {
      id = uuid()
      localStorage.setItem('device_id', id)
    }
    return id
  }
}
