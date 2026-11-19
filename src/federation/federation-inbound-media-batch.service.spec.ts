import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business.exception.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';
import * as tables from '../database/schema.js';

const inboundBatch = {
  id: 11n,
  batchId: 'batch-a',
  direction: 'INBOUND',
  messageId: 23n,
  threadId: null,
  creatorAccount: null,
  contentType: null,
  content: null,
  clientMessageId: null,
  originDomain: 'origin.example',
  publisherNamespaceId: 3,
  expectedAuthorizationEpoch: 4,
};

function serviceWith(overrides?: {
  pendingMedia?: unknown;
  message?: unknown;
  progress?: unknown;
  progressRows?: unknown[];
}) {
  const returning = vi.fn().mockResolvedValue([{ id: 7n }]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  const deleteWhere = vi.fn().mockResolvedValue([]);
  const remove = vi.fn().mockReturnValue({ where: deleteWhere });
  const selectWhere = vi.fn().mockResolvedValue([
    {
      totalFiles: overrides?.progressRows?.length ?? 0,
      completedFiles:
        overrides?.progressRows?.filter(
          (row) => (row as { status?: string }).status === 'COMPLETED',
        ).length ?? 0,
    },
  ]);
  const from = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from });
  const database = {
    db: {
      query: {
        pendingMedia: {
          findFirst: vi.fn().mockResolvedValue(overrides?.pendingMedia),
        },
        message: { findFirst: vi.fn().mockResolvedValue(overrides?.message) },
        fileSyncProgress: {
          findFirst: vi.fn().mockResolvedValue(
            overrides?.progress
              ? {
                  messageId: inboundBatch.messageId,
                  ...(overrides.progress as object),
                }
              : undefined,
          ),
          findMany: vi.fn().mockResolvedValue(overrides?.progressRows ?? []),
        },
      },
      select,
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      update,
      delete: remove,
      transaction: vi.fn(),
    },
  };
  database.db.transaction.mockImplementation(async (work) => work(database.db));
  const fileSync = {
    runBatch: vi.fn().mockResolvedValue(undefined),
    stopBatch: vi.fn(
      async (_batchId: string, persistStop?: () => Promise<void>) => {
        await persistStop?.();
      },
    ),
  };
  const promoter = { promote: vi.fn().mockResolvedValue(null) };
  const mediaRanges = { fetch: vi.fn() };
  const sse = {
    onMediaMessageDownloadProgress: vi.fn(),
    hasMediaMessageProgressSubscriber: vi.fn().mockReturnValue(true),
    completeMediaMessageDownloadProgress: vi.fn(),
    completeMediaFileDownloadProgress: vi.fn(),
  };
  const service = new FederationInboundMediaBatchService(
    database as never,
    fileSync as never,
    promoter as never,
    mediaRanges as never,
    sse as never,
  );
  return {
    service,
    database,
    fileSync,
    promoter,
    mediaRanges,
    sse,
    set,
    returning,
  };
}

