import { describe, expect, it, vi } from 'vitest';
import { UserService } from './user.service.js';
import type { DatabaseService } from '../database/database.service.js';
import { account } from '../database/schema.js';

function setup(rows: { id: number; account: string }[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  const tx = { insert };
  const database = {
    db: { transaction: (run: (value: typeof tx) => unknown) => run(tx) },
  } as unknown as DatabaseService;
  return { service: new UserService(database), insert, values };
}

describe('UserService self account', () => {
  it('selects only account facts without joining or querying profiles', async () => {
    const row = {
      id: 3,
      account: 'qifaai2',
      namespaceId: 0,
      profileRev: 0,
      isGroup: false,
      isDeleted: false,
    };
    const limit = vi.fn().mockResolvedValue([row]);
    const where = vi.fn(() => ({ limit }));
    // Deliberately provide no join or secondary query API.
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const database = { db: { select } } as unknown as DatabaseService;
    expect(await new UserService(database).findSelfAccount(3)).toEqual(row);
    expect(from).toHaveBeenCalledExactlyOnceWith(account);
    expect(select).toHaveBeenCalledExactlyOnceWith({
      id: account.id,
      account: account.account,
      namespaceId: account.namespaceId,
      profileRev: account.defaultProfileRev,
      isGroup: expect.anything(),
      isDeleted: expect.anything(),
    });
  });
});

describe('UserService account creation', () => {
  it('creates a normalized account at revision zero without inserting a Profile', async () => {
    const { service, insert, values } = setup([{ id: 7, account: 'alice' }]);
    await expect(service.addUser({ account: 'Alice' })).resolves.toEqual({
      status: 0,
      data: { id: 7, account: 'alice' },
    });
    expect(insert).toHaveBeenCalledExactlyOnceWith(account);
    expect(values).toHaveBeenCalledWith({
      account: 'alice',
      namespaceId: 0,
      defaultProfileRev: 0,
      hashPwd: null,
    });
  });

  it('preserves the supplied password hash without creating a profile', async () => {
    const { service, values } = setup([{ id: 7, account: 'alice' }]);
    await service.addUser({ account: 'alice', hashPwd: 'already-hashed' });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        hashPwd: 'already-hashed',
        defaultProfileRev: 0,
      }),
    );
  });

  it('returns the existing duplicate outcome without inserting another row', async () => {
    const { service, insert } = setup([]);
    await expect(service.addUser({ account: 'alice' })).resolves.toEqual({
      status: 2,
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('rejects the reserved system account before writing', () => {
    const { service, insert } = setup([]);
    expect(() => service.addUser({ account: '$system' })).toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
