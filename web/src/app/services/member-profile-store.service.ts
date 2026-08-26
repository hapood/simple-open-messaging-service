import { inject, Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { WebdbService } from './webdb.service';
import type { GroupMemberRef } from './model';

export interface ResolvedMemberProfile extends GroupMemberRef {
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
    params: { afterUserId?: number; take: number; search?: string },
  ): Promise<ResolvedMemberProfile[]> {
    const members = await this.webdb.queryGroupMembers({ threadId, ...params });
    return members.map((member) => ({
      userId: member.userId,
      account: member.memberAccount,
      domain: member.memberDomain,
      profileSourceDomain: member.profileSourceServer,
      role: member.role,
      joinedAt: 0,
      isOwner: member.role === 'OWNER',
      name: member.displayName,
      avatar: member.avatar,
    }));
  }

  async get(
    threadId: number,
    userId: number,
  ): Promise<ResolvedMemberProfile | undefined> {
    const [member] = await this.queryPage(threadId, {
      afterUserId: userId - 1,
      take: 1,
    });
    return member?.userId === userId ? member : undefined;
  }
}
