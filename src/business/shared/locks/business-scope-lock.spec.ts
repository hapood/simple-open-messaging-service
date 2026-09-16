import { describe, expect, it } from 'vitest';
import { businessAccountScopeKey } from './account-business-lock.js';

describe('business scope lock keys', () => {
  it('uses one account-address scope for users', () => {
    expect(
      businessAccountScopeKey({ domain: 'Peer.Example', account: 'alice' }),
    ).toBe('["business-scope","ACCOUNT","peer.example","alice"]');
  });

  it('uses the same account-address scope for groups', () => {
    expect(
      businessAccountScopeKey({
        domain: 'Peer.Example',
        account: '!group',
      }),
    ).toBe('["business-scope","ACCOUNT","peer.example","!group"]');
  });
});
