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
  it('coalesces normal and localization callers and charges before IO exactly once', async () => {
    const s = setup();
    await Promise.all([
      s.service.receive(s.input),
      s.service.receive({ ...s.input }),
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
