import { InviteKind, InviteStatus } from '../prisma/generated/client.js';
import { InviteService } from './invite.service.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('InviteService.friendRelationshipStatuses', () => {
  process.env.SOMS_DOMAIN = 'local.test';
  const findMany = vi.fn();
  const findUnique = vi.fn();
  const findFirst = vi.fn();
  const update = vi.fn();
  const getActiveP2PPeerUserIds = vi.fn();
  const service = new InviteService(
    { invite: { findMany, findUnique, findFirst, update } } as never,
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
    expect(findMany).toHaveBeenCalledWith({
      where: {
        kind: InviteKind.FRIEND,
        status: InviteStatus.PENDING,
        expiresAt: { gt: expect.any(Date) },
        OR: [
          { fromUserId: 1, toUserId: { in: [2, 3, 4, 5] } },
          { toUserId: 1, fromUserId: { in: [2, 3, 4, 5] } },
        ],
      },
      select: { id: true, fromUserId: true, toUserId: true },
    });
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

    expect(findUnique).toHaveBeenCalledWith({
      where: { origin_originId: { origin: 'peer.test', originId: 'op-1' } },
      select: { id: true, kind: true, status: true, fromUserId: true, toUserId: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 9n },
      data: { status: InviteStatus.REVOKED },
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
