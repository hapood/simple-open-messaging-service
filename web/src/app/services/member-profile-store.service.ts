import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { WebdbService } from './webdb.service';
import type { GroupMemberRef } from './model';

export interface ResolvedMemberProfile extends GroupMemberRef {
  name: string;
  avatar: string;
}

/** Local-first reader for group membership facts plus their display-profile projection. */
@Injectable({ providedIn: 'root' })
export class MemberProfileRepository {
  private readonly webdb = inject(WebdbService);
  readonly changed$ = new Subject<readonly number[]>();

  notifyChanged(threadIds: readonly number[]): void {
    this.changed$.next(threadIds);
  }

  async resolve(
    threadId: number,
    member: GroupMemberRef,
  ): Promise<ResolvedMemberProfile> {
    const scoped = member.profileSourceDomain
      ? await this.webdb.getMemberProfile(threadId, member.userId)
      : undefined;
    const home = scoped
      ? undefined
      : await this.webdb.getProfile(`u${member.userId}`);
    return {
      ...member,
      name: scoped?.displayName ?? home?.name ?? member.account,
      avatar: scoped?.avatar ?? home?.avatar ?? '',
    };
  }

  async resolveAll(
    threadId: number,
    members: readonly GroupMemberRef[],
  ): Promise<ResolvedMemberProfile[]> {
    return Promise.all(members.map((member) => this.resolve(threadId, member)));
  }
}
