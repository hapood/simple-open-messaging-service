import { describe, expect, it, vi } from 'vitest';
import { writeProfileSnapshotInTx } from './profile-store.js';

const snapshot = {
  account: 'alice',
  publisherNamespaceId: 7,
  profileNamespaceId: 7,
  profileRev: 3,
  displayName: 'Alice',
  avatar: '',
  bio: 'Hello',
};

function transaction(existing?: typeof snapshot) {
  const returning = vi
    .fn()
    .mockResolvedValue(existing ? [] : [{ account: snapshot.account }]);
  const values = vi.fn(() => ({ onConflictDoNothing: () => ({ returning }) }));
  return {
    insert: vi.fn(() => ({ values })),
    query: { profileTable: { findFirst: vi.fn().mockResolvedValue(existing) } },
    values,
  };
}

describe('immutable addressed profiles', () => {
  it('stores a third-party subject in its publisher namespace without an account row', async () => {
    const tx = transaction();
    await writeProfileSnapshotInTx(tx as never, snapshot);
    expect(tx.values).toHaveBeenCalledWith(snapshot);
    expect(tx.query.profileTable.findFirst).not.toHaveBeenCalled();
  });

  it('accepts an identical replay', async () => {
    await expect(
      writeProfileSnapshotInTx(transaction(snapshot) as never, snapshot),
    ).resolves.toBeUndefined();
  });

  it('rejects conflicting contents at the same exact revision', async () => {
    const tx = transaction(snapshot);
    await expect(
      writeProfileSnapshotInTx(tx as never, {
        ...snapshot,
        displayName: 'Mallory',
      }),
    ).rejects.toThrow('conflicting immutable profile revision');
  });
});
