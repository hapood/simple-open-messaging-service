import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../common/locks/thread-content-lock.js', () => ({
  lockThreadContentInTx: vi.fn().mockResolvedValue(true),
  requireThreadContentLockInTx: vi.fn(
    async (tx, threadId, held) => held ?? { tx, threadId },
  ),
}));
import {
  federationThreadHistoryGap,
  federationThreadSyncState,
  messageThread,
} from '../database/schema.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

function lockedThreadSelect(authorizationEpoch: number, curSeq = 0) {
  const limit = vi.fn().mockResolvedValue([{ authorizationEpoch, curSeq }]);
  const forUpdate = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ for: forUpdate, limit });
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

function missingStateTransaction(authorizationEpoch: number, curSeq = 0) {
  const select = lockedThreadSelect(authorizationEpoch, curSeq);
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  const gapValues = vi.fn().mockResolvedValue(undefined);
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
  };
  overlaps?: Array<{
    id: bigint;
    startSeq: number;
    endSeq: number;
    messageSeqOffset?: number;
  }>;
  anchorOriginSeq?: number;
  maxGapEndSeq?: number;
  hasRecoverableGap?: boolean;
  mergedGapId?: bigint;
  localCurSeq?: number;
}) {
  const threadSelect = lockedThreadSelect(
    params.state.authorizationEpoch + 1,
    params.localCurSeq ?? params.state.messageTargetSeq,
  );
  const latestLimit = vi
    .fn()
    .mockResolvedValue(params.hasRecoverableGap ? [{ id: 12n }] : []);
  const latestWhere = vi.fn().mockReturnValue({ limit: latestLimit });
  const latestFrom = vi.fn().mockReturnValue({ where: latestWhere });
  const select = vi.fn((shape?: unknown) =>
    shape && 'authorizationEpoch' in (shape as object)
      ? threadSelect(shape)
      : { from: latestFrom },
  );
  const execute = vi.fn().mockResolvedValueOnce({
    rows: [
      {
        ...params.state,
        deletionTargetSeq: params.state.deletionTargetSeq ?? 0,
        deletionProcessedThroughSeq:
          params.state.deletionProcessedThroughSeq ?? 0,
      },
    ],
  });
  execute.mockResolvedValueOnce({
    rows: [
      {
        maxOriginSeq: params.anchorOriginSeq ?? 0,
      },
    ],
  });
  execute.mockResolvedValueOnce({
    rows: [
      {
        maxEndSeq:
          params.maxGapEndSeq ??
          Math.max(0, ...(params.overlaps ?? []).map((gap) => gap.endSeq)),
      },
    ],
  });
  execute.mockResolvedValueOnce({
    rows: (params.overlaps ?? []).map((gap) => ({
      ...gap,
      messageSeqOffset: gap.messageSeqOffset ?? 0,
    })),
  });
  execute.mockResolvedValue({ rows: [] });
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
      3,
    );
    expect(message.update).toHaveBeenCalledWith(federationThreadSyncState);

    const deletion = processedPositionTransaction();
    await FederationThreadSyncStateService.advanceDeletionProcessedThroughInTx(
      deletion.tx as never,
      31,
      5,
      7,
      3,
    );
    expect(deletion.update).toHaveBeenCalledWith(federationThreadSyncState);
    expect(deletion.set).toHaveBeenCalledWith(
      expect.objectContaining({
        deletionProcessedThroughSeq: expect.anything(),
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
        3,
      ),
    ).rejects.toThrow('must not exceed its frozen target');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('FederationThreadSyncStateService initial history interval', () => {
  it('never reserves a reverse gap for a local-authority submission stream', async () => {
    const mock = missingStateTransaction(7);
    await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
      mock.tx as never,
      {
        threadId: 31,
        namespaceId: 3,
        messageTargetSeq: 100,
        deletionTargetSeq: 10,
        reverseEnabled: false,
      },
    );
    expect(mock.gapValues).not.toHaveBeenCalled();
    expect(mock.stateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        messageProcessedThroughSeq: 0,
        deletionProcessedThroughSeq: 0,
      }),
    );
  });

  it('records a singleton target without reserving a gap', async () => {
    const mock = missingStateTransaction(7);
    await expect(
      FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
        mock.tx as never,
        {
          threadId: 31,
          namespaceId: 3,
          messageTargetSeq: 1,
          deletionTargetSeq: 0,
          reverseEnabled: true,
        },
      ),
    ).resolves.toMatchObject({ created: true, reverseRequired: true });
    expect(mock.gapValues).not.toHaveBeenCalled();
  });

  it('creates no reverse gap when latest=0', async () => {
    const mock = missingStateTransaction(7);

    await expect(
      FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
        mock.tx as never,
        {
          threadId: 31,
          namespaceId: 3,
          messageTargetSeq: 0,
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
        messageTargetSeq: 0,
        messageProcessedThroughSeq: 0,
      }),
    );
  });

  it('puts the newest advertised message inside the reverse reservation without setting anchor L', async () => {
    const mock = missingStateTransaction(7);

    await expect(
      FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
        mock.tx as never,
        {
          threadId: 31,
          namespaceId: 3,
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
    expect(mock.gapValues).not.toHaveBeenCalled();
    expect(mock.stateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTargetSeq: 2,
        messageProcessedThroughSeq: 0,
      }),
    );
  });

  it('places initial history after an existing local system-message tail', async () => {
    const mock = missingStateTransaction(7, 3);

    await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
      mock.tx as never,
      {
        threadId: 31,
        namespaceId: 3,
        messageTargetSeq: 3,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      },
    );

    expect(mock.gapValues).not.toHaveBeenCalled();
  });

  it('starts at the last applied deletion rather than adopting an advertisement', async () => {
    const mock = missingStateTransaction(7);

    await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
      mock.tx as never,
      {
        threadId: 31,
        namespaceId: 3,
        messageTargetSeq: 20,
        deletionTargetSeq: 6,
        reverseEnabled: true,
      },
    );

    expect(mock.stateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        deletionTargetSeq: 6,
        deletionProcessedThroughSeq: 0,
      }),
    );
  });
});

