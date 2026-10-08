import { describe, expect, it } from 'vitest';
import type { ProfileNamespaceBinding } from '../services/webdb-storage';
import { namespaceDisplayDomain } from './namespace-domain.pipe';

function binding(
  overrides: Partial<ProfileNamespaceBinding> = {},
): ProfileNamespaceBinding {
  return {
    publisherNamespaceId: 0,
    profileNamespaceId: 7,
    domain: 'peer.test',
    rootPublicKey: 'root',
    updateFeedId: 1,
    changeSeq: 1,
    expired: false,
    status: 'ACTIVE',
    refreshedAt: 1,
    ...overrides,
  };
}

describe('namespaceDisplayDomain', () => {
  it('returns the current domain for an active namespace', () => {
    expect(namespaceDisplayDomain(binding())).toBe('peer.test');
  });

  it('uses the archived namespace presentation domain', () => {
    expect(
      namespaceDisplayDomain(binding({ status: 'ARCHIVED' })),
    ).toBe('7.archive.peer.test');
  });

  it('does not invent a domain for an unresolved binding', () => {
    expect(namespaceDisplayDomain(binding({ domain: null }))).toBeNull();
  });
});
