import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { StandardResponse } from './model';

export interface GrpCreateInfo {
  threadId: number,
  groupId: number
}

/** One row of a group roster (group/members). Mirrors the backend GroupMemberDto. */
export interface GroupMember {
  userId: number
  uniqName: string
  name: string
  avatar: string
  /** OWNER | ADMIN | MEMBER */
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
  /** joined at, ms timestamp */
  joinedAt: number
  isOwner: boolean
}

@Injectable({
  providedIn: 'root'
})
export class GroupService {

  constructor(private http: HttpClient) {
  }

  /** Create a group; memberIds adds those friends as members directly (no invite-token round-trip). */
  createGroup(params: { name: string, avatar?: string, memberIds?: number[] }) {
    return this.http.post<StandardResponse<GrpCreateInfo>>(`${apiPrefix}/group/create`, params)
  }

  inviteUser(params: { userId: number, groupId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/group/invite`, params)
  }

  joinGroup(params: { token: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/group/join`, params)
  }

  getMembers(params: { groupId: number }) {
    return this.http.post<StandardResponse<GroupMember[]>>(`${apiPrefix}/group/members`, params)
  }

  leaveGroup(params: { groupId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/group/leave`, params)
  }

  kickMember(params: { groupId: number, userId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/group/kick`, params)
  }

  transferOwnership(params: { groupId: number, toUserId: number }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/group/transfer`, params)
  }

  /** role is ADMIN or MEMBER; ownership changes use transferOwnership. */
  setRole(params: { groupId: number, userId: number, role: 'ADMIN' | 'MEMBER' }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/group/set-role`, params)
  }

  updateGroup(params: { groupId: number, name?: string, avatar?: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/group/update`, params)
  }
}
