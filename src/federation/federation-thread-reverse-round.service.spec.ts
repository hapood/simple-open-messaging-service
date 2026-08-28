import { describe, expect, it, vi } from 'vitest';
import { FederationThreadReverseRoundService } from './federation-thread-reverse-round.service.js';

function harness(
  state: {
    reverseNextBeforeSeq: number;
    reverseClosureOriginSeq: number | null;
    historyBoundaryReached: boolean;
  } = {
    reverseNextBeforeSeq: 100,
    reverseClosureOriginSeq: null,
    historyBoundaryReached: false,
  },
) {
  const states = {
    require: vi.fn().mockResolvedValue(state),
    deriveReusableReverseBatch: vi.fn().mockResolvedValue({
      sourceSeqs: [],
      batchOldestSeq: null,
      reachedClosureTarget: false,
      canSkipMessageQuery: false,
    }),
  };
  const driver = {
    fetchMessages: vi.fn().mockResolvedValue({
      kind: 'page',
      scannedThrough: 50,
      hasMore: true,
    }),
    processDepartedMemberProfiles: vi.fn().mockResolvedValue(undefined),
    hasBlockingPendingAtFrontier: vi.fn().mockResolvedValue(false),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new FederationThreadReverseRoundService(states as never),
    states,
    driver,
  };
}

