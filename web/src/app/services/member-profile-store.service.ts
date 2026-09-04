import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { WebdbService } from './webdb.service';
import { messageCreatorKey, parseUserIdentityKey } from './model';
import { ProfileResolutionService } from './profile-resolution.service';

export interface ResolvedMemberProfile {
  identityKey: string;
  account: string;
  domain: string;
  namespaceId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  isOwner: boolean;
  name: string;
  avatar: string;
  bio: string;
  profileRev: number;
  profileMessageSeq: number | null;
  profileResolved: boolean;
}

/** Paginated local-database reader for the materialized group roster. */
@Injectable({ providedIn: 'root' })
export class MemberProfileRepository {
  private readonly webdb = inject(WebdbService);
  private readonly profileResolutions = inject(ProfileResolutionService);
  private readonly resolutionsInFlight = new Set<string>();
  readonly changed$ = new Subject<readonly number[]>();

  notifyChanged(threadIds: readonly number[]): void {
    this.changed$.next(threadIds);
  }

  async queryPage(
    threadId: number,
    params: { afterIdentity?: string; take: number; search?: string },
  ): Promise<ResolvedMemberProfile[]> {
    const members = await this.webdb.queryGroupMembers({ threadId, ...params });
    const resolved = members.map((member) => ({
      identityKey: messageCreatorKey({
        account: member.account,
        domain: member.domain,
        namespaceId: member.namespaceId,
      }),
      account: member.account,
      domain: member.domain,
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
      bio:
        member.resolvedProfileRev === member.profileRev
          ? member.profileBio
          : '',
      profileRev: member.profileRev,
      profileMessageSeq: member.profileMessageSeq ?? null,
      profileResolved:
        member.profileRev === member.resolvedProfileRev,
    }));
    for (const member of resolved) this.resolveGroupMetaProfile(threadId, member);
    return resolved;
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
      identity.namespaceId,
    );
    if (!member) return undefined;
    const resolved: ResolvedMemberProfile = {
      identityKey,
      account: member.account,
      domain: member.domain,
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
      bio:
        member.resolvedProfileRev === member.profileRev
          ? member.profileBio
          : '',
      profileRev: member.profileRev,
      profileMessageSeq: member.profileMessageSeq ?? null,
      profileResolved:
        member.profileRev === member.resolvedProfileRev,
    };
    this.resolveGroupMetaProfile(threadId, resolved);
    return resolved;
  }

  async recordMessageProfile(
    threadId: number,
    identity: {
      account: string;
      domain: string;
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
      namespaceId: number;
    },
    profile: { rev: number; name: string; avatar: string; bio: string },
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

  private resolveGroupMetaProfile(
    threadId: number,
    member: ResolvedMemberProfile,
  ): void {
    if (member.profileResolved || member.profileMessageSeq !== null) return;
    const key = JSON.stringify([
      threadId,
      member.account,
      member.domain,
      member.profileRev,
    ]);
    if (this.resolutionsInFlight.has(key)) return;
    this.resolutionsInFlight.add(key);
    this.profileResolutions
      .resolve({
        threadId,
        memberAccount: member.account,
        memberDomain: member.domain,
      })
      .subscribe({
        next: (profile) => {
          void this.storeResolvedProfile(
            threadId,
            {
              account: member.account,
              domain: member.domain,
              namespaceId: member.namespaceId,
            },
            {
              rev: profile.rev,
              name: profile.name,
              avatar: profile.avatarBase64
                ? `data:image/webp;base64,${profile.avatarBase64}`
                : '',
              bio: profile.bio,
            },
          );
        },
        error: () => this.resolutionsInFlight.delete(key),
        complete: () => this.resolutionsInFlight.delete(key),
      });
  }
}
