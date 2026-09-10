import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { saveTaskCheckpointInTx } from './task-checkpoint.js';

describe('saveTaskCheckpointInTx', () => {
  function harness(rows: { id: bigint }[]) {
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn((_condition: SQL) => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const tx = { update: vi.fn(() => ({ set })) };
    return { tx, set, where };
  }

  it.each(['PROCESSING', 'ASYNC_PROCESSING'] as const)(
    'writes only while the task is in the expected %s state',
    async (status) => {
      const h = harness([{ id: 7n }]);
      await saveTaskCheckpointInTx(h.tx as never, 7n, { after: '10' }, status);
      expect(h.set).toHaveBeenCalledWith({ checkpoint: { after: '10' } });
      expect(
        new PgDialect().sqlToQuery(h.where.mock.calls[0][0]).params,
      ).toEqual([7n, status]);
    },
  );

  it('preserves synchronous state checking by default', async () => {
    const h = harness([{ id: 7n }]);
    await saveTaskCheckpointInTx(h.tx as never, 7n, {});
    expect(new PgDialect().sqlToQuery(h.where.mock.calls[0][0]).params).toEqual(
      [7n, 'PROCESSING'],
    );
  });

  it.each(['PROCESSING', 'ASYNC_PROCESSING'] as const)(
    'fails instead of silently losing a checkpoint when %s no longer matches',
    async (status) => {
      const h = harness([]);
      await expect(
        saveTaskCheckpointInTx(h.tx as never, 7n, {}, status),
      ).rejects.toThrow('Task is not processing');
    },
  );
});
