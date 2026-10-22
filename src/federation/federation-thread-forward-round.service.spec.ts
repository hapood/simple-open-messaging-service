import { describe, expect, it, vi } from 'vitest';
import { FederationThreadForwardRoundService } from './federation-thread-forward-round.service.js';

function harness(overrides: Record<string, unknown> = {}) {
  const state = {
    authorizationEpoch: 3,
    messageTargetSeq: 12,
    deletionTargetSeq: 7,
    messageProcessedThroughSeq: 4,
    deletionProcessedThroughSeq: 2,
    deletionRecoveryThroughSeq: null,
    deletionRecoveryMaxMessageSeq: null,
    ...overrides,
  };
  const states = { require: vi.fn().mockResolvedValue(state) };
  const service = new FederationThreadForwardRoundService(states as never);
  const messageDriver = {
    process: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const tombstoneDriver = {
    process: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  return { service, states, messageDriver, tombstoneDriver };
}

describe('FederationThreadForwardRoundService', () => {
  it('freezes and commits one message page independently', async () => {
    const { service, states, messageDriver, tombstoneDriver } = harness();

    await expect(
      service.runMessages(31, 'peer.test', 7, messageDriver),
    ).resolves.toEqual({ targetSeq: 12, processed: true });

    expect(messageDriver.process).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      after: 4,
      through: 12,
      take: 50,
    });
    expect(messageDriver.complete).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      authorizationEpoch: 3,
      targetSeq: 12,
    });
    expect(tombstoneDriver.process).not.toHaveBeenCalled();
    expect(states.require).toHaveBeenCalledOnce();
    expect(states.require).toHaveBeenCalledWith(31, 7);
  });

  it('omits the message cutoff during ordinary tombstone consumption', async () => {
    const { service, tombstoneDriver } = harness();

    await expect(
      service.runTombstones(31, 'peer.test', 7, tombstoneDriver),
    ).resolves.toEqual({
      targetSeq: 7,
      maxMessageSeq: undefined,
      processed: true,
    });
    expect(tombstoneDriver.process).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      after: 2,
      through: 7,
      maxMessageSeq: undefined,
      take: 50,
    });
  });

  it('keeps the persisted reauthorization target and cutoff frozen', async () => {
    const { service, tombstoneDriver } = harness({
      deletionTargetSeq: 12,
      deletionRecoveryThroughSeq: 9,
      deletionRecoveryMaxMessageSeq: 4,
    });

    await expect(
      service.runTombstones(31, 'peer.test', 7, tombstoneDriver),
    ).resolves.toEqual({
      targetSeq: 9,
      maxMessageSeq: 4,
      processed: true,
    });
    expect(tombstoneDriver.process).toHaveBeenCalledWith(
      expect.objectContaining({ through: 9, maxMessageSeq: 4 }),
    );
  });

  it('passes independent scheduler-selected page sizes to each stream', async () => {
    const { service, messageDriver, tombstoneDriver } = harness();

    await service.runMessages(31, 'peer.test', 7, messageDriver, 80);
    await service.runTombstones(31, 'peer.test', 7, tombstoneDriver, 30);

    expect(messageDriver.process).toHaveBeenCalledWith(
      expect.objectContaining({ take: 80 }),
    );
    expect(tombstoneDriver.process).toHaveBeenCalledWith(
      expect.objectContaining({ take: 30 }),
    );
  });

  it('does nothing when each durable position covers its target', async () => {
    const { service, messageDriver, tombstoneDriver } = harness({
      messageProcessedThroughSeq: 12,
      deletionProcessedThroughSeq: 7,
    });

    await expect(
      service.runMessages(31, 'peer.test', 7, messageDriver),
    ).resolves.toEqual({ targetSeq: 12, processed: false });
    await expect(
      service.runTombstones(31, 'peer.test', 7, tombstoneDriver),
    ).resolves.toEqual({
      targetSeq: 7,
      maxMessageSeq: undefined,
      processed: false,
    });
    expect(messageDriver.process).not.toHaveBeenCalled();
    expect(tombstoneDriver.process).not.toHaveBeenCalled();
  });

  it.each([
    ['message', 'runMessages', 'messageDriver'],
    ['tombstone', 'runTombstones', 'tombstoneDriver'],
  ] as const)(
    'does not commit a buffered %s page when its network phase fails',
    async (_label, method, driverName) => {
      const { service, messageDriver, tombstoneDriver } = harness();
      const driver = { messageDriver, tombstoneDriver }[driverName];
      driver.process.mockRejectedValueOnce(new Error('network unavailable'));

      await expect(
        service[method](31, 'peer.test', 7, driver as never),
      ).rejects.toMatchObject({
        name: 'FederationThreadRoundRemoteError',
        authorizationEpoch: 3,
      });

      expect(driver.complete).not.toHaveBeenCalled();
    },
  );
});
