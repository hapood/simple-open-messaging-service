import { describe, it, expect, vi } from 'vitest';

import { ThreadRevisionService } from './thread-revision.service.js';

/** Hand-rolled Prisma fake (the project's spec style — direct construction, not the Nest DI container).
 *  Only `threadRevision.findMany` is exercised by the read paths under test (queryDelta /
 *  activeThreadIdsAt); `user.update` / `upsert` / `updateMany` / `sse` are inert stubs for the write
 *  paths. The findMany fake HONORS the `revision` filter (lte/gt) from the query args so the read paths
 *  behave as they would against a real DB (the rows visible to the service depend on R). */
function makeService(rows: Array<{ threadId: number; direction: 'ADD' | 'DELETE'; revision: number }>) {
  const findMany = vi.fn(async (args: {
    where: { userId: number; revision?: { lte?: number; gt?: number } };
  }) => {
    const rev = args.where.revision;
    return rows.filter((r) => {
      let ok = true;
      if (rev?.lte !== undefined) ok = ok && r.revision <= rev.lte;
      if (rev?.gt !== undefined) ok = ok && r.revision > rev.gt;
      return ok;
    });
  });
  const prisma = {
    threadRevision: { findMany },
    user: { update: vi.fn(async (args: { where: { id: number }; data: { threadRevision: { increment: number } } }) => ({
      threadRevision: 0, // unused by the read paths
      ...args,
    })) },
  };
  const sse = { onThreadRevisionUpdated: vi.fn() };
  const svc = new ThreadRevisionService(prisma as never, sse as never);
  return { svc, findMany };
}

describe('ThreadRevisionService.activeThreadIdsAt — historically-accurate snapshot at R', () => {
  // A thread is active at R iff its latest operation with revision ≤ R is an ADD. Uses the revision
  // columns (NOT isDelete) so the snapshot reflects state AS-OF R, not the current soft-delete flag.

  it('a single ADD (rev 1) is active at R≥1 and inactive before it', async () => {
    const { svc } = makeService([{ threadId: 10, direction: 'ADD', revision: 1 }]);
    expect([...(await svc.activeThreadIdsAt(1, 1))]).toEqual([10]);
    expect([...(await svc.activeThreadIdsAt(1, 5))]).toEqual([10]);
    expect([...(await svc.activeThreadIdsAt(1, 0))]).toEqual([]); // before the add
  });

  it('ADD then DELETE: active before the delete, inactive from the delete onward', async () => {
    const { svc } = makeService([
      { threadId: 10, direction: 'ADD', revision: 1 },
      { threadId: 10, direction: 'DELETE', revision: 3 },
    ]);
    expect([...(await svc.activeThreadIdsAt(1, 1))]).toEqual([10]); // added, not yet deleted
    expect([...(await svc.activeThreadIdsAt(1, 2))]).toEqual([10]); // still before the delete
    expect([...(await svc.activeThreadIdsAt(1, 3))]).toEqual([]); // deleted at R=3
    expect([...(await svc.activeThreadIdsAt(1, 9))]).toEqual([]); // stays deleted
  });

  it('re-add (ADD upserted past a prior DELETE): the later ADD wins, active again from the re-add', async () => {
    // ADD rev 1 → DELETE rev 3 → ADD upserted to rev 7 (isDelete=false). The ADD row's revision is now 7.
    const { svc } = makeService([
      { threadId: 10, direction: 'ADD', revision: 7 },
      { threadId: 10, direction: 'DELETE', revision: 3 },
    ]);
    // Before the re-add (R between delete and re-add): latest op ≤ R is the DELETE → inactive.
    expect([...(await svc.activeThreadIdsAt(1, 3))]).toEqual([]);
    expect([...(await svc.activeThreadIdsAt(1, 6))]).toEqual([]);
    // From the re-add onward: latest op ≤ R is the ADD (rev 7) → active.
    expect([...(await svc.activeThreadIdsAt(1, 7))]).toEqual([10]);
    expect([...(await svc.activeThreadIdsAt(1, 9))]).toEqual([10]);
  });

  it('mixes multiple threads, each evaluated independently at R', async () => {
    const { svc } = makeService([
      { threadId: 10, direction: 'ADD', revision: 1 }, // active throughout
      { threadId: 20, direction: 'ADD', revision: 2 },
      { threadId: 20, direction: 'DELETE', revision: 4 }, // gone from R=4
      { threadId: 30, direction: 'ADD', revision: 5 }, // appears at R=5
    ]);
    expect([...(await svc.activeThreadIdsAt(1, 1))].sort()).toEqual([10]);
    expect([...(await svc.activeThreadIdsAt(1, 2))].sort()).toEqual([10, 20]);
    expect([...(await svc.activeThreadIdsAt(1, 3))].sort()).toEqual([10, 20]);
    expect([...(await svc.activeThreadIdsAt(1, 4))].sort()).toEqual([10]); // 20 deleted
    expect([...(await svc.activeThreadIdsAt(1, 5))].sort()).toEqual([10, 30]); // 30 added
  });

  it('returns an empty set when no operations exist at or before R', async () => {
    const { svc } = makeService([{ threadId: 10, direction: 'ADD', revision: 5 }]);
    expect((await svc.activeThreadIdsAt(1, 4)).size).toBe(0);
  });

  it('passes the revision ceiling (lte) to the findMany query', async () => {
    const { svc, findMany } = makeService([]);
    await svc.activeThreadIdsAt(42, 7);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 42, revision: { lte: 7 } },
      select: { threadId: true, direction: true, revision: true },
    });
  });
});

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
