import { describe, expect, it } from 'vitest';
import { isProfiledAddress, profileKeyForAddress } from './profiled-address.js';

describe('profiled system-event identity', () => {
  it('keeps participant namespace separate from the group namespace', () => {
    const participant = {
      account: 'alice',
      domain: 'peer.test',
      profileNamespaceId: 12,
      profileRev: 3,
    };
    expect(isProfiledAddress(participant)).toBe(true);
    expect(profileKeyForAddress(participant, 17)).toEqual({
      account: 'alice',
      publisherNamespaceId: 17,
      profileNamespaceId: 12,
      rev: 3,
    });
  });

  it('allows revision zero but only the reserved system account can use the system identity', () => {
    expect(
      isProfiledAddress({
        account: '$system',
        domain: 'system.example',
        profileNamespaceId: 0,
        profileRev: 0,
      }),
    ).toBe(true);
    expect(
      isProfiledAddress({
        account: '$system',
        domain: 'system.example',
        profileNamespaceId: 0,
        profileRev: 1,
      }),
    ).toBe(false);
    expect(
      isProfiledAddress({
        account: 'alice',
        domain: 'alice.example',
        profileNamespaceId: 0,
        profileRev: 0,
      }),
    ).toBe(true);
    expect(
      profileKeyForAddress(
        {
          account: '$system',
          domain: 'system.example',
          profileNamespaceId: 0,
          profileRev: 0,
        },
        0,
      ),
    ).toBeUndefined();
  });

  it('rejects an omitted namespace, invalid namespace/domain combinations and extra fields', () => {
    expect(
      isProfiledAddress({
        account: 'alice',
        profileRev: 2,
      }),
    ).toBe(false);
    expect(
      isProfiledAddress({
        account: 'alice',
        domain: 'peer.example',
      }),
    ).toBe(false);
    expect(
      isProfiledAddress({
        account: 'alice',
        profileNamespaceId: 7,
        profileRev: 2,
        name: 'Alice',
      }),
    ).toBe(false);
  });
});
