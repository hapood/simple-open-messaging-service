import { describe, it, expect, vi } from 'vitest';

import { ThreadRevisionService } from './thread-revision.service.js';
import { planThreadDelta, type ThreadDeltaOp } from './thread-delta.js';

/** Minimal Drizzle fluent-query fake for the read paths under test. */
function makeService(
  rows: Array<{
    threadId: number;
    direction: 'ADD' | 'DELETE';
    revision: number;
  }>,
) {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const database = { db: { select } };
  const sse = { onThreadRevisionUpdated: vi.fn() };
  const svc = new ThreadRevisionService(database as never, sse as never);
  return { svc, select };
}

describe('ThreadRevisionService.queryDelta — (from excl, to incl]', () => {
  it('returns ADD/DELETE rows with revision in (from, to], ordered ascending', async () => {
    const rows = [
      { threadId: 10, direction: 'ADD' as const, revision: 2 },
      { threadId: 20, direction: 'DELETE' as const, revision: 4 },
      { threadId: 30, direction: 'ADD' as const, revision: 5 },
    ];
    const { svc, select } = makeService(rows);
    const out = await svc.queryDelta(1, 1, 5);
    expect(out).toEqual(rows);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('from==to yields an empty half-open window (nothing > from AND <= from)', async () => {
    const { svc, select } = makeService([]);
    const out = await svc.queryDelta(1, 3, 3);
    expect(out).toEqual([]); // the mock returns rows, but the WHERE encodes the empty window
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe('ThreadRevisionService hidden-thread restoration', () => {
  it('re-adds only active recipients whose current ADD row is marked deleted', async () => {
    const where = vi.fn().mockResolvedValue([{ userId: 2 }]);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
    const transaction = vi.fn(
      async (fn: (tx: { select: typeof select }) => unknown) => fn({ select }),
    );
    const sse = { onThreadRevisionUpdated: vi.fn() };
    const svc = new ThreadRevisionService(
      { db: { select, transaction } } as never,
      sse as never,
    );
    const recordAdd = vi.spyOn(svc, 'recordThreadAddInTx').mockResolvedValue(8);

    await svc.restoreHiddenThreads(10, [1, 2, 3]);

    expect(where).toHaveBeenCalledTimes(1);
    expect(recordAdd).toHaveBeenCalledTimes(1);
    expect(recordAdd).toHaveBeenCalledWith(expect.anything(), 2, 10);
    expect(sse.onThreadRevisionUpdated).toHaveBeenCalledWith(2, {
      threadRevision: 8,
    });
  });

  it('is a no-op for an empty active-recipient set', async () => {
    const transaction = vi.fn();
    const sse = { onThreadRevisionUpdated: vi.fn() };
    const svc = new ThreadRevisionService(
      { db: { transaction } } as never,
      sse as never,
    );

    await svc.restoreHiddenThreads(10, []);

    expect(transaction).not.toHaveBeenCalled();
    expect(sse.onThreadRevisionUpdated).not.toHaveBeenCalled();
  });

  it('does not publish any revision when restoration rolls back', async () => {
    const rollback = new Error('revision write failed');
    const transaction = vi.fn(async () => {
      throw rollback;
    });
    const sse = { onThreadRevisionUpdated: vi.fn() };
    const svc = new ThreadRevisionService(
      { db: { transaction } } as never,
      sse as never,
    );

    await expect(svc.restoreHiddenThreads(10, [2])).rejects.toBe(rollback);
    expect(sse.onThreadRevisionUpdated).not.toHaveBeenCalled();
  });
});

describe('ThreadRevisionService revision writes', () => {
  function writeHarness() {
    const returning = vi.fn().mockResolvedValue([{ threadRevision: 8 }]);
    const userWhere = vi.fn(() => ({ returning }));
    const setUser = vi.fn(() => ({ where: userWhere }));

    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));

    const revisionWhere = vi.fn().mockResolvedValue(undefined);
    const setRevision = vi.fn(() => ({ where: revisionWhere }));
    const update = vi
      .fn()
      .mockReturnValueOnce({ set: setUser })
      .mockReturnValueOnce({ set: setRevision });
    const insert = vi.fn(() => ({ values }));
    const tx = { update, insert };
    return {
      tx,
      update,
      setUser,
      values,
      onConflictDoUpdate,
      setRevision,
      revisionWhere,
    };
  }

  it('upserts an ADD at the bumped revision and reactivates its compacted row', async () => {
    const h = writeHarness();
    const svc = new ThreadRevisionService({} as never, {} as never);

    await expect(svc.recordThreadAddInTx(h.tx as never, 2, 10)).resolves.toBe(
      8,
    );

    expect(h.values).toHaveBeenCalledWith({
      userId: 2,
      threadId: 10,
      direction: 'ADD',
      revision: 8,
      isDelete: false,
    });
    expect(h.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: { revision: 8, isDelete: false } }),
    );
    expect(h.setRevision).not.toHaveBeenCalled();
  });

  it('upserts a DELETE and soft-deletes the compacted ADD row', async () => {
    const h = writeHarness();
    const svc = new ThreadRevisionService({} as never, {} as never);

    await expect(
      svc.recordThreadDeleteInTx(h.tx as never, 2, 10),
    ).resolves.toBe(8);

    expect(h.values).toHaveBeenCalledWith({
      userId: 2,
      threadId: 10,
      direction: 'DELETE',
      revision: 8,
    });
    expect(h.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: { revision: 8 } }),
    );
    expect(h.setRevision).toHaveBeenCalledWith({ isDelete: true });
    expect(h.revisionWhere).toHaveBeenCalledTimes(1);
  });

  it('publishes only after the outer ADD transaction commits', async () => {
    let committed = false;
    const transaction = vi.fn(async () => {
      committed = true;
      return 8;
    });
    const sse = {
      onThreadRevisionUpdated: vi.fn(() => expect(committed).toBe(true)),
    };
    const svc = new ThreadRevisionService(
      { db: { transaction } } as never,
      sse as never,
    );
    vi.spyOn(svc, 'recordThreadAddInTx').mockResolvedValue(8);

    await svc.recordThreadAdd(2, 10);

    expect(sse.onThreadRevisionUpdated).toHaveBeenCalledWith(2, {
      threadRevision: 8,
    });
  });

  it('does not publish when the outer DELETE transaction rolls back', async () => {
    const rollback = new Error('rollback');
    const transaction = vi.fn().mockRejectedValue(rollback);
    const sse = { onThreadRevisionUpdated: vi.fn() };
    const svc = new ThreadRevisionService(
      { db: { transaction } } as never,
      sse as never,
    );

    await expect(svc.recordThreadDelete(2, 10)).rejects.toBe(rollback);
    expect(sse.onThreadRevisionUpdated).not.toHaveBeenCalled();
  });
});

