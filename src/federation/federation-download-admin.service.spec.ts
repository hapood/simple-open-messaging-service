import { describe, expect, it, vi } from 'vitest';
import { FederationDownloadAdminService } from './federation-download-admin.service.js';

function service() {
  const lifecycle = {
    retryInboundBatch: vi.fn().mockResolvedValue({ resetFiles: 2 }),
    stopInboundBatch: vi.fn().mockResolvedValue(undefined),
  };
  return {
    subject: new FederationDownloadAdminService(lifecycle as never),
    lifecycle,
  };
}

describe('FederationDownloadAdminService', () => {
  it('delegates stop and retry to the domain lifecycle', async () => {
    const { subject, lifecycle } = service();
    await subject.stop('batch');
    await expect(subject.retry('batch')).resolves.toEqual({ resetFiles: 2 });
    expect(lifecycle.stopInboundBatch).toHaveBeenCalledWith('batch');
    expect(lifecycle.retryInboundBatch).toHaveBeenCalledWith('batch');
  });

  it('propagates lifecycle errors without treating failed stop as success', async () => {
    const { subject, lifecycle } = service();
    const failure = new Error('cannot stop active writer');
    lifecycle.stopInboundBatch.mockRejectedValueOnce(failure);
    await expect(subject.stop('batch')).rejects.toBe(failure);
    expect(lifecycle.retryInboundBatch).not.toHaveBeenCalled();
  });
});
