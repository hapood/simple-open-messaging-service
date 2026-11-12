import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbService, type ResolvedMemberRecord } from './webdb.service';
import { messageCreatorKey } from './model';

export interface ResolvedMemberProfile {
  identityKey: string;
  account: string;
  /** Local publisher ID; namespaceId is scoped to this publisher. */
  publisherNamespaceId: number;
  namespaceId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  isOwner: boolean;
  name: string;
  bio: string;
  profileRev: number;
  profileResolved: boolean;
}

/** Project a materialized roster row into a presentation profile. The name
 * and bio resolve only when the cached profile matches the member's selected
 * revision; otherwise the account handle keeps the row identifiable. */
export function resolvedMemberProfile(
  member: ResolvedMemberRecord,
): ResolvedMemberProfile {
  const profileResolved = member.profileRev === member.resolvedProfileRev;
  return {
    identityKey: messageCreatorKey({
      account: member.account,
      namespaceId: member.namespaceId,
    }),
    account: member.account,
    publisherNamespaceId: member.user.publisherNamespaceId,
    namespaceId: member.namespaceId,
    role: member.role,
    isOwner: member.role === 'OWNER',
    name: profileResolved
      ? (member.profileName ?? member.user.name)
      : member.account,
    bio: profileResolved ? member.profileBio : '',
    profileRev: member.profileRev,
    profileResolved,
  };
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
    params: {
      afterIdentity?: string;
      take: number;
      search?: string;
      exclude?: { account: string; namespaceId: number };
    },
  ): Promise<ResolvedMemberProfile[]> {
    this.queriedThreads.add(threadId);
    const members = await this.webdb.queryGroupMembers({ threadId, ...params });
    return members.map(resolvedMemberProfile);
  }
}
