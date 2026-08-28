import { describe, expect, it, vi } from 'vitest';
import { federationThreadSyncState } from '../database/schema.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

function transaction(updated = true) {
  const returning = vi
    .fn()
    .mockResolvedValue(updated ? [{ threadId: 31 }] : []);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { tx: { update }, update, set };
}

function insertTransaction(closureOriginSeq: number | null = null) {
  const where = vi.fn().mockResolvedValue([{ originSeq: closureOriginSeq }]);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const returning = vi.fn().mockResolvedValue([{ threadId: 31 }]);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });
  return { tx: { select, insert }, values };
}

describe('FederationThreadSyncStateService processed positions', () => {
  it('persists an exclusive reverse cursor after the advertised tail', async () => {
    const { tx, values } = insertTransaction(60);

    await FederationThreadSyncStateService.mergeMessageTargetInTx(
      tx as never,
      31,
      'peer.test',
      80,
      true,
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 31,
        messageTargetSeq: 80,
        reverseNextBeforeSeq: 81,
        reverseClosureOriginSeq: 60,
      }),
    );
  });

  it('advances message and deletion positions through the thread state row', async () => {
    const message = transaction();
    await FederationThreadSyncStateService.advanceMessageProcessedThroughInTx(
      message.tx as never,
      31,
      'peer.test',
      8,
      12,
    );
    expect(message.update).toHaveBeenCalledWith(federationThreadSyncState);
    expect(message.set).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: expect.any(Date) }),
    );

    const deletion = transaction();
    await FederationThreadSyncStateService.advanceDeletionProcessedThroughInTx(
      deletion.tx as never,
      31,
      'peer.test',
      5,
      7,
    );
    expect(deletion.update).toHaveBeenCalledWith(federationThreadSyncState);
    expect(deletion.set).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: expect.any(Date) }),
    );
  });

  it('rejects a page boundary beyond the frozen round target', async () => {
    const { tx, update } = transaction();
    await expect(
      FederationThreadSyncStateService.advanceMessageProcessedThroughInTx(
        tx as never,
        31,
        'peer.test',
        13,
        12,
      ),
    ).rejects.toThrow('must not exceed its frozen target');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an advance when the thread state no longer provides the target', async () => {
    const { tx } = transaction(false);
    await expect(
      FederationThreadSyncStateService.advanceDeletionProcessedThroughInTx(
        tx as never,
        31,
        'peer.test',
        5,
        7,
      ),
    ).rejects.toThrow('has no deletion target for this round');
  });

  it('commits reverse progress only from the frozen before cursor', async () => {
    const reverse = transaction();

    await FederationThreadSyncStateService.commitReverseProgressInTx(
      reverse.tx as never,
      {
        threadId: 31,
        peerDomain: 'peer.test',
        frozenBeforeSeq: 80,
        frozenClosureOriginSeq: null,
        nextBeforeSeq: 30,
        historyBoundaryReached: false,
      },
    );

    expect(reverse.update).toHaveBeenCalledWith(federationThreadSyncState);
    expect(reverse.set).toHaveBeenCalledWith(
      expect.objectContaining({
        reverseNextBeforeSeq: 30,
        reverseClosureOriginSeq: null,
        historyBoundaryReached: false,
        updatedAt: expect.any(Date),
      }),
    );
  });

  it('rejects reverse movement beyond the frozen before cursor', async () => {
    const { tx, update } = transaction();

    await expect(
      FederationThreadSyncStateService.commitReverseProgressInTx(tx as never, {
        threadId: 31,
        peerDomain: 'peer.test',
        frozenBeforeSeq: 80,
        frozenClosureOriginSeq: null,
        nextBeforeSeq: 81,
        historyBoundaryReached: false,
      }),
    ).rejects.toThrow('must not exceed its frozen before cursor');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects stale reverse completion', async () => {
    const { tx } = transaction(false);

    await expect(
      FederationThreadSyncStateService.commitReverseProgressInTx(tx as never, {
        threadId: 31,
        peerDomain: 'peer.test',
        frozenBeforeSeq: 80,
        frozenClosureOriginSeq: null,
        nextBeforeSeq: 30,
        historyBoundaryReached: false,
      }),
    ).rejects.toThrow('reverse position changed during the round');
  });
});

describe('FederationThreadSyncStateService reverse batch reuse', () => {
  it('uses the oldest of take distinct durable source coordinates', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: Array.from({ length: 50 }, (_, index) => ({
        sourceSeq: 100 - index,
      })),
    });
    const service = new FederationThreadSyncStateService({
      db: { execute },
    } as never);

    await expect(
      service.deriveReusableReverseBatch({
        threadId: 31,
        peerDomain: 'peer.test',
        beforeSeq: 101,
        closureOriginSeq: null,
        take: 50,
      }),
    ).resolves.toMatchObject({
      batchOldestSeq: 51,
      reachedClosureTarget: false,
      canSkipMessageQuery: true,
    });
  });

  it('requires a remote message query when fewer than take coordinates exist', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: Array.from({ length: 49 }, (_, index) => ({
        sourceSeq: 100 - index,
      })),
    });
    const service = new FederationThreadSyncStateService({
      db: { execute },
    } as never);

    await expect(
      service.deriveReusableReverseBatch({
        threadId: 31,
        peerDomain: 'peer.test',
        beforeSeq: 101,
        closureOriginSeq: null,
        take: 50,
      }),
    ).resolves.toMatchObject({
      batchOldestSeq: null,
      reachedClosureTarget: false,
      canSkipMessageQuery: false,
    });
  });

  it('closes a partial reusable batch when it contains the persisted target', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ sourceSeq: 70 }, { sourceSeq: 60 }],
    });
    const service = new FederationThreadSyncStateService({
      db: { execute },
    } as never);

    await expect(
      service.deriveReusableReverseBatch({
        threadId: 31,
        peerDomain: 'peer.test',
        beforeSeq: 80,
        closureOriginSeq: 60,
        take: 50,
      }),
    ).resolves.toEqual({
      sourceSeqs: [70, 60],
      batchOldestSeq: 60,
      reachedClosureTarget: true,
      canSkipMessageQuery: true,
    });
  });

  it('clears the closure target when reverse history completes', async () => {
    const reverse = transaction();

    await FederationThreadSyncStateService.commitReverseProgressInTx(
      reverse.tx as never,
      {
        threadId: 31,
        peerDomain: 'peer.test',
        frozenBeforeSeq: 80,
        frozenClosureOriginSeq: 60,
        nextBeforeSeq: 60,
        historyBoundaryReached: true,
      },
    );

    expect(reverse.set).toHaveBeenCalledWith(
      expect.objectContaining({
        reverseNextBeforeSeq: 60,
        reverseClosureOriginSeq: null,
        historyBoundaryReached: true,
      }),
    );
  });
});
