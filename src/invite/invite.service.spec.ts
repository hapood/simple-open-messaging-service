import { InviteKind, InviteStatus } from '../database/enums.js';
import { InviteService } from './invite.service.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('InviteService.friendRelationshipStatuses', () => {
  process.env.SOMS_DOMAIN = 'local.test';
  const findMany = vi.fn();
  const findUnique = vi.fn();
  const findFirst = vi.fn();
  const update = vi.fn();
  const getActiveP2PPeerUserIds = vi.fn();
  const database = {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => findMany()) })),
      })),
      query: {
        invite: { findFirst: (...args: unknown[]) => findUnique(...args) },
      },
      update: vi.fn(() => ({
        set: vi.fn((data: unknown) => ({
          where: vi.fn(() => update({ data })),
        })),
      })),
    },
  };
  const service = new InviteService(
    database as never,
    { getActiveP2PPeerUserIds } as never,
    {} as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an authoritative state for every unique requested peer', async () => {
    getActiveP2PPeerUserIds.mockResolvedValue([2]);
    findMany.mockResolvedValue([
      { id: 31n, fromUserId: 1, toUserId: 3 },
      { id: 41n, fromUserId: 4, toUserId: 1 },
      // A stale pending row cannot override an active friendship.
      { id: 21n, fromUserId: 1, toUserId: 2 },
    ]);

    await expect(
      service.friendRelationshipStatuses(1, [2, 3, 4, 5, 5, 1]),
    ).resolves.toEqual([
      { userId: 2, status: 'FRIEND' },
      { userId: 3, status: 'OUTGOING_PENDING', inviteId: '31' },
      { userId: 4, status: 'INCOMING_PENDING', inviteId: '41' },
      { userId: 5, status: 'NONE' },
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('does not query for an empty/self-only target set', async () => {
    await expect(
      service.friendRelationshipStatuses(1, [1, 1]),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(getActiveP2PPeerUserIds).not.toHaveBeenCalled();
  });

  it('revokes a matching inbound federated pending invite by origin id', async () => {
    findUnique.mockResolvedValue({
      id: 9n,
      kind: InviteKind.FRIEND,
      status: InviteStatus.PENDING,
      fromUserId: 2,
      toUserId: 1,
    });

    await service.revokeInboundFriendInvite({
      fromUserId: 2,
      toUserId: 1,
      origin: 'peer.test',
      originId: 'op-1',
    });

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: InviteStatus.REVOKED }),
    });
  });

  it('keeps an already accepted inbound invite unchanged (accept wins)', async () => {
    findUnique.mockResolvedValue({
      id: 9n,
      kind: InviteKind.FRIEND,
      status: InviteStatus.ACCEPTED,
      fromUserId: 2,
      toUserId: 1,
    });

    await service.revokeInboundFriendInvite({
      fromUserId: 2,
      toUserId: 1,
      origin: 'peer.test',
      originId: 'op-1',
    });

    expect(update).not.toHaveBeenCalled();
  });
});
