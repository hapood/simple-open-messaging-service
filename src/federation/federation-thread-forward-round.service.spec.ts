import { describe, expect, it, vi } from 'vitest';
import { FederationThreadForwardRoundService } from './federation-thread-forward-round.service.js';

function harness(
  state = {
    messageTargetSeq: 12,
    deletionTargetSeq: 7,
    messageProcessedThroughSeq: 4,
    deletionProcessedThroughSeq: 2,
  },
) {
  const states = { require: vi.fn().mockResolvedValue(state) };
  const service = new FederationThreadForwardRoundService(states as never);
  const driver = {
    processMessages: vi.fn().mockResolvedValue({ blockedByPending: false }),
    processTombstones: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  return { service, states, driver };
}

describe('FederationThreadForwardRoundService', () => {
  it('freezes targets and runs independent message and tombstone work concurrently', async () => {
    const { service, states, driver } = harness();
    let releaseMessage!: () => void;
    let releaseTombstone!: () => void;
    const messageGate = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    const tombstoneGate = new Promise<void>((resolve) => {
      releaseTombstone = resolve;
    });
    driver.processMessages.mockReturnValueOnce(
      messageGate.then(() => ({ blockedByPending: false })),
    );
    driver.processTombstones.mockReturnValueOnce(tombstoneGate);

    const running = service.run(31, 'peer.test', driver);
    await vi.waitFor(() => {
      expect(driver.processMessages).toHaveBeenCalledOnce();
      expect(driver.processTombstones).toHaveBeenCalledOnce();
    });
    expect(driver.processMessages).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      after: 4,
      through: 12,
      take: 50,
    });
    expect(driver.processTombstones).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      after: 2,
      through: 7,
      maxMessageSeq: 12,
      take: 50,
    });
    expect(driver.complete).not.toHaveBeenCalled();

    states.require.mockResolvedValueOnce({
      messageTargetSeq: 20,
      deletionTargetSeq: 9,
      messageProcessedThroughSeq: 4,
      deletionProcessedThroughSeq: 2,
    });
    releaseMessage();
    await Promise.resolve();
    expect(driver.complete).not.toHaveBeenCalled();
    releaseTombstone();
    await expect(running).resolves.toEqual({
      messageTargetSeq: 12,
      deletionTargetSeq: 7,
      processedMessages: true,
      processedTombstones: true,
      blockedByPending: false,
    });
    expect(driver.complete).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      messageTargetSeq: 12,
      deletionTargetSeq: 7,
    });
    expect(states.require).toHaveBeenCalledOnce();
  });

  it('runs a tombstone-only target in the same forward round', async () => {
    const { service, driver } = harness({
      messageTargetSeq: 0,
      deletionTargetSeq: 7,
      messageProcessedThroughSeq: 0,
      deletionProcessedThroughSeq: 2,
    });

    await expect(service.run(31, 'peer.test', driver)).resolves.toMatchObject({
      processedMessages: false,
      processedTombstones: true,
    });
    expect(driver.processMessages).not.toHaveBeenCalled();
    expect(driver.processTombstones).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      after: 2,
      through: 7,
      maxMessageSeq: 0,
      take: 50,
    });
  });

  it('passes a scheduler-selected page size to both drains', async () => {
    const { service, driver } = harness();

    await service.run(31, 'peer.test', driver, 80);

    expect(driver.processMessages).toHaveBeenCalledWith(
      expect.objectContaining({ take: 80 }),
    );
    expect(driver.processTombstones).toHaveBeenCalledWith(
      expect.objectContaining({ take: 80 }),
    );
  });

  it('does nothing when both durable processed positions cover the frozen targets', async () => {
    const { service, driver } = harness({
      messageTargetSeq: 12,
      deletionTargetSeq: 7,
      messageProcessedThroughSeq: 12,
      deletionProcessedThroughSeq: 7,
    });

    await expect(service.run(31, 'peer.test', driver)).resolves.toEqual({
      messageTargetSeq: 12,
      deletionTargetSeq: 7,
      processedMessages: false,
      processedTombstones: false,
      blockedByPending: false,
    });
    expect(driver.processMessages).not.toHaveBeenCalled();
    expect(driver.processTombstones).not.toHaveBeenCalled();
    expect(driver.complete).not.toHaveBeenCalled();
  });
});
