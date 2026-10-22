import { Injectable, computed, signal } from '@angular/core';
import { ReplaySubject, type Observable } from 'rxjs';
import { isTauri, tauriInvoke } from './runtime';

export type MediaTransferKind = 'image' | 'file' | 'video' | 'audio';
type MediaTransferStatus = 'uploading' | 'failed' | 'completed';

export interface MediaTransferTask {
  clientMessageId: string;
  threadId: number;
  kind: MediaTransferKind;
  name: string;
  size: number;
  loaded: number;
  status: MediaTransferStatus;
  startedAt: number;
  previewUrl: string | null;
  errorReason?: string;
  retryable?: boolean;
  supportsSendCompleted?: boolean;
  completedAt?: number;
}

export interface ThreadTransferSummary {
  threadId: number;
  uploading: number;
  completed: number;
  failed: number;
  total: number;
  bytes: number;
  loadedBytes: number;
  progress: number | null;
  latestAt: number;
}

/**
 * App-scoped media transfer state.
 *
 * Message pending remains owned by the message source/kernel. This store contains only transport
 * state, so uploads survive navigation away from a compact chat and both the chat header and the
 * conversation-list header render the same truth without sharing component-local pending arrays.
 */
@Injectable({ providedIn: 'root' })
export class MediaTransferService {
  private readonly cleanupTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private readonly cancelSignals = new Map<string, ReplaySubject<void>>();
  private readonly retryActions = new Map<string, () => void>();
  private readonly cancelActions = new Map<string, () => void>();
  private readonly discardActions = new Map<string, () => void>();
  private readonly sendCompletedActions = new Map<string, () => void>();
  private readonly taskMap = signal<ReadonlyMap<string, MediaTransferTask>>(
    new Map(),
  );
  private readonly latestRequestState = signal<{
    threadId: number;
    nonce: number;
  } | null>(null);

  readonly tasks = computed(() =>
    [...this.taskMap().values()].sort((a, b) => a.startedAt - b.startedAt),
  );

  readonly summaries = computed<ThreadTransferSummary[]>(() => {
    const grouped = new Map<number, ThreadTransferSummary>();
    for (const task of this.taskMap().values()) {
      const summary = grouped.get(task.threadId) ?? {
        threadId: task.threadId,
        uploading: 0,
        completed: 0,
        failed: 0,
        total: 0,
        bytes: 0,
        loadedBytes: 0,
        progress: null,
        latestAt: 0,
      };
      summary.total++;
      summary.bytes += Math.max(0, task.size);
      summary.loadedBytes += Math.min(
        Math.max(0, task.loaded),
        Math.max(0, task.size),
      );
      summary.latestAt = Math.max(summary.latestAt, task.startedAt);
      if (task.status === 'uploading') summary.uploading++;
      else if (task.status === 'completed') summary.completed++;
      else summary.failed++;
      summary.progress =
        summary.bytes > 0
          ? Math.round((summary.loadedBytes / summary.bytes) * 100)
          : null;
      grouped.set(task.threadId, summary);
    }
    return [...grouped.values()].sort((a, b) => b.latestAt - a.latestAt);
  });

  readonly activeCount = computed(
    () => this.tasks().filter((task) => task.status === 'uploading').length,
  );
  readonly failedCount = computed(
    () => this.tasks().filter((task) => task.status === 'failed').length,
  );
  readonly latestRequest = this.latestRequestState.asReadonly();

  summaryFor(threadId: number): ThreadTransferSummary | undefined {
    return this.summaries().find((summary) => summary.threadId === threadId);
  }

  isUploading(clientMessageId: string): boolean {
    return this.taskMap().get(clientMessageId)?.status === 'uploading';
  }

  start(params: {
    clientMessageId: string;
    threadId: number;
    kind: MediaTransferKind;
    file?: File;
    name?: string;
    size?: number;
    previewUrl?: string | null;
    supportsSendCompleted?: boolean;
  }): void {
    const name = params.file?.name ?? params.name ?? 'attachment';
    const size = params.file?.size ?? params.size ?? 0;
    const previous = this.taskMap().get(params.clientMessageId);
    this.patch(params.clientMessageId, {
      clientMessageId: params.clientMessageId,
      threadId: params.threadId,
      kind: params.kind,
      name,
      size,
      status: 'uploading',
      loaded: previous?.status === 'failed' ? 0 : (previous?.loaded ?? 0),
      startedAt: previous?.startedAt ?? Date.now(),
      previewUrl:
        previous?.previewUrl ??
        params.previewUrl ??
        (params.file && params.kind === 'image' && typeof URL !== 'undefined'
          ? URL.createObjectURL(params.file)
          : null),
      errorReason: undefined,
      retryable: true,
      supportsSendCompleted:
        params.supportsSendCompleted === true ||
        previous?.supportsSendCompleted === true,
      completedAt: undefined,
    });
    this.cancelSignals.get(params.clientMessageId)?.complete();
    this.cancelSignals.set(params.clientMessageId, new ReplaySubject<void>(1));
  }

  complete(clientMessageId: string): void {
    const current = this.taskMap().get(clientMessageId);
    if (!current) return;
    this.patch(clientMessageId, {
      ...current,
      loaded: current.size,
      status: 'completed',
      completedAt: Date.now(),
    });
    this.scheduleCompletedCleanup(current.threadId);
  }

  fail(clientMessageId: string, errorReason?: string, retryable = true): void {
    const current = this.taskMap().get(clientMessageId);
    if (!current) return;
    this.patch(clientMessageId, {
      ...current,
      status: 'failed',
      errorReason,
      retryable,
      completedAt: undefined,
    });
  }

