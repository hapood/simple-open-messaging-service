import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

export const UPLOAD_IDLE_TIMEOUT_MS = 30_000;

/** Task ownership only; each execution registration has a distinct in-memory handle. */
export interface UploadActivityTask {
  taskId: string;
  userId: number;
}

export interface UploadActivityHandle {
  readonly task: Readonly<UploadActivityTask>;
}

export interface UploadReceiveHandle {
  readonly upload: UploadActivityHandle;
}

export interface UploadActivityTimeout {
  readonly task: Readonly<UploadActivityTask>;
  /** Recheck inside the domain's lock, immediately before applying the failure. */
  isCurrent(): boolean;
}

type TimeoutCallback = (timeout: UploadActivityTimeout) => void | Promise<void>;
type Mode = 'waiting' | 'receiving' | 'processing' | 'suspended' | 'expired';
interface Entry {
  handle: UploadActivityHandle;
  onTimeout: TimeoutCallback;
  mode: Mode;
  deadline: number;
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  receive?: UploadReceiveHandle;
  receiveProgress?: boolean;
  cancelReceive?: (reason: 'idle' | 'stopped') => void;
}

/** Single-process transport liveness only; domain state changes belong to the callback's locks. */
@Injectable()
export class UploadActivityService implements OnApplicationShutdown {
  private readonly logger = new Logger(UploadActivityService.name);
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  /** Register a new waiting attempt. Re-observing it (including recovery scans) never renews it. */
  watch(
    task: UploadActivityTask,
    onTimeout: TimeoutCallback,
  ): UploadActivityHandle {
    const existing = this.entries.get(task.taskId);
    if (existing && this.sameTask(existing.handle.task, task))
      return existing.handle;
    if (existing) this.stop(existing.handle);
    const handle = { task: Object.freeze({ ...task }) };
    if (this.closed) return handle;
    const entry: Entry = {
      handle,
      onTimeout,
      mode: 'waiting',
      deadline: performance.now() + UPLOAD_IDLE_TIMEOUT_MS,
      generation: 0,
    };
    this.entries.set(task.taskId, entry);
    this.arm(entry);
    return handle;
  }

  /** Validate a parsed body's lease under the domain lock, before accepting its bytes. */
  isCurrent(handle: UploadActivityHandle): boolean {
    const entry = this.current(handle);
    return !!entry && entry.mode !== 'expired';
  }

  /** Resume after domain processing. Already-waiting uploads are not refreshed by polling. */
  waiting(handle: UploadActivityHandle): void {
    const entry = this.current(handle);
    if (
      !entry ||
      entry.mode === 'expired' ||
      entry.mode === 'waiting' ||
      entry.mode === 'receiving'
    )
      return;
    entry.mode = 'waiting';
    entry.deadline = performance.now() + UPLOAD_IDLE_TIMEOUT_MS;
    this.arm(entry);
  }

  /** Must be called only AFTER authenticating both the session and the upload owner. */
  beginReceiving(
    handle: UploadActivityHandle,
    cancelReceive: (reason: 'idle' | 'stopped') => void,
  ): UploadReceiveHandle | undefined {
    const entry = this.current(handle);
    if (!entry || entry.mode !== 'waiting' || entry.receive) return;
    // Headers alone are not progress, even if they arrive just before expiry.
    if (performance.now() >= entry.deadline) {
      this.expire(entry);
      return;
    }
    const receive = { upload: entry.handle };
    entry.receive = receive;
    entry.receiveProgress = false;
    entry.cancelReceive = cancelReceive;
    entry.mode = 'receiving';
    return receive;
  }

  activity(receive: UploadReceiveHandle, bytes: number): void {
    const entry = this.receiving(receive);
    if (
      !entry ||
      entry.mode !== 'receiving' ||
      !Number.isFinite(bytes) ||
      bytes <= 0
    )
      return;
    // An event delayed past the deadline cannot resurrect an already idle attempt.
    if (performance.now() >= entry.deadline) {
      this.expire(entry);
      return;
    }
    entry.receiveProgress = true;
    entry.deadline = performance.now() + UPLOAD_IDLE_TIMEOUT_MS;
    this.arm(entry);
  }

