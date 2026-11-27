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
    params: Parameters<MemberProfileRepository['queryPage']>[1],
  ) {
    return (await this.queryRosterPage(threadId, params)).items;
  }

  async queryRosterPage(
    threadId: number,
    params: Parameters<MemberProfileRepository['queryRosterPage']>[1],
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
    const eligible = members.filter(
      (member) =>
        (!params.cursor || member.identityKey > params.cursor) &&
        (!params.exclude ||
          member.account !== params.exclude.account ||
          member.namespaceId !== params.exclude.namespaceId),
    );
    const items = eligible
      .slice(0, params.take)
      .map((member) => ({ ...member }));
    return {
      items,
      nextCursor:
        eligible.length > items.length && items.length > 0
          ? items[items.length - 1].identityKey
          : null,
    };
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
      const user = this.state.profileOfDemand(demand);
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

  watch(demand: Parameters<ProfileRepository['resolve']>[0]) {
    return this.resolve(demand);
  }
}
