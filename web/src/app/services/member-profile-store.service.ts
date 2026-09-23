import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbService } from './webdb.service';
import { messageCreatorKey, parseUserIdentityKey } from './model';

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
  readonly changed$ = new Subject<readonly number[]>();
  private readonly queriedThreads = new Set<number>();

  constructor() {
    this.webdb.profileWake$.pipe(takeUntilDestroyed()).subscribe((wake) => {
      // A newly resolved name can enter an empty search result, but only the
      // roster named by the authorization evidence is affected.
      if (wake.event !== 'PROFILE_AVAILABLE' || !wake.evidence) return;
      const { evidence } = wake;
      if (
        (evidence.type === 'GROUP_META' ||
          evidence.type === 'MESSAGE_AUTHOR') &&
        this.queriedThreads.has(evidence.threadId)
      )
        this.notifyChanged([evidence.threadId]);
    });
    inject(SessionLifecycleService)
      .ended$.pipe(takeUntilDestroyed())
      .subscribe(() => {
        this.queriedThreads.clear();
      });
  }

  notifyChanged(threadIds: readonly number[]): void {
    this.changed$.next(threadIds);
  }

  async queryPage(
    threadId: number,
    params: { afterIdentity?: string; take: number; search?: string },
  ): Promise<ResolvedMemberProfile[]> {
    this.queriedThreads.add(threadId);
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
      avatar: '',
      bio:
        member.resolvedProfileRev === member.profileRev
          ? member.profileBio
          : '',
      profileRev: member.profileRev,
      profileMessageSeq: member.profileMessageSeq ?? null,
      profileResolved: member.profileRev === member.resolvedProfileRev,
    }));
    return resolved;
  }

  async getByIdentity(
    threadId: number,
    identityKey: string,
  ): Promise<ResolvedMemberProfile | undefined> {
    this.queriedThreads.add(threadId);
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
      avatar: '',
      bio:
        member.resolvedProfileRev === member.profileRev
          ? member.profileBio
          : '',
      profileRev: member.profileRev,
      profileMessageSeq: member.profileMessageSeq ?? null,
      profileResolved: member.profileRev === member.resolvedProfileRev,
    };
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
}