describe('FederationThreadSyncStateService epoch interval reconciliation', () => {
  it('keeps an older gap separate when the new epoch uses another local mapping', async () => {
    const mock = epochTransaction({
      state: {
        messageTargetSeq: 100,
        messageProcessedThroughSeq: 0,
        deletionTargetSeq: 5,
        deletionProcessedThroughSeq: 3,
        authorizationEpoch: 7,
      },
      overlaps: [{ id: 12n, startSeq: 1, endSeq: 99 }],
    });

    await expect(
      FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
        mock.tx as never,
        {
          threadId: 31,
          namespaceId: 3,
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

    expect(mock.gapValues).not.toHaveBeenCalled();
    expect(mock.set).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTargetSeq: 200,
        deletionTargetSeq: 20,
      }),
    );
  });

  it('keeps two gaps when committed local messages separate them', async () => {
    const mock = epochTransaction({
      state: {
        messageTargetSeq: 150,
        messageProcessedThroughSeq: 150,
        authorizationEpoch: 7,
      },
      anchorOriginSeq: 150,
      localCurSeq: 151,
      overlaps: [],
    });

    await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
      mock.tx as never,
      {
        threadId: 31,
        namespaceId: 3,
        messageTargetSeq: 200,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      },
    );

    expect(mock.gapValues).not.toHaveBeenCalled();
  });

  it('creates the next interval after a reverse-only completed epoch', async () => {
    const mock = epochTransaction({
      state: {
        messageTargetSeq: 100,
        messageProcessedThroughSeq: 100,
        authorizationEpoch: 7,
      },
      anchorOriginSeq: 100,
      localCurSeq: 100,
      overlaps: [],
    });

    await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
      mock.tx as never,
      {
        threadId: 31,
        namespaceId: 3,
        messageTargetSeq: 200,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      },
    );

    expect(mock.gapValues).not.toHaveBeenCalled();
  });

  it('reserves a singleton tail when new latest equals covered plus one', async () => {
    const mock = epochTransaction({
      state: {
        messageTargetSeq: 150,
        messageProcessedThroughSeq: 150,
        authorizationEpoch: 7,
      },
      anchorOriginSeq: 150,
      localCurSeq: 150,
    });

    await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
      mock.tx as never,
      {
        threadId: 31,
        namespaceId: 3,
        messageTargetSeq: 151,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      },
    );

    expect(mock.gapValues).not.toHaveBeenCalled();
    expect(mock.set).toHaveBeenCalledWith(
      expect.objectContaining({
        messageTargetSeq: 151,
      }),
    );
  });
});

