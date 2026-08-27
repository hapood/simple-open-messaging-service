import { describe, expect, it, vi } from 'vitest';
import { threadMember, threadParticipant } from '../database/schema.js';
import { FederationGroupMembershipService } from './federation-group-membership.service.js';

describe('FederationGroupMembershipService', () => {
  it('materializes independent local state and hosted roster projections when active', async () => {
    const participantConflict = vi.fn().mockResolvedValue(undefined);
    const memberReturning = vi.fn().mockResolvedValue([{ role: 'OWNER' }]);
    const memberConflict = vi.fn(() => ({ returning: memberReturning }));
    const participantValues = vi.fn(() => ({
      onConflictDoUpdate: participantConflict,
    }));
    const memberValues = vi.fn(() => ({
      onConflictDoUpdate: memberConflict,
    }));
    const insert = vi.fn((table) => ({
      values: table === threadParticipant ? participantValues : memberValues,
    }));
    const update = vi.fn();
    const service = new FederationGroupMembershipService();

    await service.syncFromActiveInTx(
      {
        query: {
          account: { findFirst: vi.fn().mockResolvedValue({ id: 11 }) },
        },
        insert,
        update,
      } as never,
      {
        threadId: 7,
        memberUserId: 11,
        active: true,
        hostedLocally: true,
      },
    );

    expect(insert).toHaveBeenNthCalledWith(1, threadMember);
    expect(memberValues).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 7, userId: 11, role: 'MEMBER' }),
    );
    expect(memberConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          left: false,
          role: expect.anything(),
          joinedAt: expect.anything(),
        }),
      }),
    );
    expect(memberReturning).toHaveBeenCalledWith({ role: threadMember.role });
    expect(insert).toHaveBeenNthCalledWith(2, threadParticipant);
    expect(participantValues).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 11, threadId: 7, role: 'OWNER' }),
    );
    expect(participantConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          role: 'OWNER',
          messageVisibleBeforeSeq: null,
        }),
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('retains and marks the member projection when the folded pair becomes inactive', async () => {
    const set = vi.fn();
    const where = vi.fn().mockResolvedValue(undefined);
    set.mockReturnValue({ where });
    const update = vi.fn(() => ({ set }));
    const insert = vi.fn();
    const service = new FederationGroupMembershipService();

    await service.syncFromActiveInTx(
      {
        query: {
          account: { findFirst: vi.fn().mockResolvedValue({ id: 11 }) },
        },
        insert,
        update,
      } as never,
      {
        threadId: 7,
        memberUserId: 11,
        active: false,
        hostedLocally: true,
      },
    );

    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ left: true, updatedAt: expect.any(Date) }),
    );
    expect(where).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });

  it('materializes only local conversation state for a mirrored group', async () => {
    const participantConflict = vi.fn().mockResolvedValue(undefined);
    const participantValues = vi.fn(() => ({
      onConflictDoUpdate: participantConflict,
    }));
    const insert = vi.fn((table) => {
      expect(table).toBe(threadParticipant);
      return { values: participantValues };
    });
    const service = new FederationGroupMembershipService();

    await service.syncFromActiveInTx(
      {
        query: {
          account: { findFirst: vi.fn().mockResolvedValue({ id: 11 }) },
        },
        insert,
        update: vi.fn(),
      } as never,
      {
        threadId: 7,
        memberUserId: 11,
        active: true,
        hostedLocally: false,
      },
    );

    expect(insert).toHaveBeenCalledOnce();
    expect(participantValues).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 11, threadId: 7, role: 'MEMBER' }),
    );
    expect(participantConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ role: 'MEMBER' }),
      }),
    );
  });
});
