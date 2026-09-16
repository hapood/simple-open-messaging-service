import { describe, expect, it, vi } from 'vitest';
import { ThreadHistoryService } from './thread-history.service.js';
vi.mock('../common/business/locks/thread-content-lock.js', () => ({
  requireThreadContentLockInTx: vi.fn().mockResolvedValue({ threadId: 9 }),
}));

describe('ThreadHistoryService.clear', () => {
  function setup(curSeq: number) {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn((_values: Record<string, unknown>) => ({ where }));
    const database = {
      db: {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ id: 9 }] })
          .mockResolvedValue({ rows: [] }),
        query: {
          messageThread: {
            findFirst: vi.fn().mockResolvedValue({ curSeq }),
          },
        },
        update: vi.fn(() => ({ set })),
      },
    };
    return {
      service: new ThreadHistoryService({
        db: {
          transaction: (run: (tx: unknown) => Promise<unknown>) =>
            run(database.db),
        },
      } as never),
      database,
      set,
    };
  }

  it('advances the shared boundary to a requested valid sequence', async () => {
    const { service, set } = setup(12);

    await service.clear(9, 7);

    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0]?.[0]).toMatchObject({
      clearedSeq: expect.anything(),
      updatedAt: expect.any(Date),
    });
  });

  it('uses the current sequence when seq is omitted', async () => {
    const { service, set } = setup(12);

    await service.clear(9);

    expect(set).toHaveBeenCalledOnce();
  });

  it('rejects a sequence beyond the current thread sequence', async () => {
    const { service, database } = setup(12);

    await expect(service.clear(9, 13)).rejects.toMatchObject({
      bizCode: 10000,
    });
    expect(database.db.update).not.toHaveBeenCalled();
  });
});
