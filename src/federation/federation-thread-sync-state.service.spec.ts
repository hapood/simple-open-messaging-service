import { describe, expect, it, vi } from 'vitest';
import {
  federationThreadHistoryGap,
  federationThreadSyncState,
  messageThread,
} from '../database/schema.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

function lockedThreadSelect(authorizationEpoch: number, curSeq = 0) {
  const limit = vi.fn().mockResolvedValue([{ authorizationEpoch, curSeq }]);
  const forUpdate = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ for: forUpdate });
  const from = vi.fn().mockReturnValue({ where });
  return vi.fn().mockReturnValue({ from });
}

function processedPositionTransaction(updated = true) {
  const returning = vi
    .fn()
    .mockResolvedValue(updated ? [{ threadId: 31 }] : []);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { tx: { update }, update, set };
}

function missingStateTransaction(
  authorizationEpoch: number,
  gapId: bigint = 12n,
  curSeq = 0,
) {
  const select = lockedThreadSelect(authorizationEpoch, curSeq);
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const gapReturning = vi.fn().mockResolvedValue([{ id: gapId }]);
  const gapValues = vi.fn().mockReturnValue({ returning: gapReturning });
  const stateValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn((table: unknown) => ({
    values: table === federationThreadHistoryGap ? gapValues : stateValues,
  }));
  return { tx: { select, execute, insert }, insert, gapValues, stateValues };
}

function epochTransaction(params: {
  state: {
    messageTargetSeq: number;
    messageProcessedThroughSeq: number;
    deletionTargetSeq?: number;
    deletionProcessedThroughSeq?: number;
    authorizationEpoch: number;
    activeGapId: bigint | null;
    historyBoundaryReached: boolean;
  };
  overlaps?: Array<{
    id: bigint;
    startSeq: number;
    endSeq: number;
    messageSeqOffset?: number;
  }>;
  latestGapId?: bigint | null;
  mergedGapId?: bigint;
  localCurSeq?: number;
}) {
  const threadSelect = lockedThreadSelect(
    params.state.authorizationEpoch + 1,
    params.localCurSeq ?? params.state.messageTargetSeq,
  );
  const latestLimit = vi
    .fn()
    .mockResolvedValue(
      params.latestGapId === null
        ? []
        : [{ id: params.latestGapId ?? params.state.activeGapId ?? 12n }],
    );
  const orderBy = vi.fn().mockReturnValue({ limit: latestLimit });
  const latestWhere = vi.fn().mockReturnValue({ orderBy });
  const latestFrom = vi.fn().mockReturnValue({ where: latestWhere });
  const select = vi.fn((shape?: unknown) =>
    shape && 'authorizationEpoch' in (shape as object)
      ? threadSelect(shape)
      : { from: latestFrom },
  );
  const execute = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          ...params.state,
          deletionTargetSeq: params.state.deletionTargetSeq ?? 0,
          deletionProcessedThroughSeq:
            params.state.deletionProcessedThroughSeq ?? 0,
          deletionRecoveryThroughSeq: null,
          deletionRecoveryMaxMessageSeq: null,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: (params.overlaps ?? []).map((gap) => ({
        ...gap,
        messageSeqOffset: gap.messageSeqOffset ?? 0,
      })),
    })
    .mockResolvedValue({ rows: [] });
  const mergedReturning = vi
    .fn()
    .mockResolvedValue([{ id: params.mergedGapId ?? 13n }]);
  const onConflictDoUpdate = vi
    .fn()
    .mockReturnValue({ returning: mergedReturning });
  const gapValues = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values: gapValues });
  const updateReturning = vi.fn().mockResolvedValue([{ threadId: 31 }]);
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });
  return {
    tx: { select, execute, insert, update },
    execute,
    gapValues,
    set,
  };
}

