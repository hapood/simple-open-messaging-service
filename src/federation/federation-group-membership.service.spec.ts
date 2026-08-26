import { describe, expect, it, vi } from 'vitest';
import { FederationGroupMembershipService } from './federation-group-membership.service.js';

describe('FederationGroupMembershipService', () => {
  it('materializes a member only when the folded pair is active', async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const remove = vi.fn();
    const service = new FederationGroupMembershipService();

    await service.syncFromActiveInTx(
      { insert, delete: remove } as never,
      { threadId: 7, memberUserId: 11, active: true },
    );

    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 7, userId: 11, role: 'MEMBER' }),
    );
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes the member projection when the folded pair becomes inactive', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn(() => ({ where }));
    const insert = vi.fn();
    const service = new FederationGroupMembershipService();

    await service.syncFromActiveInTx(
      { insert, delete: remove } as never,
      { threadId: 7, memberUserId: 11, active: false },
    );

    expect(remove).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });
});
