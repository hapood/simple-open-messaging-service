import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, Observable, finalize, shareReplay, tap } from 'rxjs';
import { RouteService, RoutePage } from './route.service';
import { apiPrefix } from './constants';

const TOKEN_CREATE_TIME = "token_create_time",
  REFRESH_TOKEN = 'refresh_token', SEVEN_DAY_TIME = 7 * 24 * 60 * 60 * 1000,
  IS_KEEP_LOGIN = "is_keep_login"

type RefreshTokenRes = { code: number, message: string, data?: { access_token: string, refresh_token: string } }
type AccessTokenRes = { code: number, message: string, data?: { access_token: string, refresh_token: string } }

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private _tokenCreateTime = localStorage.getItem(TOKEN_CREATE_TIME)
  private _isKeep = localStorage.getItem(IS_KEEP_LOGIN) === '1' || false
  private _isReReTk = false
  private _renewAccessInFlight?: Observable<AccessTokenRes>
  private _timerHandler: ReturnType<typeof setTimeout> | undefined = undefined
  private _lastAccTok: string | undefined
  public acTkSub = new BehaviorSubject<{ lastToken: string | undefined, nextToken: string } | undefined>(undefined)

  constructor(private http: HttpClient, private routeService: RouteService) {
    const tkCrtTm = this._tokenCreateTime
    if (tkCrtTm !== null) {
      const leftTime = new Date().getTime() - parseInt(tkCrtTm)
      if (leftTime < SEVEN_DAY_TIME) {
        this.setTimerToRefresh(leftTime)
      } else {
        this.setTimerToRefresh(SEVEN_DAY_TIME)
      }
    }
  }

  login(params: { uniqName: string, password: string, isKeep: boolean }) {
    return this.http.post<RefreshTokenRes>
      (`${apiPrefix}/auth/login`, params, { 'headers': { Authorization: 'public' } }).pipe(tap((res) => {
        if (res.code === 0) {
          const data = res.data
          this._isKeep = params.isKeep
          this.clearToken()
          this.setReToken(data!.refresh_token, params.isKeep)
          this.setAcToken(data!.access_token)
        }
      }))
  }

  redoLoginAuth() {
    this.clearToken()
    this.routeService.redirect(RoutePage.AUTH_LOGIN)
  }

  /**
   * 刷新 access token：走 renew-access（后端会轮换 refresh）。
   * 返回 Observable 供拦截器 await 后用新 token 重试；单飞：并发 401 共享同一在飞请求(shareReplay)。
   * 成功→存新 access + 轮换后的 refresh；code 10006(重用)/10003(失效) 等 → redoLoginAuth 强制重登。
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
    this.acTkSub.next(undefined)
    const req$ = this.http.post<AccessTokenRes>(
      `${apiPrefix}/auth/renew-access`,
      { refreshToken: rfToken },
      { 'headers': { Authorization: 'public' } },
    ).pipe(
      tap((res) => {
        if (res.code === 0) {
          this.setAcToken(res.data!.access_token)
          this.setReToken(res.data!.refresh_token)
        } else {
          // 10006 重用(家族已吊销) / 10003 invalid|expired 等 → 强制重登
          this.redoLoginAuth()
        }
      }),
      finalize(() => { this._renewAccessInFlight = undefined }),
      shareReplay(1),
    )
    this._renewAccessInFlight = req$
    return req$
  }

  renewRefreshToken() {
    if (this._isReReTk === true) {
      return
    }
    this.acTkSub.next(undefined)
    const rfToken = this.getRefreshToken()
    if (rfToken === undefined) {
      this.redoLoginAuth()
    } else {
      this.http.post<RefreshTokenRes>
        (`${apiPrefix}/auth/renew-refresh`, {
          refreshToken: rfToken
        }, { 'headers': { Authorization: 'public' } }).subscribe({
          next: ({ code, message, data }) => {
            if (code === 0) {
              this.setAcToken(data!.access_token)
              this.setReToken(data!.refresh_token)
            } else {
              console.info(message)
              this.redoLoginAuth()
            }
          }, complete: () => {
            this._isReReTk = false
          }
        }
        )
    }
  }

  setAcToken(accessToken: string) {
    this.acTkSub.next({ lastToken: this._lastAccTok, nextToken: accessToken })
    this._lastAccTok = accessToken
  }

  setReToken(refreshToken: string, isKeep?: boolean) {
    if (isKeep === true) {
      this._isKeep = true
      localStorage.setItem(IS_KEEP_LOGIN, '1')
    } else if (isKeep === false) {
      this._isKeep = false
      localStorage.removeItem(IS_KEEP_LOGIN)
    }
    const curIsKeep = this._isKeep
    if (curIsKeep) {
      localStorage.setItem(REFRESH_TOKEN, refreshToken)
      localStorage.setItem(TOKEN_CREATE_TIME, new Date().getTime().toString())
    } else {
      sessionStorage.setItem(REFRESH_TOKEN, refreshToken)
    }
    this.setTimerToRefresh(SEVEN_DAY_TIME)
  }

  setTimerToRefresh(leftTime: number) {
    if (this._timerHandler !== undefined) {
      clearTimeout(this._timerHandler)
    }
    this._timerHandler = setTimeout(() => {
      this.renewRefreshToken()
    }, leftTime)
  }

  getRefreshToken(): string | undefined {
    return sessionStorage.getItem(REFRESH_TOKEN) || localStorage.getItem(REFRESH_TOKEN) || undefined
  }

  isLoggedIn(): boolean {
    return this.getRefreshToken() !== undefined
  }

  clearToken() {
    this._lastAccTok = undefined
    this.acTkSub.next(undefined)
    sessionStorage.removeItem(REFRESH_TOKEN)
    localStorage.removeItem(REFRESH_TOKEN)
    localStorage.removeItem(TOKEN_CREATE_TIME)
    if (this._timerHandler !== undefined) {
      clearTimeout(this._timerHandler)
      this._timerHandler = undefined
    }
  }

  logout() {
    const refreshToken = this.getRefreshToken()
    if (refreshToken) {
      this.clearToken()
      return this.http.post<{ code: number; message: string }>(`${apiPrefix}/auth/logout`, {
        refreshToken
      }, { 'headers': { Authorization: 'public' } })
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
}
