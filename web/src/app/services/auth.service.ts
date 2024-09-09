import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, of, tap } from 'rxjs';
import { RouteService, RoutePage } from './route.service';
import { apiPrefix } from './constants';

const TOKEN_CREATE_TIME = "token_create_time",
  REFRESH_TOKEN = 'refresh_token', SEVEN_DAY_TIME = 7 * 24 * 60 * 60 * 1000,
  IS_KEEP_LOGIN = "is_keep_login"

type RefreshTokenRes = { status: number, message: string, data?: { access_token: string, refresh_token: string } }
type AccessTokenRes = { status: number, message: string, data?: { access_token: string } }

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private _tokenCreateTime = localStorage.getItem(TOKEN_CREATE_TIME)
  private _isKeep = localStorage.getItem(IS_KEEP_LOGIN) === '1' || false
  private _isReReTk = false
  private _isReACTk = false
  private _timerHandler: ReturnType<typeof setTimeout> | undefined = undefined
  private _lastAccTok: string | undefined
  public acTkSub = new BehaviorSubject<{ lastToken: string | undefined, nextToken: string } | undefined>(undefined)

  constructor(private http: HttpClient, private routeService: RouteService) {
    const tkCrtTm = this._tokenCreateTime
    if (tkCrtTm !== null) {
      const leftTime = new Date().getTime() - parseInt(tkCrtTm)
      if (leftTime < SEVEN_DAY_TIME) {
        this.setTimerToRefresh(leftTime)
      }
    }
  }

  login(params: { uniqName: string, password: string, isKeep: boolean }) {
    return this.http.post<RefreshTokenRes>
      (`${apiPrefix}/auth/login`, params, { 'headers': { Authorization: 'public' } }).pipe(tap((res) => {
        if (res.status === 0) {
          console.log(res)
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

  renewAccessToken() {
    if (this._isReACTk === true) {
      return
    }
    this.acTkSub.next(undefined)
    const rfToken = this.getRefreshToken()
    if (rfToken === undefined) {
      this.redoLoginAuth()
    } else {
      this.http.post<AccessTokenRes>
        (`${apiPrefix}/auth/renew-access`, {
          refreshToken: rfToken
        }, { 'headers': { Authorization: 'public' } }).subscribe({
          next: ({ status, message, data }) => {
            this._isReACTk = false
            if (status === 0) {
              this.setAcToken(data!.access_token)
            } else {
              console.info(message)
              this.redoLoginAuth()
            }
          },
          error: () => {
            this._isReACTk = false
          }
        })
    }
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
          next: ({ status, message, data }) => {
            if (status === 0) {
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
    this.clearToken()
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

  clearToken() {
    this._lastAccTok = undefined
    this.acTkSub.next(undefined)
    sessionStorage.removeItem(REFRESH_TOKEN)
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
      return this.http.post<{ access_token: string }>(`${apiPrefix}/auth/logout`, {
        refreshToken
      }, { 'headers': { Authorization: 'public' } })
    }
    return of(EMPTY)
  }
}
