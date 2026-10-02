import { describe, expect, it } from 'vitest';
import { businessAccountScopeKey } from './account-business-lock.js';

describe('business scope lock keys', () => {
  it('uses one account-address scope for users', () => {
    expect(
      businessAccountScopeKey({ profileNamespaceId: 12, account: 'alice' }),
    ).toBe('["business-scope","ACCOUNT",12,"alice"]');
  });

  it('uses the same account-address scope for groups', () => {
    expect(
      businessAccountScopeKey({
        profileNamespaceId: 12,
        account: '!group',
      }),
    ).toBe('["business-scope","ACCOUNT",12,"!group"]');
  });
});
