import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, of, switchMap, tap } from 'rxjs';

const TOKEN_CREATE_TIME = "token_create_time",
  REFRESH_TOKEN = 'refresh_token', ACCESS_TOKEN = 'access_token',
  SEVEN_DAY_TIME = 7 * 24 * 60 * 60 * 1000

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  prefix = 'http://127.0.0.1:3000'
  private _token = sessionStorage.getItem(ACCESS_TOKEN) || localStorage.getItem(ACCESS_TOKEN)
  private _tokenCreateTime = localStorage.getItem(TOKEN_CREATE_TIME)
  private _isKeep = false
  private _isRefresh = false
  private _timerHandler: ReturnType<typeof setTimeout> | undefined = undefined

  constructor(private http: HttpClient) {
    const tkCrtTm = this._tokenCreateTime
    if (tkCrtTm !== null) {
      const leftTime = new Date().getTime() - parseInt(tkCrtTm)
      if (leftTime < SEVEN_DAY_TIME) {
        this.setTimerToRefresh(leftTime)
      }
    }
  }

  login(params: { username: string, password: string }) {
    return this.http.post<{ access_token: string, refresh_token: string }>
      (`${this.prefix}/auth/login`, params)
  }

  renewAccessToken() {
    return this.http.post<{ access_token: string }>
      (`${this.prefix}/auth/renew-access`, {
        refreshToken: this.getRefreshToken()
      }).pipe(tap(res => {
        this.setToken(res.access_token)
      }), switchMap(res => res.access_token))
  }

  renewRefreshToken() {
    if (this._isRefresh !== true) {
      return this.http.post<{ access_token: string, refresh_token: string }>
        (`${this.prefix}/auth/renew-refresh`, {
          refreshToken: this.getRefreshToken()
        })
        .pipe(tap(res => {
          this.setToken(res.access_token, res.refresh_token)
        }), catchError(err => {
          console.error(err)
          this.clearToken()
          this._isRefresh = false
          return of(null)
        }))
    } else {
      return of(null)
    }
  }

  setToken(accessToken: string, refreshToken?: string, isKeep?: boolean) {
    this.clearToken()
    this._token = accessToken
    if (isKeep || this._isKeep === true) {
      this._isKeep = true
      localStorage.setItem(ACCESS_TOKEN, accessToken)
      if (refreshToken !== undefined) {
        this.setTimerToRefresh(SEVEN_DAY_TIME)
        localStorage.setItem(REFRESH_TOKEN, refreshToken)
        localStorage.setItem(TOKEN_CREATE_TIME, new Date().getTime().toString())
      }
    } else {
      sessionStorage.setItem(ACCESS_TOKEN, accessToken)
      if (refreshToken !== undefined) {
        this.setTimerToRefresh(SEVEN_DAY_TIME)
        sessionStorage.setItem(REFRESH_TOKEN, refreshToken)
      }
    }
  }

  setTimerToRefresh(leftTime: number) {
    if (this._timerHandler !== undefined) {
      clearTimeout(this._timerHandler)
    }
    this._timerHandler = setTimeout(() => {
      this.renewRefreshToken().subscribe()
    }, leftTime)
  }

  getToken() {
    return this._token
  }

  getRefreshToken(): string | null {
    return sessionStorage.getItem(REFRESH_TOKEN) || localStorage.getItem(REFRESH_TOKEN)
  }

  clearToken() {
    sessionStorage.removeItem(ACCESS_TOKEN)
    sessionStorage.removeItem(REFRESH_TOKEN)
    localStorage.removeItem(ACCESS_TOKEN)
    localStorage.removeItem(TOKEN_CREATE_TIME)
    if (this._timerHandler !== undefined) {
      clearTimeout(this._timerHandler)
      this._timerHandler = undefined
    }
  }

  register(params: { username: string, password: string }) {
    return this.http.post<{ access_token: string }>(`${this.prefix}/auth/login`, params)
  }
}
