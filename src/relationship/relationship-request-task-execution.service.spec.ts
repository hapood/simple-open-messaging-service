import { describe, expect, it, vi } from 'vitest';
import { RelationshipRequestTaskExecutionService } from './relationship-request-task-execution.service.js';

function createHarness(peerDomain: string) {
  const tx = {
    query: {
      user: {
        findFirst: vi.fn().mockResolvedValue({ domain: peerDomain }),
      },
    },
  };
  const rejectRelationshipRequest = vi.fn(
    async (
      _peerUserId: number,
      _actorUserId: number,
      afterClose: (transaction: typeof tx, peerUserId: number) => Promise<void>,
    ) => afterClose(tx, 9),
  );
  const revokeRelationshipRequest = vi.fn(
    async (
      _peerUserId: number,
      _actorUserId: number,
      afterClose: (transaction: typeof tx, peerUserId: number) => Promise<void>,
    ) => afterClose(tx, 9),
  );
  const acceptRelationshipRequest = vi.fn(
    async (
      _peerUserId: number,
      _actorUserId: number,
      afterAccept: (
        transaction: typeof tx,
        peerUserId: number,
      ) => Promise<void>,
    ) => {
      await afterAccept(tx, 9);
      return { threadId: 12, fromUserId: 9 };
    },
  );
  const writeLocalP2PIntentInTx = vi
    .fn()
    .mockResolvedValue([{ userId: 7, feedId: 4 }]);
  const writeP2PIntentInTx = vi
    .fn()
    .mockResolvedValue(new Map([['peer.test', 5n]]));
  const pushStateFeedDomains = vi.fn().mockResolvedValue(undefined);
  const notifyFeedUpdates = vi.fn();
  const service = new RelationshipRequestTaskExecutionService(
    {
      acceptRelationshipRequest,
      rejectRelationshipRequest,
      revokeRelationshipRequest,
      writeLocalP2PIntentInTx,
    } as never,
    { writeP2PIntentInTx } as never,
    { pushStateFeedDomains } as never,
    { notifyFeedUpdates } as never,
  );
  return {
    service,
    tx,
    rejectRelationshipRequest,
    revokeRelationshipRequest,
    acceptRelationshipRequest,
    writeLocalP2PIntentInTx,
    writeP2PIntentInTx,
    pushStateFeedDomains,
    notifyFeedUpdates,
  };
}

describe('RelationshipRequestTaskExecutionService', () => {
  it('executes local acceptance through the original transaction', async () => {
    const harness = createHarness('local');

    await harness.service.accept(9, 7);

    expect(harness.acceptRelationshipRequest).toHaveBeenCalledWith(
      9,
      7,
      expect.any(Function),
    );
    expect(harness.writeLocalP2PIntentInTx).toHaveBeenCalledWith(
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
    ['reject', 9],
    ['revoke', 9],
  ] as const)(
    'executes local %s through the original transaction',
    async (operation, peerUserId) => {
      const harness = createHarness('local');

      await harness.service[operation](peerUserId, 7);

      expect(harness[`${operation}RelationshipRequest`]).toHaveBeenCalledWith(
        peerUserId,
        7,
        expect.any(Function),
      );
      expect(harness.writeLocalP2PIntentInTx).toHaveBeenCalledWith(
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

    await harness.service.revoke(9, 7);

    expect(harness.writeP2PIntentInTx).toHaveBeenCalledWith(
      harness.tx,
      7,
      9,
      false,
      '',
      expect.any(Array),
    );
    expect(harness.writeLocalP2PIntentInTx).not.toHaveBeenCalled();
    expect([...harness.pushStateFeedDomains.mock.calls[0][0]]).toEqual([
      'peer.test',
    ]);
  });
});
