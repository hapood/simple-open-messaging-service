import {
  ProfileLookup,
  type ProfilePrefetchDemand,
} from '../../profile-resolution/profile-resolution-demand.js';
import type {
  MirrorGroupAddress,
  MirrorMetaReplicatedItem,
} from './mirror-meta-shared.js';

/**
 * Select the snapshot-only profile work caused by one committed mirrored Meta
 * item. The mirror group's namespace is the publisher namespace: the member's
 * address is the target, but the mirror is the server asking for the
 * group-member profile. Meta consumption never creates projection work.
 */
export function selectMirrorMetaProfileDemand(
  group: Pick<MirrorGroupAddress, 'account' | 'publisherNamespaceId'>,
  item: MirrorMetaReplicatedItem,
): ProfilePrefetchDemand | null {
  // A subject in the publisher's own namespace (namespaceId 0) is served by
  // the origin-side member-profile publication path, not the federation
  // resolver; the mirror skips it here.
  if (
    item.operation !== 'MEMBER_UPSERT' ||
    item.profileRev < 1 ||
    item.namespaceId === 0
  )
    return null;

  return {
    publisherNamespaceId: group.publisherNamespaceId,
    lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
    target: {
      profileNamespaceId: item.namespaceId,
      account: item.account,
      rev: item.profileRev,
    },
    groupAccount: group.account,
  };
}
