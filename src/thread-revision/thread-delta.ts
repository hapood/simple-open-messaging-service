/**
 * Pure thread-list delta planning — the testable core that turns a flat ADD/DELETE op log into a concrete
 * apply plan. Lives server-side now (the {@link queryThreadDelta} route plans + hydrates in one response),
 * replacing the former client-side planner: the server is authoritative on last-op-wins, and ships the
 * hydrated ADD items inline so the client applies a single response (no second batch-hydrate round-trip).
 *
 * The backend pushes `THREAD_REVISION_UPDATED { threadRevision }` on every thread add/delete (friend approve,
 * group create/join, leave, kick, unfriend). The client pulls the ranged delta `(cursor, toRevision]` via
 * `POST /user/query-thread/delta`; this module plans that flat op list into the threads to hydrate+insert
 * (ADD) vs. drop locally (DELETE).
 */

/** A single thread-list ADD/DELETE operation — the row shape read from the ThreadRevision op-log. */
export type ThreadDeltaOp = {
  threadId: number;
  direction: 'ADD' | 'DELETE';
  revision: number;
};

/** The server's plan for a delta batch: which threads to hydrate + return (ADD), which to drop (DELETE). */
export type ThreadDeltaPlan = {
  /** Threads whose net outcome in this range is ADD → hydrate + return so the client inserts/refreshes them. */
  addIds: number[];
  /** Threads whose net outcome is DELETE → return id-only (no info; the thread is leaving the roster). */
  removeIds: number[];
};

/**
 * Plan a delta batch. `ops` SHOULD be ordered by `revision` ascending (the op-log `queryDelta` returns them
 * so); a defensive sort makes "highest-revision wins" hold even if a caller violates that contract. For each
 * thread the LAST op in the range wins — so a re-add (DELETE then ADD in-range) nets to ADD, and an
 * add-then-remove (ADD then DELETE) nets to DELETE. A thread that fully cancels (ADD then DELETE when absent
 * before) nets to DELETE and is removed by the client's idempotent `removeThread`.
 *
 * Pure: no NestJS / database deps, no I/O. Deterministic — Map iteration preserves first-occurrence order, so
 * `addIds`/`removeIds` are stable for a given input (useful for tests + a reproducible hydrate order).
 */
export function planThreadDelta(ops: ThreadDeltaOp[]): ThreadDeltaPlan {
  // `[...ops]` avoids mutating the caller's array; V8's stable sort keeps same-revision ops in input order.
  const sorted = [...ops].sort((a, b) => a.revision - b.revision);
  const net = new Map<number, 'ADD' | 'DELETE'>();
  for (const op of sorted) net.set(op.threadId, op.direction);

  const addIds: number[] = [];
  const removeIds: number[] = [];
  for (const [threadId, dir] of net) {
    if (dir === 'DELETE') removeIds.push(threadId);
    else addIds.push(threadId);
  }
  return { addIds, removeIds };
}
