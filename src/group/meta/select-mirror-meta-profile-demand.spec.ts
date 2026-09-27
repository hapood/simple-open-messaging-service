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
  namespaceId: 17,
};

const member: MirrorMetaReplicatedItem = {
  feedId: 42,
  operation: 'MEMBER_UPSERT',
  account: 'remote-member',
  domain: 'member.example',
  role: GroupRole.MEMBER,
  profileRev: 9,
};

describe('selectMirrorMetaProfileDemand', () => {
  it('uses the mirror group namespace for a non-local member snapshot', () => {
    expect(selectMirrorMetaProfileDemand(group, member)).toEqual({
      namespaceId: 17,
      lookup: 'GROUP_MEMBER_PROFILE',
      target: {
        account: 'remote-member',
        domain: 'member.example',
        rev: 9,
      },
      groupAccount: '!mirror-group',
    });
  });

  it.each([
    { operation: 'MEMBER_DEPART' as const, profileRev: undefined },
    { operation: 'MEMBER_UPSERT' as const, profileRev: 0 },
    { operation: 'GROUP_PROFILE' as const, profileRev: 3 },
    { operation: 'MEMBER_UPSERT' as const, profileRev: 4, domain: 'local' },
  ])(
    'does not create work for $operation',
    ({ operation, profileRev, domain }) => {
      const item =
        operation === 'MEMBER_DEPART'
          ? {
              feedId: 43,
              operation,
              account: member.account,
              domain: member.domain,
            }
          : operation === 'GROUP_PROFILE'
            ? { feedId: 43, operation, profileRev: profileRev! }
            : {
                ...member,
                feedId: 43,
                operation,
                profileRev: profileRev!,
                ...(domain ? { domain } : {}),
              };
      expect(selectMirrorMetaProfileDemand(group, item)).toBeNull();
    },
  );

  it('depends on canonical boundary conversion for local wire domains', () => {
    const canonical = normalizeMirrorMetaReplicatedItem(group, {
      ...member,
      domain: 'mirror.example',
      profileRev: 4,
    });

    expect(canonical).toMatchObject({ domain: 'local' });
    expect(selectMirrorMetaProfileDemand(group, canonical)).toBeNull();
  });
});
