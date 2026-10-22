import { describe, expect, it } from 'vitest';
import { GroupRole } from '../../database/enums.js';
import type { MirrorMetaReplicatedItem } from './mirror-meta-shared.js';
import { selectMirrorMetaProfileDemand } from './select-mirror-meta-profile-demand.js';

const group = {
  account: '!mirror-group',
  publisherNamespaceId: 17,
};

const member: MirrorMetaReplicatedItem = {
  feedId: 42,
  operation: 'MEMBER_UPSERT',
  account: 'remote-member',
  namespaceId: 23,
  role: GroupRole.MEMBER,
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
    const item: MirrorMetaReplicatedItem =
      operation === 'GROUP_PROFILE'
        ? {
            feedId: 43,
            operation,
            account: group.account,
            namespaceId: 0,
            profileRev,
          }
        : {
            ...member,
            feedId: 43,
            operation,
            profileRev,
          };
    expect(selectMirrorMetaProfileDemand(group, item)).toBeNull();
  });

  it('keeps the publisher namespace coordinate without a domain field', () => {
    expect(member).toMatchObject({ account: 'remote-member', namespaceId: 23 });
    expect('domain' in member).toBe(false);
    expect('profileNamespaceId' in member).toBe(false);
  });
});
