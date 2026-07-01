import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { User, QueryUserThreadParams, ConversationItem, FriendshipWithPeer, StandardResponse } from './model'

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
      next: res => {
        this.sessionProfile.set(res.data)
      },
      error: (err) => {
        console.error(err)
      }
    })
  }

  register(params: { uniqName: string, password: string }) {
    return this.http.post<{ code: number, message: string, data?: { id: number, uniqName: string } }>(`${apiPrefix}/user/register`,
      params)
  }

  getMyProfile() {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/my-profile`, {})
  }

  /** 上传并绑定当前用户头像（multipart file → 后端 sharp 多档重写）。成功后调 updateSessionProfile() 刷新本地。 */
  updateAvatar(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    return this.http.post<StandardResponse<{ avatar: string }>>(`${apiPrefix}/user/update-avatar`, fd)
  }

  /** 更新当前用户昵称/简介。成功后调 updateSessionProfile() 刷新本地。 */
  updateProfile(params: { name?: string, bio?: string }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/update-profile`, params)
  }

  queryUserThreadValid(params: QueryUserThreadParams) {
    return this.http.post<StandardResponse<ConversationItem[]>>(`${apiPrefix}/user/query-thread/valid`, params)
  }

  queryUserInfo(params: { userIds: number[] }) {
    return this.http.post<StandardResponse<User[]>>(`${apiPrefix}/user/query`, params)
  }

  getUserInfoByUniqName(params: { uniqName: string }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/by-uniq-name`, params)
  }

  sendFriendRequest(params: { userId: number }) {
    return this.http.post<StandardResponse<User>>(`${apiPrefix}/user/send-friend-request`, params)
  }

  queryToPending(params: {
    take: number, beforeDate: number
  }) {
    return this.http.post<StandardResponse<FriendshipWithPeer[]>>(`${apiPrefix}/user/query-thread/to-pending`, params)
  }

  queryFromPending(params: {
    take: number, beforeDate: number
  }) {
    return this.http.post<StandardResponse<FriendshipWithPeer[]>>(`${apiPrefix}/user/query-thread/from-pending`, params)
  }

  approveFriendRequest(params: { userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/user/approve-friend-request`, params)
  }

  declineFriendRequest(params: { userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/user/decline-friend-request`, params)
  }

  cancelFriendRequest(params: { userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/user/cancel-friend-request`, params)
  }

  /** 清除好友请求未读标记（用户已查看好友请求面板，回写后角标消失）。 */
  markFriendReqRead() {
    return this.http.post<StandardResponse>(`${apiPrefix}/notify/mark-friend-req-read`, {})
  }

  getThreadInfo(params: { threadId: number }) {
    return this.http.post<StandardResponse<ConversationItem>>(`${apiPrefix}/user/thread-info`, params)
  }

}

/** 头像多档边长（与后端 UploadService.AVATAR_SIZES 对齐）。 */
const AVATAR_SIZES = [32, 64, 128, 256, 512] as const
export type AvatarSize = (typeof AVATAR_SIZES)[number]

/**
 * 多尺寸头像派生：把代表 URL（/uploads/<base>-512.webp）换成指定档；
 * base 为空或非本地多尺寸图（正则不匹配）时原样返回，便于回退默认头像。
 */
export function avatarUrl(base: string | undefined | null, size: AvatarSize): string {
  return base && AVATAR_SIZES.includes(size)
    ? base.replace(/-\d+\.webp$/, `-${size}.webp`)
    : (base ?? '')
}
