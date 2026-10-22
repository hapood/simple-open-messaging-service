import { describe, expect, it, vi } from 'vitest';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { durableTask } from '../database/schema.js';
import {
  insertPendingTaskInTx,
  updatePendingTaskInTx,
  supersedePendingTasksInTx,
} from './task-admission.js';

describe('task admission primitives', () => {
  function harness(rows: { taskId: bigint }[] = [{ taskId: 7n }]) {
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn((_condition: SQL) => ({ returning }));
    const values = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const tx = {
      insert: vi.fn(() => ({ values })),
      update: vi.fn(() => ({ set })),
    };
    return { tx, values, set, where };
  }

  const input = {
    kind: 'PROJECTION' as const,
    scopeType: 'THREAD' as const,
    scopeKey: 'test',
    taskType: 'FAN_OUT_THREAD_CONTENT',
    payload: { threadId: 1 },
  };

  it('inserts a pending task without deciding its merge policy', async () => {
    const h = harness();
    expect(await insertPendingTaskInTx(h.tx as never, input)).toEqual({
      taskId: 7n,
    });
    expect(h.values).toHaveBeenCalledWith({ ...input, status: 'PENDING' });
  });

  it('rejects an insert without a returned task', async () => {
    await expect(
      insertPendingTaskInTx(harness([]).tx as never, input),
    ).rejects.toThrow('durable task insert returned no row');
  });

  it('reports a lost pending update to the caller instead of modifying a claimed task', async () => {
    const h = harness([]);
    expect(
      await updatePendingTaskInTx(h.tx as never, 7n, {
        payload: { through: '2' },
      }),
    ).toBeUndefined();
    expect(new PgDialect().sqlToQuery(h.where.mock.calls[0][0]).params).toEqual(
      [7n, 'PENDING'],
    );
  });

  it('restricts supersession to the supplied target and pending state', async () => {
    const h = harness();
    await supersedePendingTasksInTx(h.tx as never, eq(durableTask.id, 7n));
    expect(h.set).toHaveBeenCalledWith({
      status: 'SUPERSEDED',
      completedAt: expect.anything(),
    });
    expect(new PgDialect().sqlToQuery(h.where.mock.calls[0][0]).params).toEqual(
      [7n, 'PENDING'],
    );
  });
});