  /** EOF hands ownership to server processing before the parser invokes the HTTP handler. */
  endReceiving(receive: UploadReceiveHandle): void {
    const entry = this.receiving(receive);
    if (!entry || entry.mode !== 'receiving') return;
    if (performance.now() >= entry.deadline) {
      this.expire(entry);
      return;
    }
    this.clearTimer(entry);
    entry.mode = 'processing';
  }

  /** On response or disconnect. Incomplete bodies retain the last byte's original deadline. */
  releaseReceiving(receive: UploadReceiveHandle): void {
    const entry = this.receiving(receive);
    if (!entry) return;
    entry.receive = undefined;
    entry.cancelReceive = undefined;
    if (entry.mode === 'receiving') {
      entry.mode = 'waiting';
      this.arm(entry);
    } else if (entry.mode === 'processing') {
      // Empty bodies are not progress and cannot keep an upload alive through repeated requests.
      if (entry.receiveProgress)
        entry.deadline = performance.now() + UPLOAD_IDLE_TIMEOUT_MS;
      entry.mode = 'waiting';
      this.arm(entry);
    }
    entry.receiveProgress = undefined;
  }

  /** Disable network-idle failure for server-owned processing/commit, invalidating queued expiry. */
  suspend(handle: UploadActivityHandle): void {
    const entry = this.current(handle);
    if (!entry) return;
    this.clearTimer(entry);
    entry.mode = 'suspended';
  }

  /** Identity-safe: a stale attempt cannot stop its replacement. Cancels any old body receiver. */
  stop(handle: UploadActivityHandle): void {
    const entry = this.current(handle);
    if (!entry) return;
    this.entries.delete(handle.task.taskId);
    this.clearTimer(entry);
    entry.cancelReceive?.('stopped');
  }

  onApplicationShutdown(): void {
    this.closed = true;
    for (const entry of this.entries.values()) this.stop(entry.handle);
  }

  private sameTask(
    a: Readonly<UploadActivityTask>,
    b: UploadActivityTask,
  ): boolean {
    return a.taskId === b.taskId && a.userId === b.userId;
  }

  private current(handle: UploadActivityHandle): Entry | undefined {
    const entry = this.entries.get(handle.task.taskId);
    return entry?.handle === handle ? entry : undefined;
  }

  private receiving(receive: UploadReceiveHandle): Entry | undefined {
    const entry = this.current(receive.upload);
    return entry?.receive === receive ? entry : undefined;
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.generation++;
  }

  private arm(entry: Entry): void {
    this.clearTimer(entry);
    const generation = entry.generation;
    entry.timer = setTimeout(
      () => {
        if (
          this.current(entry.handle) !== entry ||
          entry.generation !== generation
        )
          return;
        if (performance.now() < entry.deadline) return this.arm(entry);
        this.expire(entry);
      },
      Math.max(0, entry.deadline - performance.now()),
    );
    entry.timer.unref?.();
  }

  private expire(entry: Entry): void {
    if (entry.mode !== 'waiting' && entry.mode !== 'receiving') return;
    this.clearTimer(entry);
    entry.mode = 'expired';
    const generation = entry.generation;
    entry.cancelReceive?.('idle');
    const timeout: UploadActivityTimeout = {
      task: entry.handle.task,
      isCurrent: () =>
        this.current(entry.handle) === entry &&
        entry.generation === generation &&
        entry.mode === 'expired',
    };
    // Consume callback failures; the domain owns persistence/recovery, not an unhandled rejection.
    void Promise.resolve()
      .then(() => {
        if (timeout.isCurrent()) return entry.onTimeout(timeout);
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Upload idle failure callback failed: ${String(error)}`,
        );
      });
  }
}
