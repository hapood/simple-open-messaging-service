import { describe, expect, it, vi } from 'vitest';
import { InviteController } from './invite.controller.js';

function makeController() {
  const inviteService = {
    getOutgoingRevokeContext: vi.fn(),
    revokeInvite: vi.fn(),
  };
  const federationService = {
    sendInviteRevoke: vi.fn(),
  };
  const controller = new InviteController(
    {} as never,
    inviteService as never,
    {} as never,
    {} as never,
    federationService as never,
    {} as never,
  );
  const request = { user: { userId: 7 } } as never;
  return { controller, inviteService, federationService, request };
}

describe('InviteController.revokeInvite', () => {
  it('waits for a federated peer acknowledgement before revoking locally', async () => {
    const { controller, inviteService, federationService, request } =
      makeController();
    inviteService.getOutgoingRevokeContext.mockResolvedValue({
      originId: 'shared-op-id',
      toUser: {
        account: 'bob',
        domain: 'peer.test',
        isForeigner: true,
      },
    });
    federationService.sendInviteRevoke.mockResolvedValue(undefined);
    inviteService.revokeInvite.mockResolvedValue(undefined);

    await controller.revokeInvite(request, { inviteId: '42' });

    expect(federationService.sendInviteRevoke).toHaveBeenCalledWith({
      fromLocalUserId: 7,
      to: { account: 'bob', domain: 'peer.test' },
      inviteOriginId: 'shared-op-id',
    });
    expect(inviteService.revokeInvite).toHaveBeenCalledWith('42', 7);
    expect(
      federationService.sendInviteRevoke.mock.invocationCallOrder[0],
    ).toBeLessThan(inviteService.revokeInvite.mock.invocationCallOrder[0]);
  });

  it('keeps the local invite pending when federated delivery fails', async () => {
    const { controller, inviteService, federationService, request } =
      makeController();
    inviteService.getOutgoingRevokeContext.mockResolvedValue({
      originId: 'shared-op-id',
      toUser: {
        account: 'bob',
        domain: 'peer.test',
        isForeigner: true,
      },
    });
    federationService.sendInviteRevoke.mockRejectedValue(new Error('offline'));

    await expect(
      controller.revokeInvite(request, { inviteId: '42' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('could not reach peer.test'),
    });
    expect(inviteService.revokeInvite).not.toHaveBeenCalled();
  });

  it('revokes a local invite without making an S2S call', async () => {
    const { controller, inviteService, federationService, request } =
      makeController();
    inviteService.getOutgoingRevokeContext.mockResolvedValue({
      originId: 'local-op-id',
      toUser: {
        account: 'bob',
        domain: 'local',
        isForeigner: false,
      },
    });
    inviteService.revokeInvite.mockResolvedValue(undefined);

    await controller.revokeInvite(request, { inviteId: '42' });

    expect(federationService.sendInviteRevoke).not.toHaveBeenCalled();
    expect(inviteService.revokeInvite).toHaveBeenCalledWith('42', 7);
  });
});
