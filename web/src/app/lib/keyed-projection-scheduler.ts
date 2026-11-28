export interface KeyedProjectionSchedulerOptions<Key, Value> {
  read: (key: Key) => Promise<Value | undefined>;
  publish: (key: Key, value: Value) => void;
  onError?: (key: Key, error: unknown) => void;
  concurrency?: number;
}

interface ProjectionLane {
  epoch: number;
  running: boolean;
  dirty: boolean;
  waiters: Array<() => void>;
}

/**
 * Owner-signaled, bounded projection reads. Requests in the same turn coalesce.
 * A request during a read suppresses its result and schedules a fresh read.
 * Undefined results are not published. Callers settle when their lane becomes
 * idle, fails, or is canceled; request promises never reject.
 *
 * A failed read consumes existing trailing demand, but does not create retries.
 * Without trailing demand it stays dirty and parked until another request.
 * Invalidation cancels demand, not the underlying read or its concurrency slot.
 */
export class KeyedProjectionScheduler<Key, Value> {
  private readonly lanes = new Map<Key, ProjectionLane>();
  private readonly pending = new Set<Key>();
  private readonly concurrency: number;
  private active = 0;
  private dispatchScheduled = false;
  private destroyed = false;

  constructor(
    private readonly options: KeyedProjectionSchedulerOptions<Key, Value>,
  ) {
    this.concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new RangeError('concurrency must be a positive safe integer');
    }
  }

  request(key: Key): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { epoch: 0, running: false, dirty: false, waiters: [] };
      this.lanes.set(key, lane);
    }
    lane.dirty = true;
    const completion = new Promise<void>((resolve) =>
      lane.waiters.push(resolve),
    );
    if (!lane.running) this.pending.add(key);
    this.scheduleDispatch();
    return completion;
  }

  invalidate(key: Key): void {
    const lane = this.lanes.get(key);
    if (!lane) return;
    lane.epoch++;
    lane.dirty = false;
    this.pending.delete(key);
    // Keep the running lane as a lock for requests in the new epoch.
    if (!lane.running) this.lanes.delete(key);
    this.settle(lane);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pending.clear();
    for (const lane of this.lanes.values()) this.settle(lane);
    this.lanes.clear();
  }

  private scheduleDispatch(): void {
    if (this.destroyed || this.dispatchScheduled || !this.pending.size) return;
    this.dispatchScheduled = true;
    queueMicrotask(() => {
      this.dispatchScheduled = false;
      while (
        !this.destroyed &&
        this.active < this.concurrency &&
        this.pending.size
      ) {
        const next = this.pending.values().next();
        if (next.done) break;
        const key = next.value;
        this.pending.delete(key);
        const lane = this.lanes.get(key);
        if (!lane) continue;
        lane.running = true;
        lane.dirty = false;
        this.active++;
        void this.run(key, lane);
      }
    });
  }

  private async run(key: Key, lane: ProjectionLane): Promise<void> {
    const epoch = lane.epoch;
    let failed = false;
    let failedWaiters: Array<() => void> = [];
    try {
      const value = await this.options.read(key);
      if (
        !this.destroyed &&
        lane.epoch === epoch &&
        !lane.dirty &&
        value !== undefined
      ) {
        this.options.publish(key, value);
      }
    } catch (error) {
      if (!this.destroyed && lane.epoch === epoch) {
        failed = true;
        // Requests made reentrantly by onError belong to the trailing attempt.
        failedWaiters = lane.waiters;
        lane.waiters = [];
        try {
          this.options.onError?.(key, error);
        } catch {
          // Error observers must not reject the detached worker promise.
        }
      }
    } finally {
      lane.running = false;
      this.active--;
      if (!this.destroyed) {
        if (lane.dirty) {
          this.pending.add(key);
        } else if (failed && lane.epoch === epoch) {
          lane.dirty = true;
        } else {
          // Retire before resolving promises: an immediate awaited successor
          // must create a live lane, not attach to an already finished worker.
          this.lanes.delete(key);
          this.settle(lane);
        }
        this.scheduleDispatch();
      }
      for (const resolve of failedWaiters) resolve();
    }
  }

  private settle(lane: ProjectionLane): void {
    const waiters = lane.waiters;
    lane.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
