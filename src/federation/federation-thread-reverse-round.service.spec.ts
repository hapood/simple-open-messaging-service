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

function harness(window: FederationReverseWindow | null = WINDOW) {
  const states = {
    prepareMessageRound: vi.fn().mockResolvedValue(undefined),
    resolveReverseWindow: vi.fn().mockResolvedValue(window),
    require: vi.fn().mockResolvedValue({
      authorizationEpoch: window?.authorizationEpoch ?? 0,
      activeGapId: window?.gapId ?? null,
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

    await expect(
      service.run(31, 12, driver, new AbortController().signal),
    ).resolves.toEqual({
      beforeSeq: 100,
      throughSeq: 1,
      batchOldestSeq: 50,
      nextBeforeSeq: 50,
      fetchedMessages: true,
      committed: true,
      closesGap: false,
    });
    expect(driver.fetchMessages).toHaveBeenCalledWith({
      threadId: 31,
      before: 100,
      through: 1,
      take: 50,
    });
    expect(driver.complete).toHaveBeenCalledWith({
      threadId: 31,
      context: expect.objectContaining({ nextBeforeSeq: 50 }),
      closesGap: false,
    });
  });

  it('prepares the message round only when dirty is true', async () => {
    const { service, states, driver } = harness();

    await service.run(31, 12, driver, new AbortController().signal, 50, false);
    expect(states.prepareMessageRound).not.toHaveBeenCalled();
    expect(states.resolveReverseWindow).toHaveBeenCalledWith(31, 12);

    await service.run(31, 12, driver, new AbortController().signal, 50, true);
    expect(states.prepareMessageRound).toHaveBeenCalledWith(31, 12);
  });

  it('closes the gap when a committed batch scans through its inclusive start', async () => {
    const { service, driver } = harness();
    driver.fetchMessages.mockResolvedValueOnce({
      kind: 'page',
      scannedThrough: 1,
      hasMore: false,
    });

    await expect(
      service.run(31, 12, driver, new AbortController().signal),
    ).resolves.toMatchObject({
      nextBeforeSeq: 1,
      committed: true,
      closesGap: true,
    });
    expect(driver.complete).toHaveBeenCalledWith({
      threadId: 31,
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
    const { service, driver } = harness(null);

    await expect(
      service.run(31, 12, driver, new AbortController().signal),
    ).resolves.toMatchObject({
      fetchedMessages: false,
      committed: false,
      closesGap: false,
    });
    expect(driver.fetchMessages).not.toHaveBeenCalled();
  });

  it('marks an unavailable interval without publishing it as READY', async () => {
    const { service, driver } = harness();
    driver.fetchMessages.mockResolvedValueOnce({ kind: 'history-boundary' });

    await expect(
      service.run(31, 12, driver, new AbortController().signal),
    ).resolves.toMatchObject({
      fetchedMessages: true,
      committed: false,
      closesGap: false,
    });
    expect(driver.complete).not.toHaveBeenCalled();
    expect(driver.markUnavailable).toHaveBeenCalledOnce();
  });
});
