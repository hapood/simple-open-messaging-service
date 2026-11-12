import { describe, expect, it, vi } from 'vitest';
import { UploadRecoveryService } from './upload-recovery.service.js';

describe('UploadRecoveryService', () => {
  it('continues other durable sessions after one continuation fails', async () => {
    const where = vi.fn().mockResolvedValue([
      { creatorId: 1, uploadId: 'a' },
      { creatorId: 2, uploadId: 'b' },
    ]);
    const database = { db: { select: () => ({ from: () => ({ where }) }) } };
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue({});
    const recovery = new UploadRecoveryService(
      database as never,
      { complete } as never,
    );
    await recovery.resume();
    expect(complete.mock.calls).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    await recovery.resume();
    expect(complete).toHaveBeenCalledTimes(4);
  });

  it('does not overlap local scans', async () => {
    let release!: () => void;
    const where = vi.fn().mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const database = { db: { select: () => ({ from: () => ({ where }) }) } };
    const recovery = new UploadRecoveryService(database as never, {} as never);
    const first = recovery.resume();
    await recovery.resume();
    expect(where).toHaveBeenCalledOnce();
    release();
    await first;
  });
});