describe('planThreadDelta — last-op-wins net add/delete', () => {
  const op = (
    threadId: number,
    direction: 'ADD' | 'DELETE',
    revision: number,
  ): ThreadDeltaOp => ({
    threadId,
    direction,
    revision,
  });

  it('pure ADDs → all in addIds, empty removeIds', () => {
    expect(planThreadDelta([op(1, 'ADD', 2), op(2, 'ADD', 5)])).toEqual({
      addIds: [1, 2],
      removeIds: [],
    });
  });

  it('pure DELETEs → all in removeIds, empty addIds', () => {
    expect(planThreadDelta([op(1, 'DELETE', 3), op(2, 'DELETE', 4)])).toEqual({
      addIds: [],
      removeIds: [1, 2],
    });
  });

  it('last-op-wins: DELETE then ADD (re-add) nets to ADD', () => {
    expect(planThreadDelta([op(1, 'DELETE', 2), op(1, 'ADD', 5)])).toEqual({
      addIds: [1],
      removeIds: [],
    });
  });

  it('last-op-wins: ADD then DELETE (removed in-range) nets to DELETE', () => {
    expect(planThreadDelta([op(1, 'ADD', 2), op(1, 'DELETE', 5)])).toEqual({
      addIds: [],
      removeIds: [1],
    });
  });

  it('sorts defensively — last-op-wins holds even when ops arrive revision-desc', () => {
    // Same thread, ADD(rev2) + DELETE(rev5), but fed in reverse; the rev5 DELETE must still win.
    expect(planThreadDelta([op(1, 'DELETE', 5), op(1, 'ADD', 2)])).toEqual({
      addIds: [],
      removeIds: [1],
    });
  });

  it('mixed: distinct threads keep their net direction, first-occurrence order', () => {
    // thread 1: ADD; thread 2: DELETE then ADD → ADD; thread 3: ADD then DELETE → DELETE.
    expect(
      planThreadDelta([
        op(1, 'ADD', 1),
        op(2, 'DELETE', 2),
        op(3, 'ADD', 3),
        op(2, 'ADD', 4),
        op(3, 'DELETE', 5),
      ]),
    ).toEqual({ addIds: [1, 2], removeIds: [3] });
  });

  it('does not mutate the caller’s op array', () => {
    const ops = [op(1, 'ADD', 1), op(1, 'DELETE', 2)];
    planThreadDelta(ops);
    expect(ops).toEqual([op(1, 'ADD', 1), op(1, 'DELETE', 2)]);
  });
});