describe('FederationThreadSyncStateService reverse window reconstruction', () => {
  it('selects the newest recoverable gap directly', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          authorizationEpoch: 8,
          gapId: '12',
          startSeq: 1,
          endSeq: 99,
          messageSeqOffset: 8,
        },
      ],
    });
    const service = new FederationThreadSyncStateService({
      db: { execute },
    } as never);

    await expect(service.resolveReverseWindow(31, 3)).resolves.toEqual({
      authorizationEpoch: 8,
      gapId: 12n,
      beforeSeq: 100,
      throughSeq: 1,
      messageSeqOffset: 8,
    });
  });

  it('returns null when no recoverable interval remains', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const service = new FederationThreadSyncStateService({
      db: { execute },
    } as never);

    await expect(service.resolveReverseWindow(31, 3)).resolves.toBeNull();
  });
});

describe('FederationThreadSyncStateService reverse closure commit', () => {
  it('matches an existing gap offset and shrinks the gap without re-reserving', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7, curSeq: 200 }] })
      .mockResolvedValueOnce({ rows: [{ messageProcessedThroughSeq: 0 }] })
      .mockResolvedValueOnce({ rows: [{ endSeq: 0 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '12',
            startSeq: 1,
            endSeq: 99,
            messageSeqOffset: 10,
            recoverable: true,
          },
        ],
      });
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const observedOffsets: Array<number | null> = [];
    const writeMessages = vi.fn(async (_lock, resolveOffset) => {
      observedOffsets.push(await resolveOffset(80));
      observedOffsets.push(await resolveOffset(50));
    });

    await expect(
      FederationThreadSyncStateService.commitReverseBatchInTx(
        { execute, update } as never,
        {
          threadId: 31,
          namespaceId: 3,
          authorizationEpoch: 7,
          gapId: null,
          beforeSeq: 100,
          scannedThrough: 50,
          throughSeq: 1,
          closesGap: false,
          writeMessages,
        },
      ),
    ).resolves.toBe(50);

    expect(observedOffsets).toEqual([10, 10]);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ endSeq: 49 }));
  });

  it('deletes the completed gap when scannedThrough reaches startSeq', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7, curSeq: 200 }] })
      .mockResolvedValueOnce({ rows: [{ messageProcessedThroughSeq: 0 }] })
      .mockResolvedValueOnce({ rows: [{ endSeq: 0 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '12',
            startSeq: 1,
            endSeq: 99,
            messageSeqOffset: 10,
            recoverable: true,
          },
        ],
      });
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockReturnValue({ where: deleteWhere });
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    const writeMessages = vi.fn().mockResolvedValue(undefined);

    await expect(
      FederationThreadSyncStateService.commitReverseBatchInTx(
        { execute, update, delete: remove } as never,
        {
          threadId: 31,
          namespaceId: 3,
          authorizationEpoch: 7,
          gapId: 12n,
          beforeSeq: 100,
          scannedThrough: 1,
          throughSeq: 1,
          closesGap: true,
          writeMessages,
        },
      ),
    ).resolves.toBe(1);

    expect(writeMessages).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(federationThreadHistoryGap);
  });

  it('skips messages with no matching gap when already processed or a gap exists to the right', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7, curSeq: 200 }] })
      .mockResolvedValueOnce({ rows: [{ messageProcessedThroughSeq: 100 }] })
      .mockResolvedValueOnce({ rows: [{ endSeq: 0 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '12',
            startSeq: 1,
            endSeq: 79,
            messageSeqOffset: 10,
            recoverable: true,
          },
          {
            id: '13',
            startSeq: 101,
            endSeq: 129,
            messageSeqOffset: 50,
            recoverable: true,
          },
        ],
      });
    const remove = vi
      .fn()
      .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    const observed: Array<number | null> = [];
    const writeMessages = vi.fn(async (_lock, resolveOffset) => {
      observed.push(await resolveOffset(110));
      observed.push(await resolveOffset(90));
      observed.push(await resolveOffset(70));
    });

    await FederationThreadSyncStateService.commitReverseBatchInTx(
      { execute, update, delete: remove } as never,
      {
        threadId: 31,
        namespaceId: 3,
        authorizationEpoch: 7,
        gapId: null,
        beforeSeq: 130,
        scannedThrough: 70,
        throughSeq: 1,
        closesGap: false,
        writeMessages,
      },
    );

    expect(observed).toEqual([50, null, 10]);
  });

  it('reserves a new tail gap once in memory, reuses its offset, and persists the remaining lower hole', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7, curSeq: 200 }] })
      .mockResolvedValueOnce({ rows: [{ messageProcessedThroughSeq: 100 }] })
      .mockResolvedValueOnce({ rows: [{ endSeq: 100 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // reserveReverseSequenceRangeInTx UPDATE MessageThread
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    const observed: Array<number | null> = [];
    const writeMessages = vi.fn(async (_lock, resolveOffset) => {
      observed.push(await resolveOffset(150));
      observed.push(await resolveOffset(140));
    });

    await FederationThreadSyncStateService.commitReverseBatchInTx(
      { execute, insert, update } as never,
      {
        threadId: 31,
        namespaceId: 3,
        authorizationEpoch: 7,
        gapId: null,
        beforeSeq: 151,
        scannedThrough: 130,
        throughSeq: 101,
        closesGap: false,
        writeMessages,
      },
    );

    // firstOriginSeq = 101, curSeq = 200 => offset = 100
    expect(observed).toEqual([100, 100]);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        startSeq: 101,
        endSeq: 129,
        messageSeqOffset: 100,
        recoverable: true,
      }),
    );
  });

  it('fails the batch when a message falls in an unrecoverable gap', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7, curSeq: 200 }] })
      .mockResolvedValueOnce({ rows: [{ messageProcessedThroughSeq: 0 }] })
      .mockResolvedValueOnce({ rows: [{ endSeq: 0 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '12',
            startSeq: 90,
            endSeq: 120,
            messageSeqOffset: 4,
            recoverable: false,
          },
        ],
      });
    const writeMessages = vi.fn(async (_lock, resolveOffset) => {
      await resolveOffset(110);
    });

    await expect(
      FederationThreadSyncStateService.commitReverseBatchInTx(
        { execute } as never,
        {
          threadId: 31,
          namespaceId: 3,
          authorizationEpoch: 7,
          gapId: null,
          beforeSeq: 151,
          scannedThrough: 90,
          throughSeq: 90,
          closesGap: false,
          writeMessages,
        },
      ),
    ).rejects.toThrow('unrecoverable gap');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('advances messageProcessedThroughSeq when marking a synthetic tail unavailable (gapId === null)', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7 }] })
      .mockResolvedValueOnce({ rows: [{ left: 0, right: 40 }] });
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });

    const intervals =
      await FederationThreadSyncStateService.markReverseGapUnavailableInTx(
        { execute, update } as never,
        {
          threadId: 31,
          namespaceId: 3,
          authorizationEpoch: 7,
          gapId: null,
          beforeSeq: 101,
        },
      );

    expect(intervals).toEqual([{ left: 0, right: 40 }]);
    expect(update).toHaveBeenCalledWith(federationThreadSyncState);
  });
});

it('locks MessageThread when reconciling a head', async () => {
  const mock = missingStateTransaction(7);
  await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
    mock.tx as never,
    {
      threadId: 31,
      namespaceId: 3,
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
