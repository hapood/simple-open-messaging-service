import { Injectable, computed, inject, signal } from '@angular/core';
import { WebdbService } from './webdb.service';
import { BrowserSendFiles } from './browser-send-files.service';
import { isTauri } from './runtime';
import { SessionLifecycleService, type SessionWorkScope } from './session-lifecycle.service';
import type { StoredSendTask } from './send-outbox-storage';

export type PendingSendTask = StoredSendTask;
export type SendPhase = 'sending' | 'failed';

/** History may retire a failed leftover, never an in-flight send. */
export function failedMatchingIntentIds(rows: readonly SendingTask[], messageIds: readonly string[]): string[] {
  const present = new Set(messageIds);
  return rows
    .filter(row => row.execution.phase === 'failed' && present.has(row.task.clientMessageId))
    .map(row => row.task.clientMessageId);
}

export type UploadFailure =
  | { kind: 'interrupted' }
  | { kind: 'attachment-unavailable' }
  | { kind: 'size-limit'; limit: number }
  | { kind: 'transport'; message: string };

export type SendExecution =
  | { kind: 'message'; phase: SendPhase }
  | { kind: 'attachment'; phase: SendPhase; loaded: number; total: number; startedAt: number; failure: UploadFailure | null };

export interface SendingTask {
  readonly task: PendingSendTask;
  readonly execution: SendExecution;
}

function initialExecution(task: PendingSendTask, phase: SendPhase): SendExecution {
  const item = task.item;
  if (!('file' in item) && item.type !== 'GALLERY') return { kind: 'message', phase };
  return { kind: 'attachment', phase, loaded: 0, total: 0, startedAt: 0, failure: phase === 'failed' ? { kind: 'interrupted' } : null };
}

/** Read projection of durable pending intents plus process-local execution state.
 * No rendered cards, attachment ownership callbacks, or independent memory queue live here.
 */
@Injectable({ providedIn: 'root' })
export class ThreadSendOutbox {
  private readonly database = inject(WebdbService);
  private readonly browserFiles = inject(BrowserSendFiles);
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly projection = signal<ReadonlyMap<string, SendingTask>>(new Map());
  readonly tasks = computed(() => [...this.projection().values()]);
  readonly failures = computed(() => this.tasks().filter(row => row.execution.phase === 'failed'));
  readonly uploads = computed(() => this.tasks().filter(row => row.execution.kind === 'attachment'));

  constructor() {
    this.lifecycle.invalidated$.subscribe(() => {
      this.projection.set(new Map());
    });
  }

  forThread(threadId: number): readonly SendingTask[] {
    return this.tasks().filter(row => row.task.threadId === threadId);
  }

  get(clientMessageId: string): SendingTask | undefined {
    return this.projection().get(clientMessageId);
  }

  private restoredScope: SessionWorkScope | null = null;
  private restoring: Promise<void> | null = null;

  /** Existing lifecycle callers serialize database opening/recreation before this call. */
  restore(reset = false): Promise<void> {
    const scope = this.lifecycle.capture();
    if (!reset && this.restoredScope === scope) return this.restoring ?? Promise.resolve();
    this.restoredScope = scope;
    const pending = this.loadProjection(scope, reset);
    this.restoring = pending;
    void pending.then(() => {
      if (this.restoring === pending) this.restoring = null;
    }, () => {
      if (this.restoring === pending) {
        this.restoring = null;
        this.restoredScope = null;
      }
    });
    return pending;
  }

  private async loadProjection(scope: SessionWorkScope, reset: boolean): Promise<void> {
    const tasks = await this.database.pendingSends();
    this.lifecycle.assertCurrent(scope);
    if (reset && !isTauri()) {
      const retainedPaths = new Set(tasks.flatMap(task => {
        const item = task.item;
        return (item.type === 'GALLERY' ? item.files : 'file' in item ? [item.file] : []).map(file => file.path);
      }));
      for (const { task } of this.projection().values()) {
        const item = task.item;
        const files = item.type === 'GALLERY' ? item.files : 'file' in item ? [item.file] : [];
        for (const file of files) {
          if (!retainedPaths.has(file.path)) this.browserFiles.release(file.path);
        }
      }
    }
    this.projection.set(new Map(tasks.map(task => [task.clientMessageId, {
      task, execution: initialExecution(task, 'failed'),
    }])));
  }

