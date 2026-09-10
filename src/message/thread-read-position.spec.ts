import { describe, expect, it, vi } from 'vitest';
import {
  applyReadPositionInTx,
  resolveReadPositionInTx,
} from './thread-read-position.js';
import { BusinessCode } from '../common/business-code.js';
import type { DatabaseTransaction } from '../database/database.service.js';

describe('shared read-position validation', () => {
  function setup(lastReadSeq = 0, minimumReadSeq = 70) {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ bound: 100, lastReadSeq, minimumReadSeq }],
    });
    return { execute, tx: { execute } as unknown as DatabaseTransaction };
  }

  it.each([0, 50, 69])(
    'clamps read %s to the recoverable local boundary',
    async (seq) => {
      const { tx } = setup();
      await expect(
        resolveReadPositionInTx(tx, 1, { threadId: 2, localReadHwm: seq }),
      ).resolves.toBe(70);
    },
  );

  it.each([70, 71, 100])(
    'accepts read %s at or beyond the inclusive gap end',
    async (seq) => {
      const { tx } = setup();
      await expect(
        resolveReadPositionInTx(tx, 1, { threadId: 2, localReadHwm: seq }),
      ).resolves.toBe(seq);
    },
  );

  it('preserves monotonic reads and clamps force to the boundary', async () => {
    const { tx } = setup(80);
    await expect(
      resolveReadPositionInTx(tx, 1, { threadId: 2, localReadHwm: 20 }),
    ).resolves.toBe(80);
    await expect(
      resolveReadPositionInTx(tx, 1, {
        threadId: 2,
        localReadHwm: 20,
        force: true,
      }),
    ).resolves.toBe(70);
  });

  it('resolves again at execution when a new gap moves the boundary', async () => {
    const { tx, execute } = setup();
    await resolveReadPositionInTx(tx, 1, { threadId: 2, localReadHwm: 75 });
    execute
      .mockResolvedValueOnce({
        rows: [{ bound: 100, lastReadSeq: 0, minimumReadSeq: 90 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            account: 'reader',
            lastReadSeq: 0,
            lastMentionSeq: null,
            unreadCount: 0,
            previewSeqs: [],
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            blocked: false,
            clearedSeq: null,
            messageVisibleThroughSeq: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ lastReadSeq: 90 }] });
    await expect(
      applyReadPositionInTx(tx, 1, { threadId: 2, localReadHwm: 75 }),
    ).resolves.toBe(90);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('allows zero when no recoverable visible history remains', async () => {
    const { tx } = setup(0, 0);
    await expect(
      resolveReadPositionInTx(tx, 1, { threadId: 2, localReadHwm: 0 }),
    ).resolves.toBe(0);
  });

  it.each([false, true])(
    'clamps requests above the visible upper bound (force=%s)',
    async (force) => {
      const { tx } = setup();
      await expect(
        resolveReadPositionInTx(tx, 1, {
          threadId: 2,
          localReadHwm: 101,
          force,
        }),
      ).resolves.toBe(100);
    },
  );

  it.each([-1, 0.5, NaN, Infinity])(
    'still rejects invalid visible position %s',
    async (seq) => {
      const { tx } = setup();
      await expect(
        resolveReadPositionInTx(tx, 1, { threadId: 2, localReadHwm: seq }),
      ).rejects.toMatchObject({ bizCode: BusinessCode.VALIDATION_FAILED });
    },
  );
});