describe('FederationInboundMediaBatchService', () => {
  it('publishes batch progress through task ownership after coordination is removed', async () => {
    const s = serviceWith({
      progress: { messageId: 23n },
      message: { threadId: 8, seq: 13 },
      progressRows: [{ status: 'COMPLETED' }, { status: 'PENDING' }],
    });
    s.fileSync.runBatch.mockImplementation(
      async (_id, _fetch, _promote, _fail, start) => {
        await start('batch-a');
      },
    );
    await s.service.runFileSyncBatch('batch-a', vi.fn());
    expect(s.database.db.query.pendingMedia.findFirst).not.toHaveBeenCalled();
    expect(s.sse.onMediaMessageDownloadProgress).toHaveBeenCalledWith({
      threadId: 8,
      seq: 13,
      status: 'downloading',
      completedFiles: 1,
      totalFiles: 2,
      activeFile: null,
    });
  });

  it('publishes the runtime downloading phase without mirroring it into a batch row', async () => {
    const s = serviceWith({
      pendingMedia: { ...inboundBatch, status: 'pending' },
      message: { threadId: 8, seq: 13 },
      progressRows: [{ status: 'PENDING' }],
    });
    s.fileSync.runBatch.mockImplementation(
      async (_id, _fetch, _promote, _fail, start) => {
        await start('batch-a');
      },
    );
    await s.service.runFileSyncBatch('batch-a', vi.fn());
    expect(s.set).not.toHaveBeenCalled();
    expect(s.sse.onMediaMessageDownloadProgress).toHaveBeenCalledWith({
      threadId: 8,
      seq: 13,
      status: 'downloading',
      completedFiles: 0,
      totalFiles: 1,
      activeFile: null,
    });
  });

  it('stops durable tasks without requiring or rewriting temporary coordination', async () => {
    const s = serviceWith({ message: { threadId: 8, seq: 13 } });
    s.database.db.query.fileSyncProgress.findFirst
      .mockResolvedValueOnce({ messageId: 23n })
      .mockResolvedValueOnce(undefined);
    await s.service.stopInboundBatch('batch-a');
    expect(s.database.db.update).toHaveBeenCalledWith(tables.fileSyncProgress);
    expect(s.database.db.update).toHaveBeenCalledWith(tables.message);
    expect(s.database.db.update).not.toHaveBeenCalledWith(tables.pendingMedia);
    expect(s.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        errorKind: 'USER_STOPPED',
      }),
    );
  });

  it('persists the stop reason inside execution stop admission', async () => {
    const s = serviceWith({
      pendingMedia: { messageId: 23n },
      message: { threadId: 8, seq: 13 },
    });
    s.database.db.query.fileSyncProgress.findFirst
      .mockResolvedValueOnce({ messageId: 23n })
      .mockResolvedValueOnce(undefined);
    s.fileSync.stopBatch.mockImplementation(async (_batchId, persistStop) => {
      expect(s.database.db.transaction).not.toHaveBeenCalled();
      expect(persistStop).toBeTypeOf('function');
      await persistStop!();
      expect(s.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILED',
          errorKind: 'USER_STOPPED',
        }),
      );
    });
    await s.service.stopInboundBatch('batch-a');
    expect(s.database.db.delete).not.toHaveBeenCalled();
    expect(s.fileSync.stopBatch).toHaveBeenCalledWith(
      'batch-a',
      expect.any(Function),
    );
  });

  it('rejects conflicting commands while stop drains and allows a fresh retry afterward', async () => {
    const s = serviceWith({
      pendingMedia: { ...inboundBatch, status: 'ready' },
      message: { localState: 'READY' },
    });
    let release!: () => void;
    s.fileSync.stopBatch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const stopping = s.service.stopInboundBatch('batch-a');
    await vi.waitFor(() => expect(s.fileSync.stopBatch).toHaveBeenCalledOnce());
    try {
      for (const command of [
        () => s.service.retryInboundBatch('batch-a'),
        () => s.service.stopInboundBatch('batch-a'),
        () => s.service.recoverInboundBatch('batch-a'),
      ]) {
        await expect(command()).rejects.toThrow('download lifecycle is busy');
      }
      expect(s.fileSync.stopBatch).toHaveBeenCalledOnce();
    } finally {
      release();
      await stopping;
    }
    await s.service.retryInboundBatch('batch-a');
    expect(s.fileSync.stopBatch).toHaveBeenCalledTimes(2);
  });

  it('releases lifecycle admission after a failed drain without silently retrying', async () => {
    const s = serviceWith({
      pendingMedia: { ...inboundBatch, status: 'ready' },
      message: { localState: 'READY' },
    });
    s.fileSync.stopBatch.mockRejectedValueOnce(new Error('drain failed'));
    await expect(s.service.retryInboundBatch('batch-a')).rejects.toThrow(
      'drain failed',
    );
    expect(s.fileSync.runBatch).not.toHaveBeenCalled();
    await s.service.retryInboundBatch('batch-a');
    expect(s.fileSync.stopBatch).toHaveBeenCalledTimes(2);
  });

  it('does not block an unrelated batch while one stop is draining', async () => {
    const s = serviceWith();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.fileSync.stopBatch.mockImplementationOnce(() => gate);
    const stopping = s.service.stopInboundBatch('batch-a');
    await vi.waitFor(() => expect(s.fileSync.stopBatch).toHaveBeenCalledOnce());
    try {
      await s.service.stopInboundBatch('batch-b');
      expect(s.fileSync.stopBatch).toHaveBeenCalledWith(
        'batch-b',
        expect.any(Function),
      );
    } finally {
      release();
      await stopping;
    }
  });

  it.each(['USER_STOPPED', 'REMOTE_IO'])(
    'does not automatically recover a failed batch with reason %s',
    async (failReason) => {
      const s = serviceWith({
        pendingMedia: { ...inboundBatch, status: 'pending' },
        progress: { id: 7n, status: 'FAILED', errorKind: failReason },
      });
      await expect(s.service.recoverInboundBatch('batch-a')).resolves.toEqual({
        batchId: 'batch-a',
        resetFiles: 0,
      });
      expect(s.fileSync.runBatch).not.toHaveBeenCalled();
      expect(s.database.db.update).toHaveBeenCalledWith(tables.message);
      expect(s.database.db.update).not.toHaveBeenCalledWith(
        tables.pendingMedia,
      );
      expect(s.database.db.update).not.toHaveBeenCalledWith(
        tables.fileSyncProgress,
      );
    },
  );

  it('settles a failed task through its message owner without coordination', async () => {
    const s = serviceWith({
      progress: {
        id: 7n,
        messageId: 23n,
        status: 'FAILED',
        errorKind: 'REMOTE_IO',
      },
      message: { threadId: 8, seq: 13 },
      progressRows: [{ status: 'FAILED' }],
    });
    s.fileSync.runBatch.mockImplementation(
      async (_id, _fetch, _promote, fail) => fail('batch-a'),
    );
    await s.service.runFileSyncBatch('batch-a', vi.fn());
    expect(s.database.db.query.pendingMedia.findFirst).not.toHaveBeenCalled();
    expect(s.database.db.update).toHaveBeenCalledExactlyOnceWith(
      tables.message,
    );
    expect(s.set).toHaveBeenCalledWith(
      expect.objectContaining({ localState: 'FAILED' }),
    );
    expect(s.sse.completeMediaMessageDownloadProgress).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 8, seq: 13, status: 'failed' }),
    );
  });

  it('does not project an obsolete failure after retry resets tasks under the message lock', async () => {
    const s = serviceWith({
      progress: { id: 7n, messageId: 23n, status: 'FAILED' },
      message: { threadId: 8, seq: 13 },
    });
    s.database.db.execute.mockImplementationOnce(async () => {
      // Simulate a retry committing before this transaction acquires the message lock.
      s.database.db.query.fileSyncProgress.findFirst.mockResolvedValue(
        undefined,
      );
      return { rows: [] };
    });
    s.fileSync.runBatch.mockImplementation(
      async (_id, _fetch, _promote, fail) => fail('batch-a'),
    );
    await s.service.runFileSyncBatch('batch-a', vi.fn());
    expect(s.database.db.execute).toHaveBeenCalledOnce();
    expect(s.database.db.query.pendingMedia.findFirst).not.toHaveBeenCalled();
    expect(s.database.db.update).not.toHaveBeenCalled();
    expect(s.sse.completeMediaMessageDownloadProgress).not.toHaveBeenCalled();
  });

  it('does not let an old failure callback overwrite a stopped batch', async () => {
    const s = serviceWith({
      pendingMedia: {
        ...inboundBatch,
        status: 'failed',
        failReason: 'USER_STOPPED',
      },
      progress: { status: 'FAILED', errorKind: 'USER_STOPPED' },
    });
    // The conditional STUB -> FAILED message update rejects an already settled stop.
    s.returning.mockResolvedValue([]);
    s.fileSync.runBatch.mockImplementation(
      async (_id, _fetch, _promote, fail) => fail('batch-a'),
    );
    await s.service.runFileSyncBatch('batch-a', vi.fn());
    expect(s.database.db.update).not.toHaveBeenCalledWith(
      tables.fileSyncProgress,
    );
    expect(s.database.db.update).not.toHaveBeenCalledWith(tables.pendingMedia);
    expect(s.sse.completeMediaMessageDownloadProgress).not.toHaveBeenCalled();
  });

  it('rechecks durable stop after waiting for the failure transaction message lock', async () => {
    const batch = { ...inboundBatch, status: 'downloading' };
    const s = serviceWith({
      pendingMedia: batch,
      progress: { errorKind: 'REMOTE_IO' },
    });
    let release!: () => void;
    s.database.db.execute.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { rows: [] };
    });
    s.fileSync.runBatch.mockImplementation(
      async (_id, _fetch, _promote, fail) => fail('batch-a'),
    );
    const execution = s.service.runFileSyncBatch('batch-a', vi.fn());
    await vi.waitFor(() =>
      expect(s.database.db.execute).toHaveBeenCalledOnce(),
    );
    // Stop changed Message.localState while failure waited for the message lock.
    s.returning.mockResolvedValue([]);
    release();
    await execution;
    expect(s.database.db.update).toHaveBeenCalledWith(tables.message);
    expect(s.database.db.update).not.toHaveBeenCalledWith(tables.pendingMedia);
    expect(s.sse.completeMediaMessageDownloadProgress).not.toHaveBeenCalled();
  });

  it('rejects recovery for a batch outside the inbound durable queue', async () => {
    const { service } = serviceWith();

    await expect(service.recoverInboundBatch('missing')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it.each(['recoverInboundBatch', 'retryInboundBatch'] as const)(
    '%s materializes completed tasks without requiring a remote route',
    async (command) => {
      const s = serviceWith({
        pendingMedia: { ...inboundBatch, status: 'pending' },
        message: { originSeq: 91, localState: 'STUB', threadId: 8, seq: 13 },
        progressRows: [{ status: 'COMPLETED' }, { status: 'COMPLETED' }],
      });
      s.promoter.promote.mockResolvedValue(true);
      await expect(s.service[command]('batch-a')).resolves.toEqual({
        batchId: 'batch-a',
        resetFiles: 0,
      });
      expect(s.promoter.promote).toHaveBeenCalledExactlyOnceWith('batch-a');
      expect(s.fileSync.runBatch).not.toHaveBeenCalled();
      expect(s.mediaRanges.fetch).not.toHaveBeenCalled();
      expect(s.database.db.update).not.toHaveBeenCalled();
      expect(s.sse.completeMediaMessageDownloadProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          completedFiles: 2,
          totalFiles: 2,
        }),
      );
    },
  );

  it.each([
    { progressRows: [] },
    { progressRows: [{ status: 'COMPLETED' }, { status: 'PENDING' }] },
  ])(
    'does not bypass route validation for missing or incomplete tasks ($progressRows)',
    async ({ progressRows }) => {
      const s = serviceWith({
        pendingMedia: { ...inboundBatch, status: 'pending' },
        message: { originSeq: 91, localState: 'STUB' },
        progressRows,
      });
      await expect(s.service.recoverInboundBatch('batch-a')).rejects.toThrow(
        'has no persisted download route',
      );
      expect(s.promoter.promote).not.toHaveBeenCalled();
      expect(s.fileSync.runBatch).not.toHaveBeenCalled();
      expect(s.database.db.update).not.toHaveBeenCalled();
    },
  );

  it('replays the persisted authorization route when retrying a stalled batch', async () => {
    const batch = {
      id: 11n,
      batchId: 'batch-a',
      direction: 'INBOUND',
      messageId: 23n,
      threadId: null,
      creatorAccount: null,
      contentType: null,
      content: null,
      clientMessageId: null,
      originDomain: 'origin.example',
      namespaceId: 3,
      expectedAuthorizationEpoch: 4,
    };
    const { service, fileSync, mediaRanges } = serviceWith({
      pendingMedia: batch,
      message: { originSeq: 91 },
      progress: {
        payload: {
          fromAccount: 'alice',
          fromDomain: 'origin.example',
          toAccount: 'bob',
        },
      },
    });
    const chunks = (async function* () {
      yield Buffer.from('data');
    })();
    mediaRanges.fetch.mockReturnValue(chunks);

    await expect(service.retryInboundBatch('batch-a')).resolves.toEqual({
      batchId: 'batch-a',
      resetFiles: 1,
    });
    expect(fileSync.runBatch).toHaveBeenCalledOnce();
    const fetchChunks = fileSync.runBatch.mock.calls[0]?.[1] as (
      digest: string,
      offset: number,
      declaredBytes: number,
      signal?: AbortSignal,
    ) => AsyncIterable<Buffer>;

    const controller = new AbortController();
    expect(fetchChunks('a'.repeat(64), 128, 256, controller.signal)).toBe(
      chunks,
    );
    expect(mediaRanges.fetch).toHaveBeenCalledWith(
      'origin.example',
      'a'.repeat(64),
      'alice',
      'origin.example',
      'bob',
      91,
      128,
      256,
      controller.signal,
    );
  });

  it('closes message and file progress streams after a completed batch is promoted', async () => {
    const { service, promoter, sse } = serviceWith({
      pendingMedia: {
        id: 11n,
        batchId: 'batch-a',
        direction: 'INBOUND',
        messageId: 23n,
        threadId: null,
        creatorAccount: null,
        contentType: null,
        content: null,
        clientMessageId: null,
        originDomain: 'origin.example',
        namespaceId: 3,
        expectedAuthorizationEpoch: 4,
      },
      message: { threadId: 8, seq: 13 },
      progressRows: [
        {
          digest: 'a'.repeat(64),
          status: 'COMPLETED',
          bytesReceived: 10n,
          bytesTotal: 100n,
        },
        {
          digest: 'b'.repeat(64),
          status: 'COMPLETED',
          bytesReceived: 50n,
          bytesTotal: 50n,
        },
      ],
    });
    promoter.promote.mockResolvedValue(true);

    await service.promotePendingMessage('batch-a');

    expect(sse.completeMediaMessageDownloadProgress).toHaveBeenCalledWith({
      threadId: 8,
      seq: 13,
      status: 'ready',
      completedFiles: 2,
      totalFiles: 2,
      activeFile: null,
    });
    expect(sse.completeMediaFileDownloadProgress).not.toHaveBeenCalled();
  });

  it('retains failed progress and its authorization route for administrative retry', async () => {
    const batch = {
      id: 11n,
      batchId: 'batch-a',
      direction: 'INBOUND',
      status: 'downloading',
      messageId: 23n,
      threadId: null,
      creatorAccount: null,
      contentType: null,
      content: null,
      clientMessageId: null,
      originDomain: 'origin.example',
      namespaceId: 3,
      expectedAuthorizationEpoch: 4,
    };
    const { service, database, fileSync, sse, set } = serviceWith({
      pendingMedia: batch,
      message: { threadId: 8, seq: 13 },
      progress: { errorKind: 'REMOTE_IO' },
      progressRows: [
        {
          digest: 'a'.repeat(64),
          status: 'PENDING',
          bytesReceived: 10n,
          bytesTotal: 100n,
        },
      ],
    });
    fileSync.runBatch.mockImplementation(
      async (
        _batchId: string,
        _fetch: unknown,
        _promote: unknown,
        fail: (batchId: string) => Promise<void>,
      ) => fail('batch-a'),
    );

    await service.runFileSyncBatch('batch-a', vi.fn());

    expect(database.db.delete).not.toHaveBeenCalled();
    expect(database.db.update).not.toHaveBeenCalledWith(tables.pendingMedia);
    expect(database.db.update).not.toHaveBeenCalledWith(
      tables.fileSyncProgress,
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        localState: 'FAILED',
      }),
    );
    expect(sse.completeMediaMessageDownloadProgress).toHaveBeenCalledWith({
      threadId: 8,
      seq: 13,
      status: 'failed',
      completedFiles: 0,
      totalFiles: 1,
      activeFile: null,
    });
    expect(sse.completeMediaFileDownloadProgress).not.toHaveBeenCalled();
  });
});
