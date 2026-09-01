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
  profileRev: number;
  profileMessageSeq: number | null;
  profileResolved: boolean;
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
      name:
        member.resolvedProfileRev === member.profileRev
          ? (member.profileName ?? member.user.name)
          : member.account,
      avatar:
        member.resolvedProfileRev === member.profileRev
          ? (member.profileAvatar ?? member.user.avatar)
          : '',
      profileRev: member.profileRev ?? member.user.profileRev,
      profileMessageSeq: member.profileMessageSeq ?? null,
      profileResolved:
        (member.profileRev ?? member.user.profileRev) ===
        (member.resolvedProfileRev ?? member.user.profileRev),
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
      name:
        member.resolvedProfileRev === member.profileRev
          ? (member.profileName ?? member.user.name)
          : member.account,
      avatar:
        member.resolvedProfileRev === member.profileRev
          ? (member.profileAvatar ?? member.user.avatar)
          : '',
      profileRev: member.profileRev ?? member.user.profileRev,
      profileMessageSeq: member.profileMessageSeq ?? null,
      profileResolved:
        (member.profileRev ?? member.user.profileRev) ===
        (member.resolvedProfileRev ?? member.user.profileRev),
    };
  }

  async recordMessageProfile(
    threadId: number,
    identity: {
      account: string;
      domain: string;
      sourceDomain: string;
      namespaceId: number;
    },
    profileRev: number,
    messageSeq: number,
  ): Promise<void> {
    if (
      await this.webdb.recordGroupMemberMessageProfile(
        threadId,
        identity,
        profileRev,
        messageSeq,
      )
    )
      this.notifyChanged([threadId]);
  }

  async storeResolvedProfile(
    threadId: number,
    identity: {
      account: string;
      domain: string;
      sourceDomain: string;
      namespaceId: number;
    },
    profile: { rev: number; name: string; avatar: string },
  ): Promise<void> {
    if (
      await this.webdb.storeGroupMemberResolvedProfile(
        threadId,
        identity,
        profile,
      )
    )
      this.notifyChanged([threadId]);
  }
}
