import { FederationSchedulerMutex } from './federation-scheduler-mutex.js';

export type FederationThreadDirection =
  | 'message'
  | 'reverse'
  | 'tombstone'
  | 'meta';

export interface FederationThreadTask {
  readonly threadId: number;
  readonly namespaceId: number;
  readonly direction: FederationThreadDirection;
  readonly dirty: boolean;
  readonly signal: AbortSignal;
}

interface Task {
  threadId: number;
  namespaceId: number;
  direction: FederationThreadDirection;
  controller: AbortController;
  active: boolean;
}

export interface FederationThreadTaskDriver {
  allows(namespaceId: number): boolean;
  execute(task: FederationThreadTask): Promise<boolean>;
  failed(task: FederationThreadTask, error: unknown): Promise<void>;
}

/** One thread index; source lookup is linear within a thread. No retry clocks or cursors. */
export class FederationThreadTaskQueue {
  private readonly mutex = new FederationSchedulerMutex();
  private readonly threads = new Map<number, Task[]>();
  private readonly dirty = new Map<Task, true>();
  // Cancelled workers retain their physical slots until they settle. This also
  // prevents restored message tasks from overlapping an old thread transaction.
  private readonly running = new Set<Task>();
  private readonly executions = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly driver: FederationThreadTaskDriver,
    private readonly limits: Readonly<
      Record<FederationThreadDirection, number>
    >,
  ) {}

  async wake(
    threadId: number,
    namespaceId: number,
    direction: FederationThreadDirection,
    dirty: boolean,
  ): Promise<void> {
    const selected = await this.mutex.runExclusive(() => {
      if (this.stopped || !this.driver.allows(namespaceId)) return [];
      let tasks = this.threads.get(threadId);
      if (!tasks) {
        tasks = [];
        this.threads.set(threadId, tasks);
      }
      let task = tasks.find(
        (item) =>
          item.namespaceId === namespaceId && item.direction === direction,
      );
      if (!task) {
        task = {
          threadId,
          namespaceId,
          direction,
          controller: new AbortController(),
          active: false,
        };
        tasks.push(task);
      }
      if (dirty) this.dirty.set(task, true);
      return this.select();
    });
    this.launch(selected);
  }

  async cancelNamespace(namespaceId: number): Promise<void> {
    await this.cancel((task) => task.namespaceId === namespaceId);
  }

  async cancelSource(threadId: number, namespaceId: number): Promise<void> {
    await this.cancel(
      (task) => task.threadId === threadId && task.namespaceId === namespaceId,
    );
  }

  async shutdown(): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.stopped = true;
    });
    await this.cancel(() => true);
    await Promise.allSettled([...this.executions]);
  }

  private async cancel(matches: (task: Task) => boolean): Promise<void> {
    const cancelled = await this.mutex.runExclusive(() => {
      const tasks = this.allTasks().filter(matches);
      for (const task of tasks) this.remove(task);
      return tasks;
    });
    // Abort listeners may call back into the scheduler; never run them under its lock.
    for (const task of cancelled) task.controller.abort();
  }

  private allTasks(): Task[] {
    return [...this.threads.values()].flat();
  }

  private isCurrent(task: Task): boolean {
    return this.threads.get(task.threadId)?.includes(task) === true;
  }

  private remove(task: Task): void {
    this.dirty.delete(task);
    const tasks = this.threads.get(task.threadId);
    if (!tasks) return;
    const index = tasks.indexOf(task);
    if (index < 0) return;
    tasks.splice(index, 1);
    if (tasks.length === 0) this.threads.delete(task.threadId);
  }

  private ready(task: Task): boolean {
    if (task.active || !this.driver.allows(task.namespaceId)) return false;
    let active = 0;
    for (const running of this.running) {
      if (running.direction === task.direction) active += 1;
      if (
        running.threadId === task.threadId &&
        (running.direction === 'message' || running.direction === 'reverse') &&
        (task.direction === 'message' || task.direction === 'reverse')
      )
        return false;
    }
    return active < this.limits[task.direction];
  }

  private select(): { task: Task; dirty: boolean }[] {
    const selected: { task: Task; dirty: boolean }[] = [];
    if (this.stopped) return selected;
    for (;;) {
      let next = [...this.dirty.keys()].find((task) => this.ready(task));
      if (!next) {
        const ready = this.allTasks().filter((task) => this.ready(task));
        if (ready.length === 0) return selected;
        next = ready[Math.floor(Math.random() * ready.length)];
      }
      next.active = true;
      this.running.add(next);
      selected.push({ task: next, dirty: this.dirty.delete(next) });
    }
  }

  private launch(selected: { task: Task; dirty: boolean }[]): void {
    for (const { task, dirty } of selected) {
      const request: FederationThreadTask = {
        threadId: task.threadId,
        namespaceId: task.namespaceId,
        direction: task.direction,
        dirty,
        signal: task.controller.signal,
      };
      // Defer execution until the promise is registered, even if the driver throws synchronously.
      const execution = Promise.resolve().then(async () => {
        let continuation = false;
        let succeeded = false;
        try {
          request.signal.throwIfAborted();
          // Selection and execution are separate microtasks. A pause can close
          // admission between them, before the cancellation listener takes the lock.
          if (!this.driver.allows(request.namespaceId)) return;
          continuation = await this.driver.execute(request);
          succeeded = true;
        } catch (error) {
          if (!request.signal.aborted) await this.driver.failed(request, error);
        } finally {
          const next = await this.mutex.runExclusive(() => {
            this.running.delete(task);
            task.active = false;
            if (this.isCurrent(task)) {
              if (!succeeded || (!continuation && !this.dirty.has(task)))
                this.remove(task);
            }
            return this.select();
          });
          this.launch(next);
        }
      });
      this.executions.add(execution);
      // A failure handler must report its own errors. Always observe its rejection
      // while retaining queue cleanup in the execution's finally block.
      void execution
        .finally(() => this.executions.delete(execution))
        .catch(() => {});
    }
  }
}
