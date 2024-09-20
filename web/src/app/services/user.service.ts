import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { User, QueryUserThreadParams, MsgThread } from './model'

export type { User } from './model'

@Injectable({
  providedIn: 'root',
})
export class UserService {
  sessionProfile = signal<User | undefined>(undefined)
  constructor(private http: HttpClient) {
  }

  updateSessionProfile() {
    this.getMyProfile().subscribe({
      next: profile => {
        this.sessionProfile.set(profile)
      },
      error: (err) => {
        console.error(err)
      }
    })
  }

  register(params: { uniqName: string, password: string }) {
    return this.http.post<{ status: number, message: string, data?: { id: number, uniqName: string } }>(`${apiPrefix}/user/register`,
      params, { 'headers': { Authorization: 'public' } })
  }

  getMyProfile() {
    return this.http.post<User>(`${apiPrefix}/user/my-profile`, {})
  }

  queryUserThreadValid(params: QueryUserThreadParams) {
    return this.http.post<{ status: number, message: string, data?: MsgThread[] }>(`${apiPrefix}/user/query-thread/valid`, params)
  }

  queryUserInfo(params: { userIds: number[] }) {
    return this.http.post<{ status: number, message: string, data?: User[] }>(`${apiPrefix}/user/query`, params)
  }

  getUserInfoByUniqName(params: { uniqName: string }) {
    return this.http.post<{ status: number, message: string, data?: User }>(`${apiPrefix}/user/by-uniq-name`, params)
  }
}
