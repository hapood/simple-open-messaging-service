import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbService } from './webdb.service';
import { messageCreatorKey, parseUserIdentityKey } from './model';

export interface ResolvedMemberProfile {
  identityKey: string;
  account: string;
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
      if (wake.event !== 'PROFILE_AVAILABLE') return;
      if (this.queriedThreads.size === 0) return;
      this.notifyChanged([...this.queriedThreads]);
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
        namespaceId: member.namespaceId,
      }),
      account: member.account,
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
    const member = (await this.webdb.queryGroupMembers({ threadId, take: 1000 })).find(
      (candidate) =>
        candidate.account === identity.account &&
        candidate.namespaceId === identity.namespaceId,
    );
    if (!member) return undefined;
    const resolved: ResolvedMemberProfile = {
      identityKey,
      account: member.account,
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
      namespaceId: number;
    },
    profileRev: number,
    messageSeq: number,
  ): Promise<void> {
    const member = (await this.webdb.queryGroupMembers({ threadId, take: 1000 })).find(
      (candidate) =>
        candidate.account === identity.account &&
        candidate.namespaceId === identity.namespaceId,
    );
    if (!member) return;
    if (
      await this.webdb.recordGroupMemberMessageProfile(
        threadId,
        member,
        profileRev,
        messageSeq,
      )
    )
      this.notifyChanged([threadId]);
  }
}
