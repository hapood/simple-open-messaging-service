import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business.exception.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';

function serviceWith(overrides?: {
  pendingMedia?: unknown;
  message?: unknown;
  progress?: unknown;
}) {
  const returning = vi.fn().mockResolvedValue([{ id: 7n }]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  const deleteWhere = vi.fn().mockResolvedValue([]);
  const remove = vi.fn().mockReturnValue({ where: deleteWhere });
  const database = {
    db: {
      query: {
        pendingMedia: {
          findFirst: vi.fn().mockResolvedValue(overrides?.pendingMedia),
        },
        message: { findFirst: vi.fn().mockResolvedValue(overrides?.message) },
        fileSyncProgress: {
          findFirst: vi.fn().mockResolvedValue(overrides?.progress),
        },
      },
      update,
      delete: remove,
      transaction: vi.fn(),
    },
  };
  database.db.transaction.mockImplementation(async (work) => work(database.db));
  const fileSync = { runBatch: vi.fn().mockResolvedValue(undefined) };
  const promoter = { promote: vi.fn().mockResolvedValue(null) };
  const mediaRanges = { fetch: vi.fn() };
  const participants = {
    getActiveParticipantUserIds: vi.fn().mockResolvedValue([]),
  };
  const sse = { onMediaStatus: vi.fn() };
  const service = new FederationInboundMediaBatchService(
    database as never,
    fileSync as never,
    promoter as never,
    mediaRanges as never,
    participants as never,
    sse as never,
  );
  return {
    service,
    database,
    fileSync,
    promoter,
    mediaRanges,
    participants,
    sse,
    set,
  };
}

describe('FederationInboundMediaBatchService', () => {
  it('rejects recovery for a batch outside the inbound durable queue', async () => {
    const { service } = serviceWith();

    await expect(service.recoverInboundBatch('missing')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('promotes completed batches and recursively wakes quote dependents', async () => {
    const { service, fileSync, promoter } = serviceWith();
    const notify = vi.spyOn(service, 'publishMessageStatus');
    promoter.promote
      .mockResolvedValueOnce({
        dependentBatchIds: ['quote-a', 'quote-b'],
      })
      .mockResolvedValue(null);
    fileSync.runBatch.mockImplementation(
      async (
        _batchId: string,
        _fetch: unknown,
        promote: (batchId: string) => Promise<void>,
      ) => promote('root'),
    );

    await service.runFileSyncBatch('root', vi.fn());

    expect(promoter.promote).toHaveBeenNthCalledWith(1, 'root');
    expect(promoter.promote).toHaveBeenNthCalledWith(2, 'quote-a');
    expect(promoter.promote).toHaveBeenNthCalledWith(3, 'quote-b');
    expect(notify).not.toHaveBeenCalled();
  });

  it('replays the persisted authorization route when retrying a stalled batch', async () => {
    const batch = {
      id: 11n,
      batchId: 'batch-a',
      direction: 'INBOUND',
      messageId: 23n,
      threadId: null,
      creatorAccount: null,
      creatorDomain: null,
      contentType: null,
      content: null,
      clientMessageId: null,
      originDomain: 'origin.example',
      namespaceId: 3,
      expectedAuthorizationEpoch: 4,
      dependsOnOriginSeq: null,
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
    ) => AsyncIterable<Buffer>;

    expect(fetchChunks('a'.repeat(64), 128)).toBe(chunks);
    expect(mediaRanges.fetch).toHaveBeenCalledWith(
      'origin.example',
      'a'.repeat(64),
      'alice',
      'origin.example',
      'bob',
      91,
      128,
    );
  });

  it('retains a failed inbound task with its error after removing spent progress', async () => {
    const batch = {
      id: 11n,
      batchId: 'batch-a',
      direction: 'INBOUND',
      status: 'downloading',
      messageId: 23n,
      threadId: null,
      creatorAccount: null,
      creatorDomain: null,
      contentType: null,
      content: null,
      clientMessageId: null,
      originDomain: 'origin.example',
      namespaceId: 3,
      expectedAuthorizationEpoch: 4,
      dependsOnOriginSeq: null,
    };
    const { service, database, fileSync, participants, sse, set } = serviceWith(
      {
        pendingMedia: batch,
        message: { threadId: 8, seq: 13 },
        progress: { errorKind: 'REMOTE_IO' },
      },
    );
    participants.getActiveParticipantUserIds.mockResolvedValue([
      { userId: 19, blocked: false },
    ]);
    fileSync.runBatch.mockImplementation(
      async (
        _batchId: string,
        _fetch: unknown,
        _promote: unknown,
        fail: (batchId: string) => Promise<void>,
      ) => fail('batch-a'),
    );

    await service.runFileSyncBatch('batch-a', vi.fn());

    expect(database.db.delete).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        failReason: 'REMOTE_IO',
      }),
    );
    expect(sse.onMediaStatus).toHaveBeenCalledWith(19, {
      threadId: 8,
      seq: 13,
      status: 'failed',
    });
  });
});
