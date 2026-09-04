import { describe, expect, it, vi } from 'vitest';
import * as tables from '../database/schema.js';
import { FederationDownloadAdminService } from './federation-download-admin.service.js';

describe('FederationDownloadAdminService', () => {
  it('delegates retry to the inbound download lifecycle', async () => {
    const batches = {
      retryInboundBatch: vi.fn().mockResolvedValue({
        batchId: 'batch-a',
        resetFiles: 2,
      }),
    };
    const service = new FederationDownloadAdminService(
      { db: {} } as never,
      batches as never,
    );

    await expect(service.retry('batch-a')).resolves.toEqual({
      batchId: 'batch-a',
      resetFiles: 2,
    });
    expect(batches.retryInboundBatch).toHaveBeenCalledWith('batch-a');
  });

  it('removes an inbound batch and its transitive staged dependencies', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ status: 'failed' }] })
      .mockResolvedValueOnce({
        rows: [{ batchId: 'batch-a' }, { batchId: 'batch-b' }],
      });
    const fileReturning = vi.fn().mockResolvedValue([{ id: 1n }, { id: 2n }]);
    const batchReturning = vi.fn().mockResolvedValue([{ id: 3n }, { id: 4n }]);
    const remove = vi.fn((table: unknown) => ({
      where: vi.fn().mockReturnValue({
        returning:
          table === tables.fileSyncProgress ? fileReturning : batchReturning,
      }),
    }));
    const tx = { execute, delete: remove };
    const database = {
      db: {
        transaction: vi.fn(async (work: (client: typeof tx) => unknown) =>
          work(tx),
        ),
      },
    };
    const service = new FederationDownloadAdminService(
      database as never,
      {} as never,
    );

    await expect(service.clean('batch-a')).resolves.toEqual({
      clearedBatch: true,
      clearedDependents: 1,
      fileRows: 2,
    });
    expect(remove).toHaveBeenNthCalledWith(1, tables.fileSyncProgress);
    expect(remove).toHaveBeenNthCalledWith(2, tables.pendingMedia);
  });

  it('does not delete anything when the requested inbound batch is absent', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      delete: vi.fn(),
    };
    const database = {
      db: {
        transaction: vi.fn(async (work: (client: typeof tx) => unknown) =>
          work(tx),
        ),
      },
    };
    const service = new FederationDownloadAdminService(
      database as never,
      {} as never,
    );

    await expect(service.clean('missing')).resolves.toEqual({
      clearedBatch: false,
      clearedDependents: 0,
      fileRows: 0,
    });
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it('rejects cleaning an active download', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ status: 'downloading' }],
      }),
      delete: vi.fn(),
    };
    const database = {
      db: {
        transaction: vi.fn(async (work: (client: typeof tx) => unknown) =>
          work(tx),
        ),
      },
    };
    const service = new FederationDownloadAdminService(
      database as never,
      {} as never,
    );

    await expect(service.clean('batch-a')).rejects.toThrow(
      'an active federation download cannot be cleaned',
    );
    expect(tx.delete).not.toHaveBeenCalled();
  });
});
