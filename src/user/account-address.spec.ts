import { describe, expect, it, vi } from 'vitest';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  readAccountTarget,
} from './account-address.js';

describe('account targets', () => {
  it('accepts a foreign address without querying or materializing an account', async () => {
    const identity = { account: 'alice', namespaceId: 7 };
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
      namespaceId: 0,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    null,
    {},
    { account: 'alice', namespaceId: -1 },
    { account: '', namespaceId: 7 },
    { account: 'alice', namespaceId: 1.5 },
  ])('rejects invalid persisted command coordinates: %j', (value) => {
    expect(() => readAccountTarget(value)).toThrow();
  });

  it('retains the exact namespace of a persisted foreign target', () => {
    expect(
      readAccountTarget({
        account: 'alice',
        namespaceId: 7,
      }),
    ).toEqual({
      account: 'alice',
      namespaceId: 7,
    });
  });
});
