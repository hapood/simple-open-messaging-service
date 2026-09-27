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
 * item. The mirror group's namespace is the demand namespace: the member's
 * address is the target, but the mirror is the server asking for the
 * group-member profile. Meta consumption never creates projection work.
 */
export function selectMirrorMetaProfileDemand(
  group: Pick<MirrorGroupAddress, 'account' | 'namespaceId'>,
  item: MirrorMetaReplicatedItem,
): ProfilePrefetchDemand | null {
  // The item has already passed the mirror wire-boundary normalization. A
  // canonical local member uses the local snapshot path and must not enter
  // the federation resolver.
  if (
    item.operation !== 'MEMBER_UPSERT' ||
    item.profileRev < 1 ||
    item.domain === 'local'
  )
    return null;

  return {
    namespaceId: group.namespaceId,
    lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
    target: {
      account: item.account,
      domain: item.domain,
      rev: item.profileRev,
    },
    groupAccount: group.account,
  };
}
