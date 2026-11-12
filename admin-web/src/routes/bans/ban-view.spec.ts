import { describe, expect, it } from 'vitest';
import { accountRestrictions, groupRestrictions } from './ban-view';
import type { Ban } from '@/types/api';
const bans: Ban[] = ['user', 'otp', 'admin_pwd', 'admin_2fa', 'ip'].map(
  (type) => ({
    userId: type === 'ip' ? null : 42,
    key: `${type}:alice`,
    type: type as Ban['type'],
    value: 'alice',
    until: 2000,
    remainingMs: 1000,
  }),
);
describe('restriction grouping', () => {
  it('combines all four account entry points but never assigns IPs to an account', () => {
    const result = groupRestrictions(bans, '', 1000);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0][1]).toHaveLength(4);
    expect(result.ips).toHaveLength(1);
    expect(accountRestrictions(bans, 'alice', 1000)).toHaveLength(4);
  });
  it('filters names and drops expired observations', () => {
    expect(groupRestrictions(bans, 'BOB', 1000).accounts).toHaveLength(0);
    expect(groupRestrictions(bans, 'ALICE', 1000).accounts).toHaveLength(1);
    expect(groupRestrictions(bans, '', 2000)).toEqual({
      accounts: [],
      ips: [],
    });
  });
});
