import { describe, expect, it, vi } from 'vitest';
import * as tables from '../database/schema.js';
import { FederationDownloadAdminService } from './federation-download-admin.service.js';

function service(status: string | null, dependent = false) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({ rows: status ? [{ status }] : [] })
    .mockResolvedValueOnce({ rows: dependent ? [{}] : [] });
  const returning = vi.fn().mockResolvedValue([{ digest: 'a'.repeat(64) }]);
  const remove = vi
    .fn()
    .mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) });
  const tx = { execute, delete: remove };
  const database = {
    db: {
      transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(tx)),
    },
  };
  const lifecycle = {
    retryInboundBatch: vi.fn().mockResolvedValue({ resetFiles: 2 }),
    stopInboundBatch: vi.fn().mockResolvedValue(undefined),
  };
  return {
    subject: new FederationDownloadAdminService(
      database as never,
      lifecycle as never,
    ),
    remove,
    lifecycle,
  };
}

describe('FederationDownloadAdminService', () => {
  it('delegates stop and retry to the domain lifecycle', async () => {
    const { subject, lifecycle } = service('failed');
    await subject.stop('batch');
    await expect(subject.retry('batch')).resolves.toEqual({ resetFiles: 2 });
    expect(lifecycle.stopInboundBatch).toHaveBeenCalledWith('batch');
    expect(lifecycle.retryInboundBatch).toHaveBeenCalledWith('batch');
  });

  it('physically removes stopped task rows and returns digests for shared-safe cleanup', async () => {
    const { subject, remove } = service('failed');
    await expect(subject.clean('batch')).resolves.toEqual({
      clearedBatch: true,
      temporaryDigests: ['a'.repeat(64)],
    });
    expect(remove).toHaveBeenNthCalledWith(1, tables.fileSyncProgress);
    expect(remove).toHaveBeenNthCalledWith(2, tables.pendingMedia);
  });

  it('is idempotent for a missing batch', async () => {
    const { subject, remove } = service(null);
    await expect(subject.clean('batch')).resolves.toEqual({
      clearedBatch: false,
      temporaryDigests: [],
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('requires stop before delete', async () => {
    const { subject, remove } = service('downloading');
    await expect(subject.clean('batch')).rejects.toThrow('stop the download');
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not silently delete active dependent tasks', async () => {
    const { subject, remove } = service('failed', true);
    await expect(subject.clean('batch')).rejects.toThrow(
      'stop dependent downloads',
    );
    expect(remove).not.toHaveBeenCalled();
  });
});
