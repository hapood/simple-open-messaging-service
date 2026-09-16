import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../../common/business-code.js';
import { ThreadReadPositionService } from './thread-read-position.service.js';

describe('ThreadReadPositionService', () => {
  it('returns a business rejection without opening a transaction for invalid input', async () => {
    const transaction = vi.fn();
    const service = new ThreadReadPositionService(
      { db: { transaction } } as never,
      {} as never,
    );

    await expect(
      service.execute(1, { threadId: 2, localReadHwm: -1 }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      reason: 'INVALID_READ_POSITION',
      code: BusinessCode.VALIDATION_FAILED,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('returns THREAD_NOT_FOUND when the content lock cannot locate the thread', async () => {
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    const database = {
      db: { transaction: (run: (value: unknown) => unknown) => run(tx) },
    };
    const service = new ThreadReadPositionService(
      database as never,
      {} as never,
    );

    await expect(
      service.execute(1, { threadId: 2, localReadHwm: 0 }),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      reason: 'THREAD_NOT_FOUND',
      code: BusinessCode.THREAD_NOT_FOUND,
    });
  });

  it.each([false, true])(
    'notifies only after a successful commit (rollback: %s)',
    async (rollback) => {
      const onThreadFeedUpdated = vi.fn();
      const database = {
        db: {
          transaction: vi.fn().mockImplementation(async () => {
            if (rollback) throw new Error('commit rejected');
            return {
              applied: true,
              outcome: { status: 'APPLIED', lastReadSeq: 4 },
              threadFeedEndId: 8,
            };
          }),
        },
      };
      const service = new ThreadReadPositionService(
        database as never,
        {
          onThreadFeedUpdated,
        } as never,
      );

      const command = service.execute(7, { threadId: 9, localReadHwm: 4 });
      if (rollback) {
        await expect(command).rejects.toThrow('commit rejected');
        expect(onThreadFeedUpdated).not.toHaveBeenCalled();
      } else {
        await expect(command).resolves.toEqual({
          status: 'APPLIED',
          lastReadSeq: 4,
        });
        expect(onThreadFeedUpdated).toHaveBeenCalledExactlyOnceWith(7, {
          threadFeedEndId: 8,
        });
      }
    },
  );
});
