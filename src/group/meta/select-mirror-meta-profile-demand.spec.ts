import { describe, expect, it } from 'vitest';
import { GroupRole } from '../../database/enums.js';
import {
  normalizeMirrorMetaReplicatedItem,
  type MirrorMetaReplicatedItem,
} from './mirror-meta-shared.js';
import { selectMirrorMetaProfileDemand } from './select-mirror-meta-profile-demand.js';

process.env.SOMS_DOMAIN ??= 'mirror.example';

const group = {
  account: '!mirror-group',
  publisherNamespaceId: 17,
};

const member: MirrorMetaReplicatedItem = {
  feedId: 42,
  operation: 'MEMBER_UPSERT',
  account: 'remote-member',
  domain: 'member.example',
  role: GroupRole.MEMBER,
  profileNamespaceId: 23,
  profileRev: 9,
};

describe('selectMirrorMetaProfileDemand', () => {
  it('uses the mirror group namespace for a non-local member snapshot', () => {
    expect(selectMirrorMetaProfileDemand(group, member)).toEqual({
      publisherNamespaceId: 17,
      lookup: 'GROUP_MEMBER_PROFILE',
      target: {
        account: 'remote-member',
        profileNamespaceId: 23,
        rev: 9,
      },
      groupAccount: '!mirror-group',
    });
  });

  it.each([
    { operation: 'MEMBER_DEPART' as const, profileRev: 3 },
    { operation: 'MEMBER_UPSERT' as const, profileRev: 0 },
    { operation: 'GROUP_PROFILE' as const, profileRev: 3 },
  ])('does not create work for $operation', ({ operation, profileRev }) => {
    const item =
      operation === 'MEMBER_DEPART'
        ? {
            feedId: 43,
            operation,
            account: member.account,
            domain: member.domain,
            role: member.role,
            profileNamespaceId: member.profileNamespaceId,
            profileRev: profileRev!,
          }
        : operation === 'GROUP_PROFILE'
          ? {
              feedId: 43,
              operation,
              profileNamespaceId: 0,
              profileRev: profileRev!,
            }
          : {
              ...member,
              feedId: 43,
              operation,
              profileRev: profileRev!,
            };
    expect(selectMirrorMetaProfileDemand(group, item)).toBeNull();
  });

  it('preserves a foreign domain and namespace coordinate', () => {
    const canonical = normalizeMirrorMetaReplicatedItem(group, {
      ...member,
      domain: 'mirror.example',
      profileNamespaceId: 23,
      profileRev: 4,
    });

    expect(canonical).toMatchObject({
      domain: 'mirror.example',
      profileNamespaceId: 23,
    });
    expect(selectMirrorMetaProfileDemand(group, canonical)).not.toBeNull();
  });

  it('accepts the local marker only with namespace zero', () => {
    const canonical = normalizeMirrorMetaReplicatedItem(group, {
      ...member,
      domain: 'local',
      profileNamespaceId: 0,
    });

    expect(canonical).toMatchObject({
      domain: 'local',
      profileNamespaceId: 0,
    });
  });

  it('normalizes local departures to profile namespace zero', () => {
    const depart = normalizeMirrorMetaReplicatedItem(group, {
      feedId: 44,
      operation: 'MEMBER_DEPART',
      account: 'local-member',
      domain: 'local',
      role: GroupRole.MEMBER,
      profileNamespaceId: 0,
      profileRev: 0,
    });

    expect(depart).toMatchObject({
      domain: 'local',
      profileNamespaceId: 0,
    });
  });
});