  cancelled(clientMessageId: string): Observable<void> {
    let subject = this.cancelSignals.get(clientMessageId);
    if (!subject) {
      subject = new ReplaySubject<void>(1);
      this.cancelSignals.set(clientMessageId, subject);
    }
    return subject.asObservable();
  }

  cancel(clientMessageId: string): void {
    const current = this.taskMap().get(clientMessageId);
    if (!current || current.status !== 'uploading') return;
    const subject = this.cancelSignals.get(clientMessageId);
    subject?.next();
    subject?.complete();
    this.cancelSignals.delete(clientMessageId);
    this.cancelActions.get(clientMessageId)?.();
    if (isTauri()) {
      void tauriInvoke('cancel_upload', { clientMessageId }).catch(
        () => undefined,
      );
    }
    this.fail(clientMessageId);
  }

  /** Abort an in-flight upload and remove its transport card entirely. Unlike cancel(), this is an
   * explicit user discard, so it must not turn into a retryable failure. */
  discard(clientMessageId: string): void {
    const current = this.taskMap().get(clientMessageId);
    if (!current) return;
    if (current.status === 'uploading') {
      const subject = this.cancelSignals.get(clientMessageId);
      subject?.next();
      subject?.complete();
      this.cancelActions.get(clientMessageId)?.();
      if (isTauri()) {
        void tauriInvoke('cancel_upload', { clientMessageId }).catch(
          () => undefined,
        );
      }
    }
    this.discardActions.get(clientMessageId)?.();
    this.dismiss(clientMessageId);
  }

  registerRetry(clientMessageId: string, retry: () => void): void {
    this.retryActions.set(clientMessageId, retry);
  }

  registerCancel(clientMessageId: string, cancel: () => void): void {
    this.cancelActions.set(clientMessageId, cancel);
  }

  registerDiscard(clientMessageId: string, discard: () => void): void {
    this.discardActions.set(clientMessageId, discard);
  }

  registerSendCompleted(clientMessageId: string, sendCompleted: () => void): void {
    this.sendCompletedActions.set(clientMessageId, sendCompleted);
  }

  sendCompleted(clientMessageId: string): void {
    const current = this.taskMap().get(clientMessageId);
    if (!current || current.status !== 'uploading') return;
    const subject = this.cancelSignals.get(clientMessageId);
    subject?.next();
    subject?.complete();
    this.cancelSignals.delete(clientMessageId);
    this.cancelActions.get(clientMessageId)?.();
    if (isTauri()) {
      void tauriInvoke('cancel_upload', { clientMessageId }).catch(
        () => undefined,
      );
    }
    this.sendCompletedActions.get(clientMessageId)?.();
  }

  retry(clientMessageId: string): void {
    const task = this.taskMap().get(clientMessageId);
    if (!task || task.status !== 'failed' || task.retryable === false) return;
    this.retryActions.get(clientMessageId)?.();
  }

  progress(clientMessageId: string, loaded: number, total: number): void {
    const current = this.taskMap().get(clientMessageId);
    if (!current || current.status !== 'uploading') return;
    // Browser HttpClient may report the encoded multipart request length (file bytes + boundary/header
    // overhead), while Tauri reports raw file bytes. Never replace the task's original file-size weight
    // with that transport total: doing so grows the aggregate denominator mid-flight and makes the visible
    // progress bar move backwards. Convert the transport reading to a file-relative byte position instead.
    const fileRelativeLoaded =
      total > 0 && current.size > 0
        ? (Math.max(0, loaded) / total) * current.size
        : loaded;
    const normalized = Math.min(
      Math.max(0, fileRelativeLoaded),
      Math.max(0, current.size),
    );
    if (normalized <= current.loaded) return;
    this.patch(clientMessageId, {
      ...current,
      loaded: normalized,
    });
  }

  dismiss(clientMessageId: string): void {
    this.releaseTask(clientMessageId);
    const next = new Map(this.taskMap());
    next.delete(clientMessageId);
    this.taskMap.set(next);
  }

  requestLatest(threadId: number): void {
    this.latestRequestState.set({ threadId, nonce: Date.now() });
  }

  private patch(clientMessageId: string, task: MediaTransferTask): void {
    const next = new Map(this.taskMap());
    next.set(clientMessageId, task);
    this.taskMap.set(next);
  }

  private scheduleCompletedCleanup(threadId: number): void {
    const old = this.cleanupTimers.get(threadId);
    if (old) clearTimeout(old);
    this.cleanupTimers.set(
      threadId,
      setTimeout(() => {
        this.cleanupTimers.delete(threadId);
        const tasks = [...this.taskMap().values()].filter(
          (task) => task.threadId === threadId,
        );
        if (tasks.some((task) => task.status === 'uploading')) return;
        const next = new Map(this.taskMap());
        for (const task of tasks) {
          if (task.status === 'completed') {
            this.releaseTask(task.clientMessageId);
            next.delete(task.clientMessageId);
          }
        }
        this.taskMap.set(next);
      }, 1800),
    );
  }

  private releaseTask(clientMessageId: string): void {
    const task = this.taskMap().get(clientMessageId);
    if (task?.previewUrl) URL.revokeObjectURL(task.previewUrl);
    this.cancelSignals.get(clientMessageId)?.complete();
    this.cancelSignals.delete(clientMessageId);
    this.retryActions.delete(clientMessageId);
    this.cancelActions.delete(clientMessageId);
    this.discardActions.delete(clientMessageId);
    this.sendCompletedActions.delete(clientMessageId);
  }
}
