import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { StandardResponse } from './model';

export interface GrpCreateInfo {
  threadId: number;
  groupId: number;
}

export interface GroupJoinRequest {
  feedId: number;
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  namespaceId: number;
  profileRev: number;
  account: string;
  domain: string;
  name: string;
  avatar: string;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
}

export interface GroupInviteCandidate {
  threadId?: number;
  namespaceId: number;
  profileRev: number;
  account: string;
  domain: string;
  name: string;
  avatar: string;
  bio: string;
  state: 'AVAILABLE' | 'INVITED' | 'MEMBER';
}

type MembershipIntentResult =
  | { status: 'APPLIED' }
  | {
      status: 'NO_OP';
      reason: 'ALREADY_MEMBER' | 'ALREADY_REVOKED' | 'ALREADY_SATISFIED';
    };

type GroupRosterRoleResult =
  | { status: 'APPLIED' }
  | { status: 'NO_OP'; reason: 'ROLE_UNCHANGED' }
  | { status: 'REJECTED'; reason: string };

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

  /** Invite each target through the manager-authored membership transaction. */
  inviteUsers(params: {
    users: { account: string; domain: string }[];
    groupId: number;
  }) {
    return this.http.post<
      StandardResponse<{
        invited: { account: string; domain: string }[];
        skipped: Array<{
          account: string;
          domain: string;
          reason: string;
          code: string;
          message: string;
        }>;
      }>
    >(`${apiPrefix()}/group/invite`, params);
  }

  queryInviteCandidates(params: {
    groupId: number;
    afterThreadId?: number;
    search?: string;
    take?: number;
  }) {
    return this.http.post<
      StandardResponse<{
        data: GroupInviteCandidate[];
        hasMore: boolean;
        afterThreadId: number | null;
      }>
    >(`${apiPrefix()}/group/invite-candidates`, params);
  }

  leaveGroup(params: { groupId: number }) {
    return this.http.post<StandardResponse<MembershipIntentResult>>(
      `${apiPrefix()}/group/leave`,
      params,
    );
  }

  dissolveGroup(params: { groupId: number }) {
    return this.http.post<
      StandardResponse<{ taskId: string; status: 'PENDING' }>
    >(`${apiPrefix()}/group/dissolve`, params);
  }

  kickMember(params: { groupId: number; account: string; domain: string }) {
    return this.http.post<StandardResponse<MembershipIntentResult>>(
      `${apiPrefix()}/group/kick`,
      params,
    );
  }

  transferOwnership(params: {
    groupId: number;
    account: string;
    domain: string;
  }) {
    return this.http.post<StandardResponse<GroupRosterRoleResult>>(
      `${apiPrefix()}/group/transfer`,
      params,
    );
  }

  /** role is ADMIN or MEMBER; ownership changes use transferOwnership. */
  setRole(params: {
    groupId: number;
    account: string;
    domain: string;
    role: 'ADMIN' | 'MEMBER';
  }) {
    return this.http.post<StandardResponse<GroupRosterRoleResult>>(
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
    before?: number;
    take?: number;
  }) {
    return this.http.post<
      StandardResponse<{
        data: GroupJoinRequest[];
        hasMore: boolean;
        before: number | null;
      }>
    >(`${apiPrefix()}/group/join-requests`, params);
  }

  queryInvitations(params: {
    groupId: number;
    before?: number;
    take?: number;
  }) {
    return this.http.post<
      StandardResponse<{
        data: GroupJoinRequest[];
        hasMore: boolean;
        before: number | null;
      }>
    >(`${apiPrefix()}/group/invitations`, params);
  }

  markJoinRequestsRead(params: { groupId: number; readFeedId: number }) {
    return this.http.post<StandardResponse>(
      `${apiPrefix()}/group/join-requests/read`,
      params,
    );
  }

  acceptJoinRequest(params: { groupId: number; account: string; domain: string }) {
    return this.http.post<StandardResponse<MembershipIntentResult>>(
      `${apiPrefix()}/group/join-request/accept`,
      params,
    );
  }

  rejectJoinRequest(params: { groupId: number; account: string; domain: string }) {
    return this.http.post<StandardResponse<MembershipIntentResult>>(
      `${apiPrefix()}/group/join-request/reject`,
      params,
    );
  }

  revokeInvitation(params: { groupId: number; account: string; domain: string }) {
    return this.http.post<StandardResponse<MembershipIntentResult>>(
      `${apiPrefix()}/group/invitation/revoke`,
      params,
    );
  }
}