describe('FederationThreadReverseRoundService', () => {
  it('uses the persisted before cursor directly for messages and group profiles', async () => {
    const { service, states, driver } = harness();

    await expect(service.run(31, 'peer.test', driver)).resolves.toEqual({
      beforeSeq: 100,
      closureOriginSeq: null,
      batchOldestSeq: 50,
      nextBeforeSeq: 50,
      fetchedMessages: true,
      processedDepartedMemberProfiles: true,
      blockedByPending: false,
      closesReverseHistory: false,
    });
    expect(states.deriveReusableReverseBatch).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      beforeSeq: 100,
      closureOriginSeq: null,
      take: 50,
    });
    expect(driver.fetchMessages).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      before: 100,
      take: 50,
    });
    expect(driver.processDepartedMemberProfiles).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      before: 100,
      through: 50,
      take: 50,
    });
    expect(driver.complete).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      frozenBeforeSeq: 100,
      frozenClosureOriginSeq: null,
      nextBeforeSeq: 50,
      closesReverseHistory: false,
    });
  });

  it('uses hasMore false as proof of the serviceable history boundary', async () => {
    const { service, driver } = harness();
    driver.fetchMessages.mockResolvedValueOnce({
      kind: 'page',
      scannedThrough: 40,
      hasMore: false,
    });

    await expect(service.run(31, 'peer.test', driver)).resolves.toMatchObject({
      nextBeforeSeq: 40,
      closesReverseHistory: true,
    });
    expect(driver.complete).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      frozenBeforeSeq: 100,
      frozenClosureOriginSeq: null,
      nextBeforeSeq: 40,
      closesReverseHistory: true,
    });
  });

  it('reuses a complete durable batch without requesting messages', async () => {
    const { service, states, driver } = harness();
    states.deriveReusableReverseBatch.mockResolvedValueOnce({
      sourceSeqs: Array.from({ length: 50 }, (_, index) => 99 - index),
      batchOldestSeq: 50,
      reachedClosureTarget: false,
      canSkipMessageQuery: true,
    });

    await expect(service.run(31, 'peer.test', driver)).resolves.toMatchObject({
      batchOldestSeq: 50,
      nextBeforeSeq: 50,
      fetchedMessages: false,
      closesReverseHistory: false,
    });
    expect(driver.fetchMessages).not.toHaveBeenCalled();
    expect(driver.processDepartedMemberProfiles).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      before: 100,
      through: 50,
      take: 50,
    });
  });

  it('allows a P2P driver to omit departed-member profile processing', async () => {
    const { service, driver } = harness();
    const { processDepartedMemberProfiles: _, ...p2pDriver } = driver;

    await expect(
      service.run(31, 'peer.test', p2pDriver),
    ).resolves.toMatchObject({
      processedDepartedMemberProfiles: false,
    });
    expect(p2pDriver.complete).toHaveBeenCalledOnce();
  });

  it('exits before deriving a batch when the publication frontier is pending', async () => {
    const { service, states, driver } = harness();
    driver.hasBlockingPendingAtFrontier.mockResolvedValueOnce(true);

    await expect(service.run(31, 'peer.test', driver)).resolves.toEqual({
      beforeSeq: 100,
      closureOriginSeq: null,
      batchOldestSeq: null,
      nextBeforeSeq: 100,
      fetchedMessages: false,
      processedDepartedMemberProfiles: false,
      blockedByPending: true,
      closesReverseHistory: false,
    });
    expect(states.deriveReusableReverseBatch).not.toHaveBeenCalled();
    expect(driver.fetchMessages).not.toHaveBeenCalled();
    expect(driver.processDepartedMemberProfiles).not.toHaveBeenCalled();
    expect(driver.complete).not.toHaveBeenCalled();
  });

  it('accepts a proven serviceable history boundary without moving before', async () => {
    const { service, driver } = harness();
    driver.fetchMessages.mockResolvedValueOnce({ kind: 'history-boundary' });

    await expect(service.run(31, 'peer.test', driver)).resolves.toMatchObject({
      batchOldestSeq: null,
      nextBeforeSeq: 100,
      closesReverseHistory: true,
    });
    expect(driver.processDepartedMemberProfiles).not.toHaveBeenCalled();
    expect(driver.complete).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      frozenBeforeSeq: 100,
      frozenClosureOriginSeq: null,
      nextBeforeSeq: 100,
      closesReverseHistory: true,
    });
  });

  it('passes an explicit round take through both paginated dependencies', async () => {
    const { service, driver } = harness();

    await service.run(31, 'peer.test', driver, 20);

    expect(driver.fetchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
    expect(driver.processDepartedMemberProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
  });

  it('accepts the exclusive sentinel immediately above the thread sequence range', async () => {
    const { service, driver } = harness({
      reverseNextBeforeSeq: Number.MAX_SAFE_INTEGER,
      reverseClosureOriginSeq: null,
      historyBoundaryReached: false,
    });

    await expect(service.run(31, 'peer.test', driver)).resolves.toMatchObject({
      beforeSeq: Number.MAX_SAFE_INTEGER,
    });
    expect(driver.fetchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ before: Number.MAX_SAFE_INTEGER }),
    );
  });

  it('passes the closure target as through and completes when scanning reaches it', async () => {
    const { service, driver } = harness({
      reverseNextBeforeSeq: 100,
      reverseClosureOriginSeq: 40,
      historyBoundaryReached: false,
    });
    driver.fetchMessages.mockResolvedValueOnce({
      kind: 'page',
      scannedThrough: 40,
      hasMore: true,
    });

    await expect(service.run(31, 'peer.test', driver)).resolves.toMatchObject({
      closureOriginSeq: 40,
      nextBeforeSeq: 40,
      closesReverseHistory: true,
    });
    expect(driver.fetchMessages).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      before: 100,
      through: 40,
      take: 50,
    });
    expect(driver.complete).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      frozenBeforeSeq: 100,
      frozenClosureOriginSeq: 40,
      nextBeforeSeq: 40,
      closesReverseHistory: true,
    });
  });

  it('completes from a locally durable batch that already contains the closure target', async () => {
    const { service, states, driver } = harness({
      reverseNextBeforeSeq: 100,
      reverseClosureOriginSeq: 40,
      historyBoundaryReached: false,
    });
    states.deriveReusableReverseBatch.mockResolvedValueOnce({
      sourceSeqs: [70, 40],
      batchOldestSeq: 40,
      reachedClosureTarget: true,
      canSkipMessageQuery: true,
    });

    await expect(service.run(31, 'peer.test', driver)).resolves.toMatchObject({
      nextBeforeSeq: 40,
      fetchedMessages: false,
      closesReverseHistory: true,
    });
    expect(driver.fetchMessages).not.toHaveBeenCalled();
  });
});
