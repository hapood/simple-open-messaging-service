import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { StandardResponse } from './model';

export interface GrpCreateInfo {
  threadId: number;
  groupId: number;
}

export interface GroupJoinRequest {
  id: string;
  userId: number;
  account: string;
  domain: string;
  name: string;
  avatar: string;
  note: string;
  requestedAt: string;
  expiresAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class GroupService {
  constructor(private http: HttpClient) {}

  /** Create a group. Members are invited separately through inviteUsers. */
  createGroup(params: { name: string; avatar?: string; description?: string }) {
    return this.http.post<StandardResponse<GrpCreateInfo>>(
      `${apiPrefix()}/group/create`,
      params,
    );
  }

  /** Batch invite: each friend receives an INVITE in the inviter↔invitee P2P thread. The server
   *  returns { invited, skipped } — skipped entries are non-friends / no-P2P-thread / write failures. */
  inviteUsers(params: { userIds: number[]; groupId: number }) {
    return this.http.post<
      StandardResponse<{
        invited: number[];
        skipped: { userId: number; reason: string }[];
      }>
    >(`${apiPrefix()}/group/invite`, params);
  }

  leaveGroup(params: { groupId: number; deleteData?: boolean }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/leave`,
      params,
    );
  }

  dissolveGroup(params: { groupId: number; deleteData?: boolean }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/dissolve`,
      params,
    );
  }

  kickMember(params: { groupId: number; userId: number }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/kick`,
      params,
    );
  }

  transferOwnership(params: { groupId: number; toUserId: number }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/transfer`,
      params,
    );
  }

  /** role is ADMIN or MEMBER; ownership changes use transferOwnership. */
  setRole(params: {
    groupId: number;
    userId: number;
    role: 'ADMIN' | 'MEMBER';
  }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/set-role`,
      params,
    );
  }

  updateGroup(params: {
    groupId: number;
    name?: string;
    description?: string;
    avatar?: string;
  }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/update`,
      params,
    );
  }

  queryJoinRequests(params: {
    groupId: number;
    before?: string;
    take?: number;
  }) {
    return this.http.post<
      StandardResponse<{
        data: GroupJoinRequest[];
        hasMore: boolean;
        before: string | null;
      }>
    >(`${apiPrefix()}/group/join-requests`, params);
  }

  markJoinRequestsRead(params: { groupId: number; readRequestId: string }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/join-requests/read`,
      params,
    );
  }

  acceptJoinRequest(params: { groupId: number; requestId: string }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/join-request/accept`,
      params,
    );
  }

  rejectJoinRequest(params: { groupId: number; requestId: string }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/join-request/reject`,
      params,
    );
  }
}
