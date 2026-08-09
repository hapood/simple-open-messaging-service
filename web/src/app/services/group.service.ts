import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { StandardResponse } from './model';
import { map } from 'rxjs';

export interface GrpCreateInfo {
  threadId: number;
  groupId: number;
  /** Friend user ids who were successfully sent a GROUP_INVITE at creation. */
  invited: number[];
  /** Friends who could not be invited (not a friend / no P2P thread / write failure). */
  skipped: { userId: number; reason: string }[];
}

/** One row of a group roster (group/members). Mirrors the backend GroupMemberDto. */
export interface GroupMember {
  userId: number;
  account: string;
  name: string;
  avatar: string;
  /** Whether this member is an external (federated) user — drives the federated-badge in the roster. */
  isForeigner: boolean;
  /** Home domain; empty for a local member (the badge self-hides). */
  domain: string;
  /** OWNER | ADMIN | MEMBER */
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  /** joined at, ms timestamp */
  joinedAt: number;
  isOwner: boolean;
}

export interface GroupRoster {
  threadId: number;
  members: GroupMember[];
}

@Injectable({
  providedIn: 'root',
})
export class GroupService {
  constructor(private http: HttpClient) {}

  /** Create a group; inviteUserIds sends each friend a GROUP_INVITE they must accept via group/join
   *  (no direct add). The response carries { invited, skipped } so the caller can toast the result. */
  createGroup(params: {
    name: string;
    avatar?: string;
    description?: string;
    inviteUserIds?: number[];
  }) {
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

  /** Fetch the active roster for one conversation. The backend endpoint is batch-shaped; keep that
   *  transport detail here so composer/info consumers receive one flat member array. */
  getThreadMembers(threadId: number) {
    return this.http
      .post<StandardResponse<GroupRoster[]>>(`${apiPrefix()}/group/members`, {
        threadIds: [threadId],
      })
      .pipe(
        map((res) => ({
          ...res,
          data:
            res.data?.find((roster) => roster.threadId === threadId)?.members ??
            [],
        })),
      );
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
}
