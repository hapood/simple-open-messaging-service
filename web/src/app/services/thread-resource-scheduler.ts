export const TOMB_SCHEDULER_CONCURRENCY = 4;
export const META_SCHEDULER_CONCURRENCY = 2;
const MAX_RETRY_DELAY_MS = 30_000;
const BASE_RETRY_DELAY_MS = 1_000;

export type TombRoundOutcome =
  | { status: 'DONE' }
  | { status: 'MORE' }
  | { status: 'CUTOFF_STALLED'; target: number; cutoff: number };
export type MetaRoundOutcome = { status: 'DONE' | 'MORE' };
export interface TombProgressSnapshot {
  target: number;
  hwm: number;
  cutoff: number;
}
interface LaneEntry {
  running: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempts: number;
  stalledAt?: { target: number; cutoff: number };
}
export interface ThreadResourceSchedulerDeps {
  runTombPage: (threadId: number) => Promise<TombRoundOutcome>;
  runMetaPage: (threadId: number) => Promise<MetaRoundOutcome>;
  readTombProgress: (threadId: number) => Promise<TombProgressSnapshot | null>;
  onError?: (lane: 'tomb' | 'meta', threadId: number, error: unknown) => void;
}
type Lane = 'tomb' | 'meta';

/** Single-login worker-owned tasks. Pending tasks are deduplicated and selected
 * randomly per page, with independent lane admission and bounded retry backoff.
 * A running task may have a pending successor; it cannot run concurrently with it.
 */
export class ThreadResourceScheduler {
  private readonly pending = {
    tomb: new Set<number>(),
    meta: new Set<number>(),
  };
  private readonly entries = {
    tomb: new Map<number, LaneEntry>(),
    meta: new Map<number, LaneEntry>(),
  };
  private readonly active = { tomb: 0, meta: 0 };

  constructor(private readonly deps: ThreadResourceSchedulerDeps) {}

  wakeTomb(threadId: number): void {
    this.enqueue('tomb', threadId);
  }

  wakeMeta(threadId: number): void {
    this.enqueue('meta', threadId);
  }

  private enqueue(lane: Lane, threadId: number): void {
    if (!this.entries[lane].has(threadId)) {
      this.entries[lane].set(threadId, {
        running: false,
        retryTimer: null,
        retryAttempts: 0,
      });
    }
    this.pending[lane].add(threadId);
    this.pump(lane);
  }

  private pump(lane: Lane): void {
    const limit =
      lane === 'tomb' ? TOMB_SCHEDULER_CONCURRENCY : META_SCHEDULER_CONCURRENCY;
    while (this.active[lane] < limit) {
      const ready = [...this.pending[lane]].filter((id) => {
        const entry = this.entries[lane].get(id)!;
        return !entry.running && entry.retryTimer === null;
      });
      if (!ready.length) return;
      const threadId = ready[Math.floor(Math.random() * ready.length)];
      const entry = this.entries[lane].get(threadId)!;
      this.pending[lane].delete(threadId);
      entry.running = true;
      this.active[lane]++;
      void this.run(lane, threadId, entry);
    }
  }

  private async run(
    lane: Lane,
    threadId: number,
    entry: LaneEntry,
  ): Promise<void> {
    try {
      // Check persisted progress on every stalled wake, including cutoff wakes.
      // Unchanged progress must not generate another network request.
      if (lane === 'tomb' && entry.stalledAt) {
        const progress = await this.deps.readTombProgress(threadId);
        if (!progress || progress.hwm >= progress.target) {
          entry.stalledAt = undefined;
          return;
        }
        if (
          progress.target <= entry.stalledAt.target &&
          progress.cutoff <= entry.stalledAt.cutoff
        )
          return;
        entry.stalledAt = undefined;
      }
      const outcome =
        lane === 'tomb'
          ? await this.deps.runTombPage(threadId)
          : await this.deps.runMetaPage(threadId);
      entry.retryAttempts = 0;
      if (outcome.status === 'CUTOFF_STALLED') {
        entry.stalledAt = { target: outcome.target, cutoff: outcome.cutoff };
      } else {
        entry.stalledAt = undefined;
        if (outcome.status === 'MORE') this.pending[lane].add(threadId);
      }
    } catch (error) {
      this.pending[lane].add(threadId);
      entry.retryAttempts++;
      const delay = Math.min(
        MAX_RETRY_DELAY_MS,
        BASE_RETRY_DELAY_MS * 2 ** Math.min(entry.retryAttempts - 1, 5),
      );
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        this.pump(lane);
      }, delay);
      this.deps.onError?.(lane, threadId, error);
    } finally {
      entry.running = false;
      this.active[lane]--;
      // Synchronous retirement preserves any successor enqueued while awaiting
      // storage or HTTP. No separate dirty flag or priority is necessary.
      if (
        !this.pending[lane].has(threadId) &&
        !entry.stalledAt &&
        entry.retryTimer === null
      )
        this.entries[lane].delete(threadId);
      this.pump(lane);
    }
  }
}
