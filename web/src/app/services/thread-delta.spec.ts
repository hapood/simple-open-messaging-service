import { planDelta, ThreadDeltaOp } from './thread-delta';

/**
 * planDelta unit tests — the pure merge core of the THREAD_REVISION_UPDATED flow.
 *
 * The backend's /user/query-thread/delta returns `{ threadId, direction: 'ADD'|'DELETE', revision }[]`
 * ordered by revision asc over the half-open range (cursor, toRevision]. planDelta turns that flat op
 * list into a plan: which threads to remove locally (DELETE was the net outcome), which to fetch +
 * insert (ADD was the net outcome), and the new cursor (always toRevision). "Last op wins" per thread
 * — so a re-add (DELETE then ADD) nets to ADD, and an add-then-remove nets to DELETE.
 *
 * Pure: no Angular surface (mirrors merge-items / date-format specs). The apply side (removeThread /
 * upsertThread / cursor advance) lives in ConversationListService and is exercised end-to-end.
 */
describe('planDelta', () => {
  const op = (threadId: number, direction: 'ADD' | 'DELETE', revision: number): ThreadDeltaOp => ({
    threadId,
    direction,
    revision,
  });

  it('nextCursor is always toRevision (the delta covered (cursor, toRevision])', () => {
    expect(planDelta(5, 10, []).nextCursor).toBe(10);
    expect(planDelta(5, 10, [op(1, 'ADD', 7)]).nextCursor).toBe(10);
    expect(planDelta(0, 3, [op(1, 'DELETE', 1), op(2, 'ADD', 2)]).nextCursor).toBe(3);
  });

  it('empty ops → no removes, no adds (a no-op signal, e.g. our own action echoed back)', () => {
    expect(planDelta(5, 8, [])).toEqual({ removeIds: [], addIds: [], nextCursor: 8 });
  });

  it('a single ADD → addIds has it, no removes', () => {
    expect(planDelta(0, 5, [op(7, 'ADD', 3)])).toEqual({ removeIds: [], addIds: [7], nextCursor: 5 });
  });

  it('a single DELETE → removeIds has it, no adds', () => {
    expect(planDelta(0, 5, [op(7, 'DELETE', 3)])).toEqual({ removeIds: [7], addIds: [], nextCursor: 5 });
  });

  it('mixed ADD + DELETE on different threads → each routed to its list', () => {
    const plan = planDelta(0, 5, [op(1, 'ADD', 2), op(2, 'DELETE', 3), op(3, 'ADD', 4)]);
    expect(plan.addIds.sort()).toEqual([1, 3]);
    expect(plan.removeIds).toEqual([2]);
    expect(plan.nextCursor).toBe(5);
  });

  it('re-add within the range (DELETE then ADD) nets to ADD → fetched, not removed', () => {
    // Thread 9 deleted at R2, re-added at R4 — net ADD (it should be present after the range).
    const plan = planDelta(0, 5, [op(9, 'DELETE', 2), op(9, 'ADD', 4)]);
    expect(plan.addIds).toEqual([9]);
    expect(plan.removeIds).toEqual([]);
  });

  it('add-then-remove within the range (ADD then DELETE) nets to DELETE → removed, not fetched', () => {
    // Thread 9 added at R2 then deleted at R4 — net DELETE (absent after the range).
    const plan = planDelta(0, 5, [op(9, 'ADD', 2), op(9, 'DELETE', 4)]);
    expect(plan.removeIds).toEqual([9]);
    expect(plan.addIds).toEqual([]);
  });

  it('handles out-of-order input (sorts by revision so the highest-revision op wins)', () => {
    // Same re-add as above but ops arrive ADD@4-first, DELETE@2-second (a contract violation). After
    // sorting by revision, ADD@4 (higher) wins → net ADD.
    const plan = planDelta(0, 5, [op(9, 'ADD', 4), op(9, 'DELETE', 2)]);
    expect(plan.addIds).toEqual([9]);
    expect(plan.removeIds).toEqual([]);
  });

  it('does not mutate the input ops array', () => {
    const ops = [op(1, 'ADD', 2), op(2, 'DELETE', 3)];
    planDelta(0, 5, ops);
    expect(ops).toEqual([op(1, 'ADD', 2), op(2, 'DELETE', 3)]);
    expect(ops[0].revision).toBe(2);
    expect(ops[1].revision).toBe(3);
  });

  it('dedupes a thread repeated with the same direction (one entry, not duplicated)', () => {
    // Two ADDs for the same thread in the range (shouldn't happen, but be safe) → a single addId.
    const plan = planDelta(0, 5, [op(1, 'ADD', 2), op(1, 'ADD', 3)]);
    expect(plan.addIds).toEqual([1]);
  });

  it('nextCursor advances past the cursor even when toRevision equals cursor (already-applied signal)', () => {
    // A signal whose revision is <= cursor is dropped by pullDelta before planning, but planDelta
    // itself still reports nextCursor = toRevision faithfully.
    expect(planDelta(7, 7, []).nextCursor).toBe(7);
  });
});
