import { describe, expect, it, vi } from 'vitest';
import { UploadActivityService } from './upload-activity.service.js';
import { UploadRecoveryService } from './upload-recovery.service.js';

describe('UploadRecoveryService', () => {
  it('continues other durable sessions after one continuation fails', async () => {
    const where = vi.fn().mockResolvedValue([
      { creatorId: 1, id: 1n, status: 'PENDING' },
      { creatorId: 2, id: 2n, status: 'PENDING' },
    ]);
    const database = { db: { select: () => ({ from: () => ({ where }) }) } };
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue({});
    const recovery = new UploadRecoveryService(
      database as never,
      { recoverPending: complete } as never,
    );
    await recovery.resume();
    expect(complete.mock.calls).toEqual([
      [1, '1'],
      [2, '2'],
    ]);
    await recovery.resume();
    expect(complete).toHaveBeenCalledTimes(4);
  });

  it('dispatches waiting recovery without renewing registered deadlines on repeated scans', async () => {
    vi.useFakeTimers();
    const activity = new UploadActivityService();
    try {
      const where = vi.fn().mockResolvedValue([
        { creatorId: 1, id: 1n, status: 'PENDING' },
        { creatorId: 2, id: 2n, status: 'PENDING' },
      ]);
      const database = { db: { select: () => ({ from: () => ({ where }) }) } };
      const fail = vi.fn();
      const recoverWaiting = vi.fn(async (userId: number, taskId: string) => {
        activity.watch({ userId, taskId }, fail);
      });
      const complete = vi.fn().mockResolvedValue({});
      const recovery = new UploadRecoveryService(
        database as never,
        {
          recoverPending: async (userId: number, taskId: string) => {
            if (taskId === '1') await recoverWaiting(userId, taskId);
            else await complete(userId, taskId);
          },
        } as never,
      );
      await recovery.resume();
      await vi.advanceTimersByTimeAsync(29_999);
      await recovery.resume();
      expect(recoverWaiting.mock.calls).toEqual([
        [1, '1'],
        [1, '1'],
      ]);
      expect(complete.mock.calls).toEqual([
        [2, '2'],
        [2, '2'],
      ]);
      expect(fail).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fail).toHaveBeenCalledOnce();
    } finally {
      activity.onApplicationShutdown();
      vi.useRealTimers();
    }
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