  /** Attachment bytes or native files must be ready before admission. */
  async enqueue(task: PendingSendTask): Promise<void> {
    const scope = this.lifecycle.capture();
    await this.database.enqueuePendingSend(task);
    this.lifecycle.assertCurrent(scope);
    this.projection.update(previous => new Map(previous).set(task.clientMessageId, {
      task, execution: initialExecution(task, 'sending'),
    }));
  }

  /** Retry reads the authoritative request, never a card or a retained callback. */
  async retry(clientMessageId: string): Promise<PendingSendTask | null> {
    const scope = this.lifecycle.capture();
    const task = await this.database.pendingSend(clientMessageId);
    this.lifecycle.assertCurrent(scope);
    if (!task) return null;
    this.projection.update(previous => new Map(previous).set(clientMessageId, {
      task, execution: initialExecution(task, 'sending'),
    }));
    return task;
  }

  setPhase(clientMessageId: string, phase: SendPhase): void {
    this.projection.update(previous => {
      const row = previous.get(clientMessageId);
      return row ? new Map(previous).set(clientMessageId, {
        task: row.task, execution: row.execution.kind === 'attachment'
          ? { ...row.execution, phase, failure: phase === 'failed' ? row.execution.failure : null }
          : { ...row.execution, phase },
      }) : previous;
    });
  }

  failUpload(clientMessageId: string, failure: UploadFailure): void {
    this.projection.update(previous => {
      const row = previous.get(clientMessageId);
      if (!row || row.execution.kind !== 'attachment') return previous;
      return new Map(previous).set(clientMessageId, {
        task: row.task, execution: { ...row.execution, phase: 'failed', failure },
      });
    });
  }

  setProgress(clientMessageId: string, loaded: number, total: number, startedAt: number): void {
    this.projection.update(previous => {
      const row = previous.get(clientMessageId);
      if (!row || row.execution.kind !== 'attachment') return previous;
      return new Map(previous).set(clientMessageId, {
        task: row.task, execution: { ...row.execution, loaded, total, startedAt },
      });
    });
  }

  /** Canonical server messages can confirm multiple parts represented by one gallery row. */
  async confirm(threadId: number, clientMessageIds: readonly string[]): Promise<void> {
    for (const clientMessageId of new Set(clientMessageIds)) {
      const scope = this.lifecycle.capture();
      const task = await this.database.pendingSend(clientMessageId);
      this.lifecycle.assertCurrent(scope);
      if (task?.threadId === threadId) await this.remove(clientMessageId);
    }
  }

  /** Caller stops execution before removal and releases native files after the row is deleted. */
  async remove(clientMessageId: string): Promise<void> {
    const scope = this.lifecycle.capture();
    const task = await this.database.pendingSend(clientMessageId);
    this.lifecycle.assertCurrent(scope);
    await this.database.removePendingSend(clientMessageId);
    this.lifecycle.assertCurrent(scope);
    if (task) this.releaseBrowserFiles(task);
    this.projection.update(previous => {
      const next = new Map(previous);
      next.delete(clientMessageId);
      return next;
    });
  }

  private releaseBrowserFiles(task: PendingSendTask): void {
    if (isTauri()) return;
    const item = task.item;
    const files = item.type === 'GALLERY' ? item.files : 'file' in item ? [item.file] : [];
    for (const file of files) this.browserFiles.release(file.path);
  }

  /** Called by existing account cleanup after execution has been cancelled. */
  async clear(): Promise<void> {
    const scope = this.lifecycle.capture();
    const tasks = await this.database.pendingSends();
    this.lifecycle.assertCurrent(scope);
    await this.database.clearPendingSends();
    this.lifecycle.assertCurrent(scope);
    for (const task of tasks) this.releaseBrowserFiles(task);
    this.projection.set(new Map());
  }
}
