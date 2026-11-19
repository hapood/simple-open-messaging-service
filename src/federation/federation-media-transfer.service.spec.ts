import { describe, expect, it, vi } from 'vitest';
import { FederationMediaTransferService } from './federation-media-transfer.service.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import { FileSizeLimitError } from '../upload/file-size-limit.js';
import { CasOversizeError } from '../upload/upload.service.js';

function setup() {
  let limit = 4;
  let cached: { bytes: bigint } | undefined;
  const events: string[] = [];
  const database = {
    db: {
      query: {
        systemSetting: { findMany: vi.fn().mockResolvedValue([]) },
        mediaAsset: { findFirst: vi.fn(async () => cached) },
        fileSyncProgress: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
  };
  const quota = {
    assertFileSize: vi.fn(async (_id, bytes) => {
      FileSizeLimitError.assert(bytes, limit);
      return limit;
    }),
    claimFile: vi.fn(async () => {
      events.push('charge');
    }),
    addFileBytesDelta: vi.fn(),
  };
  const upload = {
    withCasDigestLock: vi.fn(async (_digest, operation) => operation()),
    removePublishedCasTemporary: vi.fn().mockResolvedValue(undefined),
    saveCasFromStream: vi.fn(async (_chunks, _digest, opts) => {
      events.push('transfer');
      cached = { bytes: BigInt(opts.declaredBytes) };
    }),
  };
  const scheduler = new FederationDownloadScheduler(database as never);
  const service = new FederationMediaTransferService(
    database as never,
    quota as never,
    upload as never,
    scheduler,
  );
  const input = {
    signal: new AbortController().signal,
    namespaceId: 7,
    peerDomain: 'peer.test',
    digest: 'a'.repeat(64),
    declaredBytes: 4,
    chunks: () =>
      (async function* () {
        yield Buffer.from('data');
      })(),
  };
  return {
    service,
    database,
    scheduler,
    input,
    upload,
    quota,
    events,
    limit: (n: number) => {
      limit = n;
    },
    cached: (n: bigint) => {
      cached = { bytes: n };
    },
  };
}

describe('shared federation media transfer', () => {
  it('retains shared checkpoints until every durable owner has completed', async () => {
    const s = setup();
    s.cached(4n);
    s.database.db.query.fileSyncProgress.findFirst.mockResolvedValueOnce({
      id: 2n,
    });
    await s.service.cleanupCompletedDownload(s.input.digest);
    expect(s.upload.removePublishedCasTemporary).not.toHaveBeenCalled();
    await s.service.cleanupCompletedDownload(s.input.digest);
    expect(
      s.upload.removePublishedCasTemporary,
    ).toHaveBeenCalledExactlyOnceWith(s.input.digest, 4n);
    expect(s.upload.withCasDigestLock).toHaveBeenCalledTimes(2);
  });

  it('retains the checkpoint if the published asset is missing and reports deletion failures', async () => {
    const s = setup();
    await s.service.cleanupCompletedDownload(s.input.digest);
    expect(s.upload.removePublishedCasTemporary).not.toHaveBeenCalled();
    s.cached(4n);
    const failure = new Error('unlink denied');
    s.upload.removePublishedCasTemporary.mockRejectedValueOnce(failure);
    await expect(
      s.service.cleanupCompletedDownload(s.input.digest),
    ).rejects.toBe(failure);
    await s.service.cleanupCompletedDownload(s.input.digest);
    expect(s.upload.removePublishedCasTemporary).toHaveBeenCalledTimes(2);
  });

  it('pages completed history and rejects late scan results after shutdown', async () => {
    const s = setup();
    const limit = vi
      .fn()
      .mockResolvedValueOnce([{ digest: s.input.digest }])
      .mockResolvedValueOnce([]);
    const where = vi.fn(() => ({ orderBy: () => ({ limit }) }));
    Object.assign(s.database.db, {
      selectDistinct: () => ({ from: () => ({ where }) }),
    });
    const cleanup = vi
      .spyOn(s.service, 'cleanupCompletedDownload')
      .mockResolvedValue(undefined);
    await s.service.recoverCompletedDownloads(new AbortController().signal);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(s.input.digest);
    expect(limit.mock.calls).toEqual([[100], [100]]);
    const controller = new AbortController();
    limit.mockImplementationOnce(async () => {
      controller.abort(new Error('shutdown'));
      return [{ digest: 'b'.repeat(64) }];
    });
    await expect(
      s.service.recoverCompletedDownloads(controller.signal),
    ).rejects.toThrow('shutdown');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects a pre-aborted consumer before quota or scheduling work', async () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort(new Error('consumer stopped'));
    await expect(
      s.service.receive({ ...s.input, signal: controller.signal }),
    ).rejects.toThrow('consumer stopped');
    expect(s.quota.assertFileSize).not.toHaveBeenCalled();
    expect(s.scheduler.snapshot().total).toBe(0);
  });

  it('does not report success when cancelled during final asset validation', async () => {
    const s = setup();
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.database.db.query.mediaAsset.findFirst
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        await gate;
        return { bytes: 4n };
      });
    const transfer = s.service.receive({
      ...s.input,
      signal: controller.signal,
    });
    const rejected = expect(transfer).rejects.toThrow('consumer stopped');
    await vi.waitFor(() =>
      expect(s.database.db.query.mediaAsset.findFirst).toHaveBeenCalledTimes(2),
    );
    controller.abort(new Error('consumer stopped'));
    release();
    await rejected;
    expect(s.upload.saveCasFromStream).toHaveBeenCalledOnce();
  });

  it('does not start physical writes after cancellation during quota admission', async () => {
    const s = setup();
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.quota.claimFile.mockImplementationOnce(() => gate);
    const transfer = s.service.receive({
      ...s.input,
      signal: controller.signal,
    });
    const rejected = expect(transfer).rejects.toThrow('consumer stopped');
    await vi.waitFor(() => expect(s.quota.claimFile).toHaveBeenCalledOnce());
    controller.abort(new Error('consumer stopped'));
    release();
    await rejected;
    await s.scheduler.waitForDigest(s.input.digest);
    expect(s.upload.saveCasFromStream).not.toHaveBeenCalled();
  });

  it('coalesces normal and localization callers and charges before IO exactly once', async () => {
    const s = setup();
    await Promise.all([
      s.service.receive(s.input),
      s.service.receive({ ...s.input, peerDomain: 'other.test', namespaceId: 8 }),
    ]);
    expect(s.events).toEqual(['charge', 'transfer']);
    expect(s.quota.claimFile).toHaveBeenCalledWith(7, 1, 4n);
    expect(s.upload.saveCasFromStream).toHaveBeenCalledTimes(1);
  });
  it('retains failed admission charges on retry and charges excess once for all waiters', async () => {
    const s = setup();
    s.upload.saveCasFromStream.mockRejectedValue(new CasOversizeError(2n));
    await Promise.allSettled([
      s.service.receive(s.input),
      s.service.receive(s.input),
    ]);
    expect(s.quota.claimFile).toHaveBeenCalledTimes(1);
    expect(s.quota.addFileBytesDelta).toHaveBeenCalledExactlyOnceWith(7, 2n);
    await expect(s.service.receive(s.input)).rejects.toBeInstanceOf(
      CasOversizeError,
    );
    expect(s.quota.claimFile).toHaveBeenCalledTimes(1);
    expect(s.quota.addFileBytesDelta).toHaveBeenCalledTimes(2);
  });
  it('preserves size and accounting errors for every shared consumer', async () => {
    const s = setup();
    const oversize = new CasOversizeError(2n);
    const accounting = new Error('quota database unavailable');
    s.upload.saveCasFromStream.mockRejectedValueOnce(oversize);
    s.quota.addFileBytesDelta.mockRejectedValueOnce(accounting);
    const results = await Promise.allSettled([
      s.service.receive(s.input),
      s.service.receive({ ...s.input }),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: {
          message: 'oversized media transfer accounting failed',
          errors: [oversize, accounting],
        },
      });
    }
    expect(s.upload.saveCasFromStream).toHaveBeenCalledOnce();
    expect(s.quota.claimFile).toHaveBeenCalledOnce();
    expect(s.quota.addFileBytesDelta).toHaveBeenCalledExactlyOnceWith(7, 2n);
    expect(s.scheduler.hasDigest(s.input.digest)).toBe(false);
  });

  it('does not let a failed undersized descriptor exempt a changed declaration from charging', async () => {
    const s = setup();
    s.upload.saveCasFromStream.mockRejectedValue(
      new Error('incorrect descriptor'),
    );
    await expect(
      s.service.receive({ ...s.input, declaredBytes: 1 }),
    ).rejects.toThrow();
    await expect(s.service.receive(s.input)).rejects.toThrow();
    expect(s.quota.claimFile).toHaveBeenNthCalledWith(1, 7, 1, 1n);
    expect(s.quota.claimFile).toHaveBeenNthCalledWith(2, 7, 1, 4n);
  });

  it('rejects oversize admission even on cache hit, without charging', async () => {
    const s = setup();
    s.cached(4n);
    s.limit(3);
    await expect(s.service.receive(s.input)).rejects.toBeInstanceOf(
      FileSizeLimitError,
    );
    expect(s.quota.claimFile).not.toHaveBeenCalled();
    expect(s.upload.saveCasFromStream).not.toHaveBeenCalled();
  });
  it('checks every waiter descriptor against the resulting CAS bytes', async () => {
    const s = setup();
    const results = await Promise.allSettled([
      s.service.receive(s.input),
      s.service.receive({ ...s.input, declaredBytes: 3 }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(s.quota.claimFile).toHaveBeenCalledTimes(1);
  });
  it('does not interrupt admitted IO after an admin lowers the object bound', async () => {
    const s = setup();
    s.upload.saveCasFromStream.mockImplementationOnce(
      async (_chunks, _digest, opts) => {
        expect(opts.maxFileBytes).toBe(4);
        s.limit(0);
        s.cached(4n);
      },
    );
    await expect(s.service.receive(s.input)).resolves.toBeUndefined();
    await expect(s.service.receive(s.input)).rejects.toBeInstanceOf(
      FileSizeLimitError,
    );
  });
});