describe('FederationThreadSyncStateService processed positions', () => {
  it('advances message and deletion positions through the thread state row', async () => {
    const message = processedPositionTransaction();
    await FederationThreadSyncStateService.advanceMessageProcessedThroughInTx(
      message.tx as never,
      31,
      8,
      12,
    );
    expect(message.update).toHaveBeenCalledWith(federationThreadSyncState);

    const deletion = processedPositionTransaction();
    await FederationThreadSyncStateService.advanceDeletionProcessedThroughInTx(
      deletion.tx as never,
      31,
      5,
      7,
    );
    expect(deletion.update).toHaveBeenCalledWith(federationThreadSyncState);
    expect(deletion.set).toHaveBeenCalledWith(
      expect.objectContaining({
        deletionRecoveryThroughSeq: expect.anything(),
        deletionRecoveryMaxMessageSeq: expect.anything(),
      }),
    );
  });

  it('rejects a processed position beyond the frozen target', async () => {
    const { tx, update } = processedPositionTransaction();
    await expect(
      FederationThreadSyncStateService.advanceMessageProcessedThroughInTx(
        tx as never,
        31,
        13,
        12,
      ),
    ).rejects.toThrow('must not exceed its frozen target');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('FederationThreadSyncStateService initial history interval', () => {
  it.each([
    { latest: 0, processed: 0 },
    { latest: 1, processed: 0 },
  ])(
    'creates no reverse gap when latest=$latest',
    async ({ latest, processed }) => {
      const mock = missingStateTransaction(7);

      await expect(
        FederationThreadSyncStateService.reconcileThreadHeadInTx(
          mock.tx as never,
          {
            threadId: 31,
            messageTargetSeq: latest,
            deletionTargetSeq: 0,
            reverseEnabled: true,
          },
        ),
      ).resolves.toEqual({
        created: true,
        epochChanged: false,
        reverseRequired: false,
      });
      expect(mock.insert).toHaveBeenCalledTimes(1);
      expect(mock.stateValues).toHaveBeenCalledWith(
        expect.objectContaining({
          messageProcessedThroughSeq: processed,
          activeGapId: null,
          historyBoundaryReached: true,
        }),
      );
    },
  );

  it('puts only older messages in the reverse gap and leaves latest for forward', async () => {
    const mock = missingStateTransaction(7);

    await expect(
      FederationThreadSyncStateService.reconcileThreadHeadInTx(
        mock.tx as never,
        {
          threadId: 31,
          messageTargetSeq: 2,
          deletionTargetSeq: 0,
          reverseEnabled: true,
        },
      ),
    ).resolves.toEqual({
      created: true,
      epochChanged: false,
      reverseRequired: true,
    });
    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 31, startSeq: 1, endSeq: 1 }),
    );
    expect(mock.stateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTargetSeq: 2,
        messageProcessedThroughSeq: 1,
        activeGapId: 12n,
        historyBoundaryReached: false,
      }),
    );
  });

  it('places initial history after an existing local system-message tail', async () => {
    const mock = missingStateTransaction(7, 12n, 3);

    await FederationThreadSyncStateService.reconcileThreadHeadInTx(
      mock.tx as never,
      {
        threadId: 31,
        messageTargetSeq: 3,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      },
    );

    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({
        startSeq: 1,
        endSeq: 2,
        messageSeqOffset: 3,
      }),
    );
  });

  it('adopts the initial deletion head without scheduling historical tombstones', async () => {
    const mock = missingStateTransaction(7);

    await FederationThreadSyncStateService.reconcileThreadHeadInTx(
      mock.tx as never,
      {
        threadId: 31,
        messageTargetSeq: 20,
        deletionTargetSeq: 6,
        reverseEnabled: true,
      },
    );

    expect(mock.stateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        deletionTargetSeq: 6,
        deletionProcessedThroughSeq: 6,
      }),
    );
  });
});

describe('FederationThreadSyncStateService epoch interval reconciliation', () => {
  it('keeps an older gap separate when the new epoch uses another local mapping', async () => {
    const mock = epochTransaction({
      state: {
        messageTargetSeq: 100,
        messageProcessedThroughSeq: 99,
        deletionTargetSeq: 5,
        deletionProcessedThroughSeq: 3,
        authorizationEpoch: 7,
        activeGapId: 12n,
        historyBoundaryReached: false,
      },
      overlaps: [{ id: 12n, startSeq: 1, endSeq: 99 }],
    });

    await expect(
      FederationThreadSyncStateService.reconcileThreadHeadInTx(
        mock.tx as never,
        {
          threadId: 31,
          messageTargetSeq: 200,
          deletionTargetSeq: 20,
          reverseEnabled: true,
        },
      ),
    ).resolves.toEqual({
      created: false,
      epochChanged: true,
      reverseRequired: true,
    });

    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({
        startSeq: 100,
        endSeq: 199,
        messageSeqOffset: 1,
      }),
    );
    expect(mock.set).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTargetSeq: 200,
        messageProcessedThroughSeq: 199,
        deletionTargetSeq: 20,
        deletionRecoveryThroughSeq: 20,
        deletionRecoveryMaxMessageSeq: 99,
        activeGapId: 13n,
      }),
    );
  });

  it('keeps two gaps when committed forward messages separate them', async () => {
    const mock = epochTransaction({
      state: {
        messageTargetSeq: 150,
        messageProcessedThroughSeq: 150,
        authorizationEpoch: 7,
        activeGapId: 12n,
        historyBoundaryReached: false,
      },
      overlaps: [],
    });

    await FederationThreadSyncStateService.reconcileThreadHeadInTx(
      mock.tx as never,
      {
        threadId: 31,
        messageTargetSeq: 200,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      },
    );

    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({ startSeq: 151, endSeq: 199 }),
    );
    expect(mock.set).toHaveBeenCalledWith(
      expect.objectContaining({ activeGapId: 13n }),
    );
  });

  it('creates the next interval after a reverse-only completed epoch', async () => {
    const mock = epochTransaction({
      state: {
        messageTargetSeq: 100,
        messageProcessedThroughSeq: 100,
        authorizationEpoch: 7,
        activeGapId: null,
        historyBoundaryReached: true,
      },
      overlaps: [],
    });

    await FederationThreadSyncStateService.reconcileThreadHeadInTx(
      mock.tx as never,
      {
        threadId: 31,
        messageTargetSeq: 200,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      },
    );

    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({ startSeq: 101, endSeq: 199 }),
    );
  });

  it('does not create an empty gap when new latest equals committed plus one', async () => {
    const mock = epochTransaction({
      state: {
        messageTargetSeq: 150,
        messageProcessedThroughSeq: 150,
        authorizationEpoch: 7,
        activeGapId: 12n,
        historyBoundaryReached: false,
      },
      latestGapId: 12n,
    });

    await FederationThreadSyncStateService.reconcileThreadHeadInTx(
      mock.tx as never,
      {
        threadId: 31,
        messageTargetSeq: 151,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      },
    );

    expect(mock.gapValues).not.toHaveBeenCalled();
    expect(mock.set).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTargetSeq: 151,
        messageProcessedThroughSeq: 150,
        activeGapId: 12n,
      }),
    );
  });
});

