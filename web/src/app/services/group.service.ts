import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { StandardResponse } from './model';

export interface GrpCreateInfo {
  threadId: number,
  groupId: number,
  /** Friend user ids who were successfully sent a GROUP_INVITE at creation. */
  invited: number[],
  /** Friends who could not be invited (not a friend / no P2P thread / write failure). */
  skipped: { userId: number, reason: string }[],
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

  /** Create a group; inviteUserIds sends each friend a GROUP_INVITE they must accept via group/join
   *  (no direct add). The response carries { invited, skipped } so the caller can toast the result. */
  createGroup(params: { name: string, avatar?: string, description?: string, inviteUserIds?: number[] }) {
    return this.http.post<StandardResponse<GrpCreateInfo>>(`${apiPrefix}/group/create`, params)
  }

  /** Batch invite: each friend receives an INVITE in the inviter↔invitee P2P thread. The server
   *  returns { invited, skipped } — skipped entries are non-friends / no-P2P-thread / write failures. */
  inviteUsers(params: { userIds: number[], groupId: number }) {
    return this.http.post<StandardResponse<{ invited: number[]; skipped: { userId: number; reason: string }[] }>>(
      `${apiPrefix}/group/invite`,
      params,
    )
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

  updateGroup(params: { groupId: number, name?: string, description?: string, avatar?: string }) {
    return this.http.post<StandardResponse>(`${apiPrefix}/group/update`, params)
  }
}
