import { describe, expect, it } from 'vitest';
import { isProfiledAddress, profileKeyForAddress } from './profiled-address.js';

describe('profiled system-event identity', () => {
  it('keeps participant namespace separate from the group namespace', () => {
    const participant = {
      account: 'alice',
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
      isProfiledAddress({ account: '$system', profileNamespaceId: 0, profileRev: 0 }),
    ).toBe(true);
    expect(
      isProfiledAddress({ account: '$system', profileNamespaceId: 0, profileRev: 1 }),
    ).toBe(false);
    expect(
      isProfiledAddress({ account: 'alice', profileNamespaceId: 0, profileRev: 0 }),
    ).toBe(true);
    expect(
      profileKeyForAddress(
        { account: '$system', profileNamespaceId: 0, profileRev: 0 },
        0,
      ),
    ).toBeUndefined();
  });

  it('ignores keys outside the wire contract such as domain', () => {
    expect(
      isProfiledAddress({
        account: 'alice',
        domain: 'peer.example',
        profileNamespaceId: 7,
        profileRev: 2,
      }),
    ).toBe(true);
  });

  it('rejects missing fields, blank accounts and negative integers', () => {
    expect(isProfiledAddress({ account: 'alice', profileRev: 2 })).toBe(false);
    expect(
      isProfiledAddress({ account: 'alice', profileNamespaceId: 7 }),
    ).toBe(false);
    expect(
      isProfiledAddress({ account: '   ', profileNamespaceId: 0, profileRev: 0 }),
    ).toBe(false);
    expect(
      isProfiledAddress({ account: 'alice', profileNamespaceId: -1, profileRev: 2 }),
    ).toBe(false);
    expect(
      isProfiledAddress({ account: 'alice', profileNamespaceId: 7, profileRev: -2 }),
    ).toBe(false);
  });
});
