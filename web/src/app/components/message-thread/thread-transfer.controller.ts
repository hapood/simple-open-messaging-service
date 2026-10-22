import { computed } from '@angular/core';
import {
  categorizeFilename,
  fileExt,
  type FileCategory,
} from '../message-cards/file-meta.util';
import type { MediaTransferService } from '../../services/media-transfer.service';

/** Owns the thread-scoped transfer projection and its retry/cancel actions. */
export class ThreadTransferController {
  readonly uploading = computed(() =>
    this.threadTasks().filter((task) => task.status === 'uploading'),
  );
  readonly sending = computed(() =>
    this.threadTasks().filter((task) => task.status === 'uploading'),
  );
  readonly failed = computed(() =>
    this.threadTasks().filter((task) => task.status === 'failed'),
  );
  readonly retryableFailed = computed(() =>
    this.failed().filter((task) => task.retryable !== false),
  );
  readonly currentUploadingId = computed(() => {
    const tasks = this.sending();
    const active = tasks.find(
      (task) => task.loaded > 0 && task.loaded < task.size,
    );
    return active?.clientMessageId ?? tasks[0]?.clientMessageId ?? null;
  });
  readonly displayedSending = computed(() => {
    const tasks = this.sending();
    const currentId = this.currentUploadingId();
    if (!currentId) return tasks;
    const current = tasks.find((task) => task.clientMessageId === currentId);
    return current
      ? [current, ...tasks.filter((task) => task.clientMessageId !== currentId)]
      : tasks;
  });
  readonly countLabel = computed(() => String(this.sending().length));

  constructor(
    private readonly transfers: MediaTransferService,
    private readonly threadId: () => number | undefined,
  ) {}

  extension(name: string): string {
    return fileExt(name);
  }

  category(name: string): FileCategory {
    return categorizeFilename(name);
  }

  progress(loaded: number, size: number): number {
    return size > 0
      ? Math.min(100, Math.max(0, Math.round((loaded / size) * 100)))
      : 0;
  }

  cancelUploading(): void {
    for (const task of this.uploading())
      this.transfers.discard(task.clientMessageId);
  }

  retryFailed(): void {
    for (const task of this.retryableFailed())
      this.transfers.retry(task.clientMessageId);
  }

  cancelFailed(): void {
    for (const task of this.failed())
      this.transfers.discard(task.clientMessageId);
  }

  private threadTasks() {
    const threadId = this.threadId();
    return this.transfers
      .tasks()
      .filter((task) => task.threadId === threadId && task.kind !== 'audio');
  }
}
