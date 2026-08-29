import { describe, expect, it, vi } from 'vitest';
import { FederationThreadForwardRoundService } from './federation-thread-forward-round.service.js';

function harness(
  state = {
    authorizationEpoch: 3,
    messageTargetSeq: 12,
    deletionTargetSeq: 7,
    messageProcessedThroughSeq: 4,
    deletionProcessedThroughSeq: 2,
  },
) {
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
      service.runMessages(31, 'peer.test', messageDriver),
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
  });

  it('uses the scheduler-frozen head target and message cutoff for tombstones', async () => {
    const { service, tombstoneDriver, messageDriver } = harness();

    await expect(
      service.runTombstones(31, 'peer.test', 7, 4, tombstoneDriver),
    ).resolves.toEqual({
      targetSeq: 7,
      maxMessageSeq: 4,
      processed: true,
    });

    expect(tombstoneDriver.process).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      after: 2,
      through: 7,
      maxMessageSeq: 4,
      take: 50,
    });
    expect(tombstoneDriver.complete).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      authorizationEpoch: 3,
      targetSeq: 7,
    });
    expect(messageDriver.process).not.toHaveBeenCalled();
  });

  it('does not let a stale in-memory head exceed the durable deletion target', async () => {
    const { service, tombstoneDriver } = harness();

    await service.runTombstones(31, 'peer.test', 9, 12, tombstoneDriver);

    expect(tombstoneDriver.process).toHaveBeenCalledWith(
      expect.objectContaining({ through: 7, maxMessageSeq: 12 }),
    );
  });

  it('passes independent scheduler-selected page sizes to each stream', async () => {
    const { service, messageDriver, tombstoneDriver } = harness();

    await service.runMessages(31, 'peer.test', messageDriver, 80);
    await service.runTombstones(31, 'peer.test', 7, 12, tombstoneDriver, 30);

    expect(messageDriver.process).toHaveBeenCalledWith(
      expect.objectContaining({ take: 80 }),
    );
    expect(tombstoneDriver.process).toHaveBeenCalledWith(
      expect.objectContaining({ take: 30 }),
    );
  });

  it('does nothing when each durable position covers its selected target', async () => {
    const { service, messageDriver, tombstoneDriver } = harness({
      authorizationEpoch: 3,
      messageTargetSeq: 12,
      deletionTargetSeq: 7,
      messageProcessedThroughSeq: 12,
      deletionProcessedThroughSeq: 7,
    });

    await expect(
      service.runMessages(31, 'peer.test', messageDriver),
    ).resolves.toEqual({ targetSeq: 12, processed: false });
    await expect(
      service.runTombstones(31, 'peer.test', 7, 12, tombstoneDriver),
    ).resolves.toEqual({
      targetSeq: 7,
      maxMessageSeq: 12,
      processed: false,
    });
    expect(messageDriver.process).not.toHaveBeenCalled();
    expect(tombstoneDriver.process).not.toHaveBeenCalled();
  });
});
