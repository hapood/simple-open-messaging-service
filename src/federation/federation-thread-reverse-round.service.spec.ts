import { describe, expect, it, vi } from 'vitest';
import { FederationThreadReverseRoundService } from './federation-thread-reverse-round.service.js';
import type { FederationReverseWindow } from './federation-thread-sync-state.service.js';

const WINDOW: FederationReverseWindow = {
  authorizationEpoch: 7,
  gapId: 12n,
  beforeSeq: 100,
  throughSeq: 1,
  messageSeqOffset: 8,
};

function harness(window: FederationReverseWindow = WINDOW) {
  const states = {
    resolveReverseWindow: vi.fn().mockResolvedValue(window),
    require: vi.fn().mockResolvedValue({
      authorizationEpoch: window.authorizationEpoch,
      activeGapId: window.gapId,
    }),
  };
  const driver = {
    fetchMessages: vi.fn().mockResolvedValue({
      kind: 'page',
      scannedThrough: 50,
      hasMore: true,
    }),
    complete: vi.fn().mockResolvedValue(undefined),
    markUnavailable: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new FederationThreadReverseRoundService(states as never),
    states,
    driver,
  };
}

describe('FederationThreadReverseRoundService', () => {
  it('runs one quantum from the active inclusive gap', async () => {
    const { service, driver } = harness();

    await expect(service.run(31, 'peer.test', 12, driver)).resolves.toEqual({
      beforeSeq: 100,
      throughSeq: 1,
      batchOldestSeq: 50,
      nextBeforeSeq: 50,
      fetchedMessages: true,
      closesReverseHistory: false,
      continuation: null,
    });
    expect(driver.fetchMessages).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      before: 100,
      through: 1,
      take: 50,
    });
    expect(driver.complete).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      context: expect.objectContaining({ nextBeforeSeq: 50 }),
      closesGap: false,
    });
  });

  it('closes the gap when a committed batch scans through its inclusive start', async () => {
    const { service, driver } = harness();
    driver.fetchMessages.mockResolvedValueOnce({
      kind: 'page',
      scannedThrough: 1,
      hasMore: false,
    });

    await expect(
      service.run(31, 'peer.test', 12, driver),
    ).resolves.toMatchObject({
      nextBeforeSeq: 1,
      closesReverseHistory: true,
      continuation: null,
    });
    expect(driver.complete).toHaveBeenCalledWith({
      threadId: 31,
      peerDomain: 'peer.test',
      context: {
        authorizationEpoch: 7,
        gapId: 12n,
        gapBeforeSeq: 100,
        nextBeforeSeq: 1,
        throughSeq: 1,
        messageSeqOffset: 8,
      },
      closesGap: true,
    });
  });

  it('does no work when latest=1 produced no reverse gap', async () => {
    const { service, driver } = harness({
      authorizationEpoch: 7,
      gapId: null,
      beforeSeq: 0,
      throughSeq: null,
      messageSeqOffset: 0,
    });

    await expect(
      service.run(31, 'peer.test', 12, driver),
    ).resolves.toMatchObject({
      fetchedMessages: false,
      closesReverseHistory: true,
      continuation: null,
    });
    expect(driver.fetchMessages).not.toHaveBeenCalled();
  });

  it('marks an unavailable interval without publishing it as READY', async () => {
    const { service, driver } = harness();
    driver.fetchMessages.mockResolvedValueOnce({ kind: 'history-boundary' });

    await expect(
      service.run(31, 'peer.test', 12, driver),
    ).resolves.toMatchObject({
      closesReverseHistory: true,
      continuation: null,
    });
    expect(driver.complete).not.toHaveBeenCalled();
    expect(driver.markUnavailable).toHaveBeenCalledOnce();
  });
});
