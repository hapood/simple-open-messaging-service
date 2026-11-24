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

  it('reserves even a singleton newest message', async () => {
    const mock = missingStateTransaction(7);
    await FederationThreadSyncStateService.reconcileRelationshipAuthorizationInTx(
      mock.tx as never,
      {
        threadId: 31,
        namespaceId: 3,
        messageTargetSeq: 1,
        deletionTargetSeq: 0,
        reverseEnabled: true,
      },
    );
    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({ startSeq: 1, endSeq: 1 }),
    );
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
    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 31,
        namespaceId: 3,
        startSeq: 1,
        endSeq: 2,
      }),
    );
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

    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({
        startSeq: 1,
        endSeq: 3,
        messageSeqOffset: 3,
      }),
    );
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

    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({
        startSeq: 100,
        endSeq: 200,
        messageSeqOffset: 1,
      }),
    );
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

    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({
        startSeq: 151,
        endSeq: 200,
        messageSeqOffset: 1,
      }),
    );
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

    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({
        startSeq: 101,
        endSeq: 200,
        messageSeqOffset: 0,
      }),
    );
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

    expect(mock.gapValues).toHaveBeenCalledWith(
      expect.objectContaining({ startSeq: 151, endSeq: 151 }),
    );
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
  it('rejects changed upper edges before writing messages', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7 }] })
      .mockResolvedValueOnce({ rows: [{ startSeq: 1, endSeq: 110 }] });
    const writeMessages = vi.fn();
    await expect(
      FederationThreadSyncStateService.commitReverseBatchInTx(
        { execute } as never,
        {
          threadId: 31,
          namespaceId: 3,
          authorizationEpoch: 7,
          gapId: 12n,
          beforeSeq: 100,
          throughSeq: 1,
          scannedThrough: 50,
          closesGap: false,
          writeMessages,
        },
      ),
    ).rejects.toThrow('requested reverse gap boundary changed');
    expect(writeMessages).not.toHaveBeenCalled();
  });

  it('shrinks a committed reverse batch without waiting for message materialization', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7 }] })
      .mockResolvedValueOnce({ rows: [{ startSeq: 1, endSeq: 99 }] });
    const returning = vi.fn().mockResolvedValue([{ id: 12n }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const writeMessages = vi.fn().mockResolvedValue(undefined);

    await expect(
      FederationThreadSyncStateService.commitReverseBatchInTx(
        { execute, update } as never,
        {
          threadId: 31,
          namespaceId: 3,
          authorizationEpoch: 7,
          gapId: 12n,
          beforeSeq: 100,
          scannedThrough: 50,
          throughSeq: 1,
          closesGap: false,
          writeMessages,
        },
      ),
    ).resolves.toBe(50);

    expect(writeMessages).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ endSeq: 49 }));
  });

  it('deletes the completed gap when scannedThrough reaches startSeq', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 7 }] })
      .mockResolvedValueOnce({ rows: [{ startSeq: 1, endSeq: 99 }] });
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockReturnValue({ where: deleteWhere });
    const writeMessages = vi.fn().mockResolvedValue(undefined);

    await expect(
      FederationThreadSyncStateService.commitReverseBatchInTx(
        { execute, delete: remove } as never,
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