describe('FederationThreadSyncStateService reverse window reconstruction', () => {
  it('uses only the active gap coordinates', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      authorizationEpoch: 8,
      activeGapId: 12n,
      historyBoundaryReached: false,
    });
    const execute = vi.fn().mockResolvedValue({
      rows: [{ startSeq: 1, endSeq: 99, messageSeqOffset: 8 }],
    });
    const service = new FederationThreadSyncStateService({
      db: {
        query: { federationThreadSyncState: { findFirst } },
        execute,
      },
    } as never);

    await expect(
      service.resolveReverseWindow(31),
    ).resolves.toEqual({
      authorizationEpoch: 8,
      gapId: 12n,
      beforeSeq: 100,
      throughSeq: 1,
      messageSeqOffset: 8,
    });
  });

  it('returns a terminal window when no recoverable interval remains', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      authorizationEpoch: 8,
      activeGapId: null,
      historyBoundaryReached: true,
    });
    const execute = vi.fn();
    const service = new FederationThreadSyncStateService({
      db: {
        query: { federationThreadSyncState: { findFirst } },
        execute,
      },
    } as never);

    await expect(
      service.resolveReverseWindow(31),
    ).resolves.toEqual({
      authorizationEpoch: 8,
      gapId: null,
      beforeSeq: 0,
      throughSeq: null,
      messageSeqOffset: 0,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('FederationThreadSyncStateService reverse closure commit', () => {
  it('shrinks a committed reverse batch without waiting for message materialization', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7 }] })
      .mockResolvedValueOnce({ rows: [{ activeGapId: '12' }] })
      .mockResolvedValueOnce({ rows: [{ startSeq: 1, endSeq: 99 }] });
    const returning = vi.fn().mockResolvedValue([{ id: 12n }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const applyDependencies = vi.fn().mockResolvedValue(undefined);

    await FederationThreadSyncStateService.commitReverseBatchInTx(
      { execute, update } as never,
      {
        threadId: 31,
        authorizationEpoch: 7,
        gapId: 12n,
        beforeSeq: 100,
        scannedThrough: 50,
        throughSeq: 1,
        closesGap: false,
        applyDependencies,
      },
    );

    expect(applyDependencies).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ endSeq: 49 }));
  });

  it('moves the active reference before deleting the completed gap', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7 }] })
      .mockResolvedValueOnce({ rows: [{ activeGapId: '12' }] })
      .mockResolvedValueOnce({ rows: [{ startSeq: 1, endSeq: 99 }] });
    const nextLimit = vi.fn().mockResolvedValue([{ id: 11n }]);
    const orderBy = vi.fn().mockReturnValue({ limit: nextLimit });
    const selectWhere = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where: selectWhere });
    const select = vi.fn().mockReturnValue({ from });
    const returning = vi.fn().mockResolvedValue([{ threadId: 31 }]);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set });
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockReturnValue({ where: deleteWhere });

    await FederationThreadSyncStateService.commitReverseBatchInTx(
      { execute, select, update, delete: remove } as never,
      {
        threadId: 31,
        authorizationEpoch: 7,
        gapId: 12n,
        beforeSeq: 100,
        scannedThrough: 1,
        throughSeq: 1,
        closesGap: true,
      },
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        activeGapId: 11n,
        historyBoundaryReached: false,
      }),
    );
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0]!,
    );
  });
});

it('locks MessageThread when reconciling a head', async () => {
  const mock = missingStateTransaction(7);
  await FederationThreadSyncStateService.reconcileThreadHeadInTx(
    mock.tx as never,
    {
      threadId: 31,
      messageTargetSeq: 0,
      deletionTargetSeq: 0,
      reverseEnabled: true,
    },
  );
  expect(mock.tx.select).toHaveBeenCalledWith({
    authorizationEpoch: messageThread.authorizationEpoch,
    curSeq: messageThread.curSeq,
  });
});
