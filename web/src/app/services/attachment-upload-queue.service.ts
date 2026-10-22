import { inject, Injectable, signal } from '@angular/core';
import { PreferenceStore } from './preference-store.service';

const STORAGE_KEY = 'soms.maxConcurrentUploads';
const DEFAULT_MAX_CONCURRENT = 3;
const MIN_MAX_CONCURRENT = 1;
const MAX_MAX_CONCURRENT = 8;

export const UPLOAD_CONCURRENCY_OPTIONS = [1, 2, 3, 4, 6, 8] as const;

interface UploadJob {
  threadId: number;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * App-wide attachment scheduler. A thread may run at most one attachment upload at a time, preserving
 * the order shown in its aggregate send box. Different threads share the user-configurable global slots.
 * Audio/voice uploads do not use this scheduler.
 */
@Injectable({ providedIn: 'root' })
export class AttachmentUploadQueueService {
  private readonly preferences = inject(PreferenceStore);
  private writeRevision = 0;
  private readonly pending: UploadJob[] = [];
  private readonly activeThreads = new Set<number>();
  private active = 0;
  private readonly _maxConcurrent = signal(DEFAULT_MAX_CONCURRENT);

  readonly maxConcurrent = this._maxConcurrent.asReadonly();

  constructor() {
    void this.restore();
  }

  enqueue(threadId: number, run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ threadId, run, resolve, reject });
      this.pump();
    });
  }

  setMaxConcurrent(value: number): void {
    this.writeRevision++;
    const normalized = this.normalize(value);
    this._maxConcurrent.set(normalized);
    void this.preferences.set('device', STORAGE_KEY, normalized).catch(() => {});
    this.pump();
  }

  private pump(): void {
    while (this.active < this._maxConcurrent()) {
      const index = this.pending.findIndex(
        (job) => !this.activeThreads.has(job.threadId),
      );
      if (index < 0) return;
      const [job] = this.pending.splice(index, 1);
      this.active++;
      this.activeThreads.add(job.threadId);
      void Promise.resolve()
        .then(job.run)
        .finally(() => {
          this.active--;
          this.activeThreads.delete(job.threadId);
          this.pump();
        })
        .then(job.resolve, job.reject);
    }
  }

  private async restore(): Promise<void> {
    const revision = this.writeRevision;
    const value = await this.preferences.get<number>('device', STORAGE_KEY);
    if (revision !== this.writeRevision) return;
    if (typeof value === 'number') this._maxConcurrent.set(this.normalize(value));
  }

  private normalize(value: number): number {
    if (!Number.isFinite(value) || value < MIN_MAX_CONCURRENT)
      return DEFAULT_MAX_CONCURRENT;
    return Math.min(MAX_MAX_CONCURRENT, Math.floor(value));
  }
}
