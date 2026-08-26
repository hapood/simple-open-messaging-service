import { describe, expect, it, vi } from 'vitest';
import { InviteController } from './invite.controller.js';

function makeController(federated: boolean) {
  const tx = {
    query: {
      user: {
        findFirst: vi.fn().mockResolvedValue({
          domain: federated ? 'peer.test' : 'local',
        }),
      },
    },
  };
  const inviteService = {
    revokeInvite: vi.fn(
      async (
        _inviteId: string,
        _userId: number,
        applyState: (transaction: typeof tx, toUserId: number) => Promise<void>,
      ) => applyState(tx, 9),
    ),
    writeLocalFriendIntentInTx: vi.fn().mockResolvedValue([]),
  };
  const federationService = {
    writeFriendIntentInTx: vi
      .fn()
      .mockResolvedValue(new Map([['peer.test', 3n]])),
    pushStateFeedDomains: vi.fn(),
  };
  const controller = new InviteController(
    {} as never,
    inviteService as never,
    {} as never,
    federationService as never,
    {} as never,
    { notifyFeedUpdates: vi.fn() } as never,
  );
  const request = { user: { userId: 7 } } as never;
  return { controller, inviteService, federationService, request, tx };
}

describe('InviteController.revokeInvite', () => {
  it('closes the federated direction transactionally and wakes the state feed', async () => {
    const { controller, inviteService, federationService, request, tx } =
      makeController(true);

    await controller.revokeInvite(request, { inviteId: '42' });

    expect(inviteService.revokeInvite).toHaveBeenCalledWith(
      '42',
      7,
      expect.any(Function),
    );
    expect(federationService.writeFriendIntentInTx).toHaveBeenCalledWith(
      tx,
      7,
      9,
      false,
      '',
      expect.any(Array),
    );
    expect(federationService.pushStateFeedDomains).toHaveBeenCalledWith(
      expect.anything(),
    );
    expect([
      ...federationService.pushStateFeedDomains.mock.calls[0][0],
    ]).toEqual(['peer.test']);
  });

  it('uses the same directed fact state machine for a local friend', async () => {
    const { controller, inviteService, federationService, request, tx } =
      makeController(false);

    await controller.revokeInvite(request, { inviteId: '42' });

    expect(inviteService.writeLocalFriendIntentInTx).toHaveBeenCalledWith(
      tx,
      7,
      9,
      false,
    );
    expect(federationService.writeFriendIntentInTx).not.toHaveBeenCalled();
    expect([
      ...federationService.pushStateFeedDomains.mock.calls[0][0],
    ]).toEqual([]);
  });
});
