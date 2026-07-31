import { describe, it, expect, vi } from 'vitest';

import { ThreadRevisionService } from './thread-revision.service.js';
import { planThreadDelta, type ThreadDeltaOp } from './thread-delta.js';

/** Hand-rolled Prisma fake (the project's spec style — direct construction, not the Nest DI container).
 *  Only `threadRevision.findMany` is exercised by the read path under test (queryDelta);
 *  `user.update` / `sse` are inert stubs for the write paths. The findMany fake HONORS the `revision`
 *  filter (lte/gt) from the query args so queryDelta behaves as it would against a real DB. */
function makeService(
  rows: Array<{
    threadId: number;
    direction: 'ADD' | 'DELETE';
    revision: number;
  }>,
) {
  const findMany = vi.fn(
    async (args: {
      where: { userId: number; revision?: { lte?: number; gt?: number } };
    }) => {
      const rev = args.where.revision;
      return rows.filter((r) => {
        let ok = true;
        if (rev?.lte !== undefined) ok = ok && r.revision <= rev.lte;
        if (rev?.gt !== undefined) ok = ok && r.revision > rev.gt;
        return ok;
      });
    },
  );
  const prisma = {
    threadRevision: { findMany },
    user: {
      update: vi.fn(
        async (args: {
          where: { id: number };
          data: { threadRevision: { increment: number } };
        }) => ({
          threadRevision: 0, // unused by the read paths
          ...args,
        }),
      ),
    },
  };
  const sse = { onThreadRevisionUpdated: vi.fn() };
  const svc = new ThreadRevisionService(prisma as never, sse as never);
  return { svc, findMany };
}

describe('ThreadRevisionService.queryDelta — (from excl, to incl]', () => {
  it('returns ADD/DELETE rows with revision in (from, to], ordered ascending', async () => {
    const rows = [
      { threadId: 10, direction: 'ADD' as const, revision: 2 },
      { threadId: 20, direction: 'DELETE' as const, revision: 4 },
      { threadId: 30, direction: 'ADD' as const, revision: 5 },
    ];
    const { svc, findMany } = makeService(rows);
    const out = await svc.queryDelta(1, 1, 5);
    expect(out).toEqual(rows);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 1, revision: { gt: 1, lte: 5 } },
      orderBy: { revision: 'asc' },
      select: { threadId: true, direction: true, revision: true },
    });
  });

  it('from==to yields an empty half-open window (nothing > from AND <= from)', async () => {
    const { svc, findMany } = makeService([
      { threadId: 10, direction: 'ADD', revision: 3 },
    ]);
    const out = await svc.queryDelta(1, 3, 3);
    expect(out).toEqual([]); // the mock returns rows, but the WHERE encodes the empty window
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 1, revision: { gt: 3, lte: 3 } },
      orderBy: { revision: 'asc' },
      select: { threadId: true, direction: true, revision: true },
    });
  });
});

describe('ThreadRevisionService hidden-thread restoration', () => {
  it('re-adds only active recipients whose current ADD row is marked deleted', async () => {
    const findMany = vi.fn().mockResolvedValue([{ userId: 2 }]);
    const svc = new ThreadRevisionService(
      { threadRevision: { findMany } } as never,
      {} as never,
    );
    const recordAdd = vi
      .spyOn(svc, 'recordThreadAdd')
      .mockResolvedValue(undefined);

    await svc.restoreHiddenThreads(10, [1, 2, 3]);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        threadId: 10,
        userId: { in: [1, 2, 3] },
        direction: 'ADD',
        isDelete: true,
      },
      select: { userId: true },
    });
    expect(recordAdd).toHaveBeenCalledTimes(1);
    expect(recordAdd).toHaveBeenCalledWith(2, 10);
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
