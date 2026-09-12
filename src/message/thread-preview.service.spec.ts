import { describe, expect, it, vi } from 'vitest';
import { ThreadPreviewService } from './thread-preview.service.js';
import { threadPreviewLimit } from './thread-preview-limit.js';
import { enqueueMessageFanoutsInTx } from './thread-fanout-task.js';
vi.mock('../business/shared/locks/thread-content-lock.js', () => ({
  requireThreadContentLockInTx: vi.fn().mockResolvedValue({ threadId: 7 }),
}));
vi.mock('./thread-fanout-task.js', () => ({
  enqueueMessageFanoutsInTx: vi.fn().mockResolvedValue(1n),
}));

describe('database preview lifecycle', () => {
  it('does not hydrate or allocate an in-memory window at construction', () => {
    const transaction = vi.fn();
    const service = new ThreadPreviewService({ db: { transaction } } as never);
    expect(transaction).not.toHaveBeenCalled();
    expect(service).not.toHaveProperty('cache');
    expect(service).not.toHaveProperty('fanoutBarrier');
  });

  it('admits both content tasks in the same message transaction and skips null retries', async () => {
    vi.mocked(enqueueMessageFanoutsInTx).mockClear();
    const tx = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ curSeq: 9, tombstoneEndSeq: 3 }],
      }),
    };
    const transaction = vi.fn(async (run: (tx: object) => Promise<unknown>) =>
      run(tx),
    );
    const service = new ThreadPreviewService({ db: { transaction } } as never);
    await service.commitMessage(7, async (actual) => {
      expect(actual).toBe(tx);
      return { threadId: 7, seq: 9 };
    });
    expect(enqueueMessageFanoutsInTx).toHaveBeenCalledExactlyOnceWith(
      tx,
      { threadId: 7 },
      {
        threadId: 7,
        messageEndSeq: 9,
        tombstoneEndSeq: 3,
      },
    );
    await service.commitMessage(7, async () => null);
    expect(enqueueMessageFanoutsInTx).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('reads no fallback history when the stored reference query is empty', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const service = new ThreadPreviewService({} as never);
    expect(await service.readInTx({ execute } as never, 1, 7, 5)).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('validates configurable capacity', () => {
    expect(threadPreviewLimit('2')).toBe(2);
    for (const raw of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
      expect(() => threadPreviewLimit(raw)).toThrow();
    }
  });
});
