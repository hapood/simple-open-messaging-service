/**
 * Pure thread-list delta planning — the testable core of the THREAD_REVISION_UPDATED flow.
 *
 * The backend pushes `THREAD_REVISION_UPDATED { revision }` on every thread add/delete (friend approve,
 * group create/join, leave, kick, unfriend). The client pulls the ranged delta
 * `(cursor, toRevision]` via `POST /user/query-thread/delta` and applies it. This module turns a flat
 * op list into a concrete plan: which threadIds to remove locally (DELETE), which to fetch + insert
 * (ADD), and the new cursor.
 *
 * Extracted from ConversationListService so the merge semantics are unit-testable with no Angular
 * surface (mirrors merge-items / date-format pure-function specs).
 */

/** A single thread-list ADD/DELETE operation — the item shape returned by /user/query-thread/delta. */
export type ThreadDeltaOp = {
  threadId: number;
  direction: 'ADD' | 'DELETE';
  revision: number;
};

/** The client's plan for applying a delta batch. */
export type ThreadDeltaPlan = {
  /** Threads to drop from the local list (a DELETE was the net outcome for them in this range). */
  removeIds: number[];
  /** Threads to fetch (getThreadInfo) + insert/refresh (an ADD was the net outcome). */
  addIds: number[];
  /** The new cursor — always `toRevision` (the delta covered `(cursor, toRevision]`, so after applying
   *  it the client is caught up to `toRevision` regardless of how many ops matched). */
  nextCursor: number;
};

/**
 * Plan the application of a delta batch. `ops` MUST be ordered by `revision` ascending (the backend's
 * `queryDelta` returns them so). For each thread, the LAST op in the range wins — so a re-add
 * (DELETE then ADD in-range) nets to ADD, and an add-then-remove (ADD then DELETE) nets to DELETE.
 * A thread that nets to its prior state (e.g. ADD then DELETE within one batch, when it was absent
 * before) lands in neither list only when fully cancelled; otherwise the idempotent apply
 * (removeThread / upsertThread) makes a redundant op a no-op.
 *
 * Pure: no Angular deps, no I/O. Deterministic — Map iteration preserves first-occurrence order, so
 * `removeIds`/`addIds` are stable for a given input (useful for tests + reproducible fetch order).
 */
export function planDelta(cursor: number, toRevision: number, ops: ThreadDeltaOp[]): ThreadDeltaPlan {
  // Walk ops in revision-asc order; the last direction seen for a thread is its net state in this
  // range. Sort defensively (the backend's queryDelta returns revision-asc, but sorting here makes
  // "highest-revision wins" hold even if a caller violates that contract). `[...ops]` avoids mutating
  // the caller's array; V8's stable sort keeps same-revision ops in input order.
  const sorted = [...ops].sort((a, b) => a.revision - b.revision);
  const net = new Map<number, 'ADD' | 'DELETE'>();
  for (const op of sorted) net.set(op.threadId, op.direction);

  const removeIds: number[] = [];
  const addIds: number[] = [];
  for (const [threadId, dir] of net) {
    if (dir === 'DELETE') removeIds.push(threadId);
    else addIds.push(threadId);
  }
  return { removeIds, addIds, nextCursor: toRevision };
}
