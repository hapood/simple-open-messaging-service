import { Injectable, inject } from '@angular/core';
import { defer, from, of, map } from 'rxjs';
import { MemberProfileRepository } from '../app/services/member-profile-store.service';
import {
  ProfileRepository,
  type ResolvedProfile,
} from '../app/services/profile-store.service';
import { PlaygroundSocialState } from './playground-social-state';
import { decodeProfileAvatar } from '../app/services/profile-avatar-bytes';

@Injectable({ providedIn: 'root' })
export class PlaygroundMemberProfiles
  implements Pick<MemberProfileRepository, keyof MemberProfileRepository>
{
  private readonly state = inject(PlaygroundSocialState);
  readonly changed$ = this.state.membersChanged$;
  notifyChanged(threadIds: readonly number[]): void {
    this.changed$.next(threadIds);
  }

  async queryPage(
    threadId: number,
    params: { afterIdentity?: string; take: number; search?: string },
  ) {
    const search = params.search?.trim().toLowerCase() ?? '';
    const members = (this.state.rosters.get(threadId) ?? [])
      .filter(
        (member) =>
          !search ||
          `${member.account} ${member.name}`.toLowerCase().includes(search),
      )
      .sort((a, b) =>
        a.identityKey < b.identityKey
          ? -1
          : a.identityKey > b.identityKey
            ? 1
            : 0,
      );
    return members
      .filter(
        (member) =>
          !params.afterIdentity || member.identityKey > params.afterIdentity,
      )
      .slice(0, params.take)
      .map((member) => ({ ...member }));
  }
}

@Injectable({ providedIn: 'root' })
export class PlaygroundProfiles
  implements Pick<ProfileRepository, keyof ProfileRepository>
{
  private readonly state = inject(PlaygroundSocialState);

  resolve(input: Parameters<ProfileRepository['resolve']>[0]) {
    return defer(() => {
      const demand = 'demand' in input ? input.demand : input;
      const user = this.state.user(
        demand.target.account,
        demand.publisherNamespaceId || demand.target.profileNamespaceId,
      );
      const profile: ResolvedProfile = {
        publisherNamespaceId: demand.publisherNamespaceId,
        namespaceId: demand.target.profileNamespaceId,
        account: demand.target.account,
        rev: demand.target.rev,
        name: user?.name ?? demand.target.account,
        bio: user?.bio ?? '',
        avatarDigest: null,
        avatarBlob: null,
      };
      const avatar = user?.avatar.match(/^data:[^;]+;base64,(.+)$/)?.[1];
      return avatar
        ? from(decodeProfileAvatar(avatar)).pipe(
            map((decoded) => ({
              ...profile,
              avatarDigest: decoded?.digest ?? null,
              avatarBlob: decoded?.blob ?? null,
            })),
          )
        : of(profile);
    });
  }
  prefetch(
    demand: Parameters<ProfileRepository['resolve']>[0],
    onReady?: (profile: ResolvedProfile) => void,
  ): void {
    this.resolve(demand).subscribe({ next: onReady });
  }
}
