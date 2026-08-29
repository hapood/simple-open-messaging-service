import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { WebdbService } from './webdb.service';
import { messageCreatorKey, parseUserIdentityKey } from './model';

export interface ResolvedMemberProfile {
  identityKey: string;
  account: string;
  domain: string;
  profileSourceDomain: string;
  namespaceId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  isOwner: boolean;
  name: string;
  avatar: string;
}

/** Paginated local-database reader for the materialized group roster. */
@Injectable({ providedIn: 'root' })
export class MemberProfileRepository {
  private readonly webdb = inject(WebdbService);
  readonly changed$ = new Subject<readonly number[]>();

  notifyChanged(threadIds: readonly number[]): void {
    this.changed$.next(threadIds);
  }

  async queryPage(
    threadId: number,
    params: { afterIdentity?: string; take: number; search?: string },
  ): Promise<ResolvedMemberProfile[]> {
    const members = await this.webdb.queryGroupMembers({ threadId, ...params });
    return members.map((member) => ({
      identityKey: messageCreatorKey(
        {
          account: member.account,
          domain: member.domain,
          namespaceId: member.namespaceId,
        },
        member.sourceDomain,
      ),
      account: member.account,
      domain: member.domain,
      profileSourceDomain: member.sourceDomain,
      namespaceId: member.namespaceId,
      role: member.role,
      isOwner: member.role === 'OWNER',
      name: member.user.name,
      avatar: member.user.avatar,
    }));
  }

  async getByIdentity(
    threadId: number,
    identityKey: string,
  ): Promise<ResolvedMemberProfile | undefined> {
    const identity = parseUserIdentityKey(identityKey);
    if (!identity) return undefined;
    const member = await this.webdb.getGroupMember(
      threadId,
      identity.account,
      identity.domain,
      identity.sourceDomain,
      identity.namespaceId,
    );
    if (!member) return undefined;
    return {
      identityKey,
      account: member.account,
      domain: member.domain,
      profileSourceDomain: member.sourceDomain,
      namespaceId: member.namespaceId,
      role: member.role,
      isOwner: member.role === 'OWNER',
      name: member.user.name,
      avatar: member.user.avatar,
    };
  }
}
