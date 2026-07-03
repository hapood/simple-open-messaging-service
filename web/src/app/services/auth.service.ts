import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, Observable, finalize, shareReplay, tap } from 'rxjs';
import { RouteService, RoutePage } from './route.service';
import { apiPrefix } from './constants';

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
 * Token 管理（简化版）：
 * - 统一只走 `/auth/renew-access`（后端 renew-access 与 renew-refresh 完全同义，会同时轮换 refresh）。
 *   access 15m 过期 → 被动刷新；每次 renew-access 也轮换 refresh，故无需 7 天主动刷新。
 * - 删掉旧的 7 天定时器 / renewRefreshToken / tokenCreateTime 机制（曾滋生 _connecting 锁死、401 死循环、
 *   非记住登录定时器失效等多条 bug）。
 * - acTkSub = 当前 access token（或 null）。拦截器有 token 直接用；无 token 主动驱动 renewAccessToken（有确定
 *   终点，失败→redoLoginAuth→放弃请求），不再靠「等 acTkSub 推非空」从而杜绝永挂。
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
  /** 当前 access token；null = 无 token（启动期 / renew 进行中）。拦截器据此决定直接发还是先 renew。 */
  public acTkSub = new BehaviorSubject<string | null>(null)

  constructor(private http: HttpClient, private routeService: RouteService) {
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

  /** 当前 access token（同步快照），供拦截器无延迟判断。 */
  get accessToken(): string | null {
    return this.acTkSub.value
  }

  login(params: { uniqName: string, password: string, isKeep: boolean }) {
    // isKeep 是前端"记住登录"的本地存储策略（refresh token 存 localStorage 还是 sessionStorage），
    // 后端不消费，故从请求体剥离；仍用于成功后决定 token 落盘位置。
    const { isKeep, ...credentials } = params;
    return this.http.post<AccessTokenRes>
      (`${apiPrefix}/auth/login`, { ...credentials, device: this.getDeviceId() }).pipe(tap((res) => {
        if (res.code === 0) {
          const data = res.data!
          this._isKeep = isKeep
          // 全新登录：清两处存储，避免 isKeep 切换留下旧 token 孤儿。
          // （与登出 clearToken「仅清本 tab」区分——登出要尊重同账号其它 tab 的独立 session。）
          sessionStorage.removeItem(REFRESH_TOKEN)
          localStorage.removeItem(REFRESH_TOKEN)
          this.setReToken(data.refresh_token, isKeep)
          this.setAcToken(data.access_token)
        }
      }))
  }

  redoLoginAuth() {
    this.clearToken()
    this.routeService.redirect(RoutePage.AUTH_LOGIN)
  }

  /**
   * 刷新 access token：走 renew-access（后端会轮换 refresh）。
   * 单飞：并发调用共享同一在飞请求（shareReplay bufferSize:1）；
   * refCount:true → 最后一个订阅取消时拆内层订阅，避免长驻 service 下的内存泄漏；
   * finalize → 完成后清 _renewAccessInFlight，使下一次过期触发全新 renew。
   * 成功→存新 access + 轮换后的 refresh；code≠0（重用 10006 / 失效 10003 等）→ redoLoginAuth 强制重登。
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
    this.acTkSub.next(null) // 暂停受保护请求，等新 token
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
   * 只清当前 tab 的 token 存储（按 isKeep 选 sessionStorage/localStorage）：
   * 一个非记住 tab 登出不再误清另一记住 tab 共享的 localStorage token。
   * sessionStorage 本就 per-tab，故仅 localStorage 场景需注意——这里按当前 isKeep 精准清理。
   */
  clearToken() {
    this.acTkSub.next(null)
    this._accessSetAt = null
    if (this._isKeep) {
      localStorage.removeItem(REFRESH_TOKEN)
    } else {
      sessionStorage.removeItem(REFRESH_TOKEN)
    }
  }

  logout() {
    const refreshToken = this.getRefreshToken()
    if (refreshToken) {
      this.clearToken()
      return this.http.post<{ code: number; message: string }>(`${apiPrefix}/auth/logout`, {
        refreshToken
      })
    }
    return EMPTY
  }

  /** 改密：成功后服务端吊销其他会话并返回新登录对，本地替换为新 token。 */
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

  /** 会话管理：列活跃会话 / 踢单个设备。 */
  getSessions() {
    return this.http.post<{ code: number, message: string, data?: any[] }>(`${apiPrefix}/auth/sessions`, {})
  }
  revokeSession(jti: string) {
    return this.http.post<{ code: number, message: string }>(`${apiPrefix}/auth/revoke-session`, { jti })
  }

  /** 设备标识：localStorage 持久 uuid（区分多端会话）。 */
  private getDeviceId(): string {
    let id = localStorage.getItem('device_id')
    if (!id) {
      id = crypto.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2))
      localStorage.setItem('device_id', id)
    }
    return id
  }
}
