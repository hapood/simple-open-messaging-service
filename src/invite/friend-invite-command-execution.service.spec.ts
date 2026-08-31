import { describe, expect, it, vi } from 'vitest';
import { FriendInviteCommandExecutionService } from './friend-invite-command-execution.service.js';

function createHarness(peerDomain: string) {
  const tx = {
    query: {
      user: {
        findFirst: vi.fn().mockResolvedValue({ domain: peerDomain }),
      },
    },
  };
  const rejectInvite = vi.fn(
    async (
      _inviteId: string,
      _actorUserId: number,
      afterClose: (transaction: typeof tx, peerUserId: number) => Promise<void>,
    ) => afterClose(tx, 9),
  );
  const revokeInvite = vi.fn(
    async (
      _inviteId: string,
      _actorUserId: number,
      afterClose: (transaction: typeof tx, peerUserId: number) => Promise<void>,
    ) => afterClose(tx, 9),
  );
  const acceptInvite = vi.fn(
    async (
      _inviteId: string,
      _actorUserId: number,
      afterAccept: (
        transaction: typeof tx,
        peerUserId: number,
      ) => Promise<void>,
    ) => {
      await afterAccept(tx, 9);
      return { kind: 'FRIEND' as const, threadId: 12, fromUserId: 9 };
    },
  );
  const writeLocalFriendIntentInTx = vi
    .fn()
    .mockResolvedValue([{ userId: 7, feedId: 4 }]);
  const writeFriendIntentInTx = vi
    .fn()
    .mockResolvedValue(new Map([['peer.test', 5n]]));
  const pushStateFeedDomains = vi.fn().mockResolvedValue(undefined);
  const notifyFeedUpdates = vi.fn();
  const service = new FriendInviteCommandExecutionService(
    {
      acceptInvite,
      rejectInvite,
      revokeInvite,
      writeLocalFriendIntentInTx,
    } as never,
    { writeFriendIntentInTx } as never,
    { pushStateFeedDomains } as never,
    { notifyFeedUpdates } as never,
  );
  return {
    service,
    tx,
    rejectInvite,
    revokeInvite,
    acceptInvite,
    writeLocalFriendIntentInTx,
    writeFriendIntentInTx,
    pushStateFeedDomains,
    notifyFeedUpdates,
  };
}

describe('FriendInviteCommandExecutionService', () => {
  it('executes local acceptance through the original transaction', async () => {
    const harness = createHarness('local');

    await harness.service.accept('40', 7);

    expect(harness.acceptInvite).toHaveBeenCalledWith(
      '40',
      7,
      expect.any(Function),
    );
    expect(harness.writeLocalFriendIntentInTx).toHaveBeenCalledWith(
      harness.tx,
      7,
      9,
      true,
    );
    expect(harness.notifyFeedUpdates).toHaveBeenCalledWith([
      { userId: 7, feedId: 4 },
    ]);
  });

  it.each([
    ['reject', '41'],
    ['revoke', '42'],
  ] as const)(
    'executes local %s through the original transaction',
    async (operation, inviteId) => {
      const harness = createHarness('local');

      await harness.service[operation](inviteId, 7);

      expect(harness[`${operation}Invite`]).toHaveBeenCalledWith(
        inviteId,
        7,
        expect.any(Function),
      );
      expect(harness.writeLocalFriendIntentInTx).toHaveBeenCalledWith(
        harness.tx,
        7,
        9,
        false,
      );
      expect(harness.notifyFeedUpdates).toHaveBeenCalledWith([
        { userId: 7, feedId: 4 },
      ]);
    },
  );

  it('writes a federated close in the mutation transaction', async () => {
    const harness = createHarness('peer.test');

    await harness.service.revoke('42', 7);

    expect(harness.writeFriendIntentInTx).toHaveBeenCalledWith(
      harness.tx,
      7,
      9,
      false,
      '',
      expect.any(Array),
    );
    expect(harness.writeLocalFriendIntentInTx).not.toHaveBeenCalled();
    expect([...harness.pushStateFeedDomains.mock.calls[0][0]]).toEqual([
      'peer.test',
    ]);
  });
});
