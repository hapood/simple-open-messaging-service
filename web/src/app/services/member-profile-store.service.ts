import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, Subject } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbService, type ProfileSnapshot } from './webdb.service';
import { messageCreatorKey, type StandardResponse } from './model';
import { apiPrefix } from './constants';
import type { ProfiledAddress } from '../../../../shared/profiled-address';

interface GroupMemberPage {
  items: Array<ProfiledAddress & { role: 'OWNER' | 'ADMIN' | 'MEMBER' }>;
  nextCursor: string | null;
}

interface MemberQuery {
  cursor?: string | null;
  take: number;
  search?: string;
  exclude?: { account: string; namespaceId: number };
}

export interface ResolvedMemberPage {
  items: ResolvedMemberProfile[];
  nextCursor: string | null;
}

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

interface ResolvedMemberRecord {
  account: string;
  namespaceId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  profileRev: number;
  resolvedProfileRev?: number;
  profileName?: string;
  profileBio: string;
  user: ProfileSnapshot;
}

/** Project a server roster row into a presentation profile. The name
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

/** Server-owned roster queries with exact-revision local profile presentation. */
@Injectable({ providedIn: 'root' })
export class MemberProfileRepository {
  private readonly http = inject(HttpClient);
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
    params: MemberQuery,
  ): Promise<ResolvedMemberProfile[]> {
    return (await this.queryRosterPage(threadId, params)).items;
  }

  async queryRosterPage(
    threadId: number,
    params: MemberQuery,
  ): Promise<ResolvedMemberPage> {
    this.queriedThreads.add(threadId);
    const response = await firstValueFrom(
      this.http.post<StandardResponse<GroupMemberPage>>(
        `${apiPrefix()}/group/members`,
        {
          threadId,
          ...(params.search ? { search: params.search } : {}),
          ...(params.exclude ? { excludeSelf: true } : {}),
          take: params.take,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
      ),
    );
    if (response.code !== 0 || !response.data)
      throw new Error(response.message || 'Group members query failed');
    const page = response.data;
    const items = await Promise.all(
      page.items.map(async (item) => {
        const profile = await this.webdb.getProfile({
          publisherNamespaceId: item.publisherNamespaceId,
          lookup: 'ACCOUNT_PROFILE',
          target: {
            profileNamespaceId: item.profileNamespaceId,
            account: item.account,
            rev: item.profileRev,
          },
        });
        return resolvedMemberProfile({
          account: item.account,
          namespaceId: item.profileNamespaceId,
          role: item.role,
          profileRev: item.profileRev,
          resolvedProfileRev: profile?.profileRev,
          profileName: profile?.name,
          profileBio: profile?.bio ?? '',
          user: {
            publisherNamespaceId: item.publisherNamespaceId,
            profileNamespaceId: item.profileNamespaceId,
            profileRev: item.profileRev,
            account: item.account,
            name: item.account,
            bio: '',
            avatarDigest: null,
          },
        });
      }),
    );
    return { items, nextCursor: page.nextCursor };
  }
}
