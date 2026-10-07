import { describe, expect, it, vi } from 'vitest';
import { FederationDownloadRecoveryService } from './federation-download-recovery.service.js';

function setup(batchIds: string[]) {
  const where = vi
    .fn()
    .mockResolvedValue(batchIds.map((batchId) => ({ batchId })));
  const innerJoin = vi.fn().mockReturnValue({ where });
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin, leftJoin });
  const selectDistinct = vi.fn().mockReturnValue({ from });
  const recoverInboundBatch = vi.fn().mockResolvedValue({
    batchId: batchIds[0] ?? '',
    resetFiles: 0,
  });
  const service = new FederationDownloadRecoveryService(
    { db: { selectDistinct } } as never,
    { recoverInboundBatch } as never,
    {
      initialize: vi.fn().mockResolvedValue(undefined),
      waitUntilInitialized: vi.fn().mockResolvedValue(undefined),
    } as never,
  );
  return { service, recoverInboundBatch };
}

describe('FederationDownloadRecoveryService', () => {
  it('rebuilds the volatile queue for every persisted active inbound batch', async () => {
    const { service, recoverInboundBatch } = setup(['batch-a', 'batch-b']);

    await service.onApplicationBootstrap();

    expect(recoverInboundBatch).toHaveBeenNthCalledWith(1, 'batch-a');
    expect(recoverInboundBatch).toHaveBeenNthCalledWith(2, 'batch-b');
  });

  it('continues scanning when one batch cannot be resumed', async () => {
    const { service, recoverInboundBatch } = setup(['broken', 'healthy']);
    recoverInboundBatch.mockRejectedValueOnce(new Error('bad persisted row'));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(recoverInboundBatch).toHaveBeenCalledTimes(2);
    expect(recoverInboundBatch).toHaveBeenLastCalledWith('healthy');
  });

  it('wakes every quota-paused batch for one peer', async () => {
    const { service, recoverInboundBatch } = setup(['paused-a', 'paused-b']);

    await expect(service.wakeQuotaPaused(42)).resolves.toBe(2);

    expect(recoverInboundBatch).toHaveBeenNthCalledWith(1, 'paused-a');
    expect(recoverInboundBatch).toHaveBeenNthCalledWith(2, 'paused-b');
  });
});
