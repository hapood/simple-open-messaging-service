import { describe, expect, it, vi } from 'vitest';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  readAccountTarget,
} from './account-address.js';

describe('account targets', () => {
  it('accepts a foreign address without querying or materializing an account', async () => {
    const identity = { account: 'alice', domain: 'alpha.test', namespaceId: 7 };
    expect(await accountAddressInTx({} as never, identity)).toEqual(identity);
    expect(await localAccountsForTargetsInTx({} as never, [identity])).toEqual(
      [],
    );
  });

  it('requires a real local account when resolving an internal account ID', async () => {
    const findFirst = vi.fn().mockResolvedValue(undefined);
    const tx = { query: { account: { findFirst } } };
    await expect(accountAddressInTx(tx as never, 8)).rejects.toThrow(
      'local account does not exist',
    );
    findFirst.mockResolvedValue({ account: 'bob' });
    expect(await accountAddressInTx(tx as never, 8)).toEqual({
      account: 'bob',
      domain: 'local',
      namespaceId: 0,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    null,
    {},
    { account: 'alice', domain: 'local', namespaceId: 7 },
    { account: 'alice', domain: 'alpha.test', namespaceId: 0 },
  ])('rejects invalid persisted command coordinates: %j', (value) => {
    expect(() => readAccountTarget(value)).toThrow();
  });

  it('retains the exact namespace of a persisted foreign target', () => {
    expect(
      readAccountTarget({
        account: 'alice',
        domain: 'alpha.test',
        namespaceId: 7,
      }),
    ).toEqual({
      account: 'alice',
      domain: 'alpha.test',
      namespaceId: 7,
    });
  });
});
