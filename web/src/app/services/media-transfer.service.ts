import { SessionLifecycleService, type SessionWorkScope } from './session-lifecycle.service';
import { NativeUploadTransport } from './native-upload-transport.service';
import { WebUploadTransport } from './web-upload-transport';
import { HttpClient } from '@angular/common/http';
import { BrowserSendFiles, SendAttachmentUnavailableError } from './browser-send-files.service';
import type { StoredSendContent, StoredSendFile, StoredNonMediaSendContent } from './send-outbox-storage';
import { Injectable, computed, signal, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { ReplaySubject, firstValueFrom, map, distinctUntilChanged, takeUntil, fromEvent, merge, Observable } from 'rxjs';
import { MsgService } from './message.service';
import { apiPrefix } from './constants';
import { isTauri, tauriInvoke } from './runtime';

import { ThreadSendOutbox, type UploadFailure, type SendingTask } from './thread-send-outbox.service';

export type UploadTaskEvent =
  | { type: 'snapshot'; tasks: readonly SendingTask[] }
  | { type: 'upsert'; task: SendingTask }
  | { type: 'remove'; clientMessageId: string };

/** Pure display reducer; execution and durable ownership remain in the service. */
export function reduceUploadTasks(tasks: readonly SendingTask[], event: UploadTaskEvent): readonly SendingTask[] {
  if (event.type === 'snapshot') return event.tasks;
  if (event.type === 'remove') return tasks.filter(row => row.task.clientMessageId !== event.clientMessageId);
  const index = tasks.findIndex(row => row.task.clientMessageId === event.task.task.clientMessageId);
  if (index < 0) return [...tasks, event.task];
  return tasks.map((row, position) => position === index ? event.task : row);
}

type UploadTask = {
  clientMessageId: string;
  threadId: number;
  item: Exclude<StoredSendContent<StoredSendFile>, StoredNonMediaSendContent>;
};

class UploadSizeLimitError extends Error {
  constructor(readonly limit: number) { super('Attachment exceeds the upload size limit'); }
}

/**
 * App-scoped upload executor and transport controls.
 *
 * The send outbox owns task identity, phase and upload details. This service owns cancellation
 * signals and execution callbacks; retiring an outbox task releases those controls.
 */
@Injectable({ providedIn: 'root' })
export class MediaTransferService {
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly files = inject(BrowserSendFiles);
  private readonly http = inject(HttpClient);
  private readonly webTransport = new WebUploadTransport(this.http);
  private readonly nativeTransport = new NativeUploadTransport();

  private readonly executions = new Map<string, { scope: SessionWorkScope; promise: Promise<void> }>();

  executeWeb(task: UploadTask): Promise<void> { return this.execute(task, false); }

  executeNative(task: UploadTask): Promise<void> { return this.execute(task, true); }

  private execute(task: UploadTask, native: boolean): Promise<void> {
    const cid = task.clientMessageId;
    const active = this.executions.get(cid);
    if (active && this.lifecycle.isCurrent(active.scope)) return active.promise;
    const scope = this.lifecycle.capture();
    const execution = this.run(task, native).finally(() => {
      if (this.executions.get(cid)?.promise === execution) this.executions.delete(cid);
    });
    this.executions.set(cid, { scope, promise: execution });
    return execution;
  }

  private async run(task: UploadTask, native: boolean): Promise<void> {
    const { clientMessageId: cid, threadId, item } = task;
    const scope = this.lifecycle.capture();
    const localAbort = new AbortController();
    const stopped = merge(fromEvent(scope.signal, 'abort'), fromEvent(localAbort.signal, 'abort'));
    let cancelSubscription: import('rxjs').Subscription | undefined;
    const assertActive = () => {
      this.lifecycle.assertCurrent(scope);
      if (localAbort.signal.aborted) throw new Error('Upload cancelled');
    };
    try {
      assertActive();
      const descriptors = item.type === 'GALLERY'
        ? item.files.map((file, position) => ({ file, partId: file.partId, position, intent: file.intent }))
        : [{ file: item.file, partId: item.file.partId, position: 0, intent: item.type }];
      const parts = descriptors.map(part => ({ ...part, upload: native
        ? (progress: (loaded: number, total: number) => void) => this.nativeTransport.upload(part.file, {
            clientMessageId: cid, partId: part.partId, position: part.position, intent: part.intent,
          }, progress)
        : this.prepareWebPart(cid, part),
      }));
      const total = parts.reduce((sum, part) => sum + part.file.size, 0);
      this.start(cid, total);
      cancelSubscription = this.cancelled(cid).subscribe(() => localAbort.abort());
      let limit: number | undefined;
      try {
        const quota = await firstValueFrom(this.http.post<{ code: number; data?: { breaker: { maxFileBytes: number } } }>(`${apiPrefix()}/user/my-quota`, {}).pipe(takeUntil(stopped)));
        if (quota.code === 0) limit = quota.data?.breaker.maxFileBytes;
      } catch { /* Server upload admission remains authoritative if preflight is unavailable. */ }
      assertActive();
      if (!this.isUploading(cid)) return;
      if (limit !== undefined && parts.some(part => limit <= 0 || part.file.size > limit))
        throw new UploadSizeLimitError(limit);
      if (native) {
        try {
          await this.nativeTransport.prepare(cid, descriptors.map(part => ({ partId: part.partId, path: part.file.path, size: part.file.size })));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('Attachment unavailable')) throw new SendAttachmentUnavailableError();
          throw error;
        }
      }
      const staged = await firstValueFrom(this.messages.sendMedia({
        threadId, clientMessageId: cid, contentType: item.type,
        ...(item.type === 'GALLERY' ? { fileCnt: parts.length } : {}),
      }).pipe(takeUntil(merge(stopped, this.cancelled(cid)))));
      assertActive();
      if (staged.code !== 0) throw new Error(staged.message);
      const loaded = new Map<number, number>();
      const failures: unknown[] = [];
      await Promise.allSettled(parts.map(async part => {
        try {
        assertActive();
        const response = await firstValueFrom(part.upload(value => {
          if (!this.lifecycle.isCurrent(scope) || localAbort.signal.aborted || !this.isUploading(cid)) return;
          loaded.set(part.position, value);
          this.progress(cid, [...loaded.values()].reduce((sum, bytes) => sum + bytes, 0), total);
        }).pipe(takeUntil(merge(stopped, this.cancelled(cid)))));
        assertActive();
        if (response.code !== 0) throw new Error(response.message);
        } catch (error) {
          if (failures.length === 0) failures.push(error);
          localAbort.abort();
          throw error;
        }
      }));
      if (failures.length !== 0) throw failures[0];
      assertActive();
      if (this.isUploading(cid)) await this.outbox.confirm(threadId, [cid]);
    } catch (error) {
      localAbort.abort();
      if (!this.lifecycle.isCurrent(scope)) throw error;
      // Explicit cancellation has already published its state; do not replace it with an abort error.
      if (cancelSubscription && !this.isUploading(cid)) throw error;
      const failure: UploadFailure = error instanceof SendAttachmentUnavailableError
        ? { kind: 'attachment-unavailable' }
        : error instanceof UploadSizeLimitError ? { kind: 'size-limit', limit: error.limit }
        : { kind: 'transport', message: error instanceof Error ? error.message : String(error) };
      const running = this.isUploading(cid);
      this.outbox.failUpload(cid, failure);
      // Stop siblings locally. A transport failure must not cancel completed server parts.
      if (running) {
        const signal = this.cancelSignals.get(cid);
        signal?.next();
        signal?.complete();
        this.cancelSignals.delete(cid);
      }
      throw error;
    } finally {
      cancelSubscription?.unsubscribe();
      if (native) await this.nativeTransport.release(cid).catch(() => undefined);
    }
  }

  private prepareWebPart(cid: string, part: { file: StoredSendFile; partId: string; position: number; intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE' }) {
    const file = this.files.resolve(part.file);
    return (progress: (loaded: number, total: number) => void) => this.webTransport.upload(file, {
      clientMessageId: cid, partId: part.partId, position: part.position, intent: part.intent,
    }, progress);
  }

  private readonly cancelSignals = new Map<string, ReplaySubject<void>>();

  private readonly localStopActions = new Map<string, () => void | Promise<void>>();
  private readonly discardActions = new Map<string, () => void | Promise<void>>();
  constructor(private readonly outbox: ThreadSendOutbox, private readonly messages: MsgService) {}

  ngOnDestroy(): void {
    for (const cid of this.cancelSignals.keys()) this.releaseTask(cid);
  }
  private readonly latestRequestState = signal<{
    threadId: number;
    nonce: number;
  } | null>(null);

  readonly tasks = computed(() => this.outbox.uploads());
  /** Display subscriptions never start or stop execution. The outbox remains the single projection. */
  readonly tasks$ = toObservable(this.tasks);

  watchThread(threadId: number): Observable<UploadTaskEvent> {
    return new Observable(subscriber => {
      let previous = new Map(this.tasks().filter(row => row.task.threadId === threadId)
        .map(row => [row.task.clientMessageId, row]));
      subscriber.next({ type: 'snapshot', tasks: [...previous.values()] });
      const subscription = this.tasks$.subscribe({
        next: () => {
          // Read the authoritative signal, not a potentially older replayed emission.
          const current = new Map(this.tasks().filter(row => row.task.threadId === threadId)
            .map(row => [row.task.clientMessageId, row]));
          const before = previous;
          previous = current;
          for (const cid of before.keys()) {
            if (!current.has(cid)) subscriber.next({ type: 'remove', clientMessageId: cid });
          }
          for (const [cid, row] of current) {
            if (before.get(cid) !== row) subscriber.next({ type: 'upsert', task: row });
          }
        },
        error: error => subscriber.error(error),
      });
      return subscription;
    });
  }

  task$(clientMessageId: string) {
    return this.tasks$.pipe(
      map(tasks => tasks.find(row => row.task.clientMessageId === clientMessageId) ?? null),
      distinctUntilChanged(),
    );
  }

  readonly latestRequest = this.latestRequestState.asReadonly();

  isUploading(clientMessageId: string): boolean {
    const execution = this.outbox.get(clientMessageId)?.execution;
    return execution?.kind === 'attachment' && execution.phase === 'sending';
  }

  start(clientMessageId: string, totalBytes: number): void {
    const current = this.outbox.get(clientMessageId);
    if (!current || current.execution.kind !== 'attachment')
      throw new Error('upload execution requires a persisted attachment intent');
    this.outbox.setPhase(clientMessageId, 'sending');
    this.outbox.setProgress(clientMessageId, 0, totalBytes, Date.now());
    this.cancelSignals.get(clientMessageId)?.complete();
    this.cancelSignals.set(clientMessageId, new ReplaySubject<void>(1));
  }

  fail(clientMessageId: string): void {
    this.outbox.setPhase(clientMessageId, 'failed');
  }

  cancelled(clientMessageId: string): Observable<void> {
    let subject = this.cancelSignals.get(clientMessageId);
    if (!subject) {
      subject = new ReplaySubject<void>(1);
      this.cancelSignals.set(clientMessageId, subject);
    }
    return subject.asObservable();
  }

  async cancel(clientMessageId: string): Promise<void> {
    if (!this.isUploading(clientMessageId)) return;
    this.fail(clientMessageId);
    await this.stop(clientMessageId);
  }

  private async stop(clientMessageId: string): Promise<void> {
    const subject = this.cancelSignals.get(clientMessageId);
    subject?.next();
    subject?.complete();
    this.cancelSignals.delete(clientMessageId);
    await this.localStopActions.get(clientMessageId)?.();
    if (isTauri()) await tauriInvoke('cancel_upload', { clientMessageId });
    const response = await firstValueFrom(this.messages.cancelUploadBatch(clientMessageId));
    if (response.code !== 0) throw new Error(response.message);
  }

  /** Retire the durable intent before releasing its client-owned attachment resources. */
  async discard(clientMessageId: string): Promise<void> {
    const current = this.outbox.get(clientMessageId);
    if (current?.execution.kind !== 'attachment') return;
    this.outbox.setPhase(clientMessageId, 'failed');
    await this.stop(clientMessageId);
    const discard = this.discardActions.get(clientMessageId);
    await this.outbox.remove(clientMessageId);
    await discard?.();
    this.releaseTask(clientMessageId);
  }

  registerLocalStop(clientMessageId: string, stop: () => void | Promise<void>): void {
    this.localStopActions.set(clientMessageId, stop);
  }

  registerDiscard(clientMessageId: string, discard: () => void | Promise<void>): void {
    this.discardActions.set(clientMessageId, discard);
  }

  canSendCompleted(clientMessageId: string): boolean {
    const row = this.outbox.get(clientMessageId);
    return row?.task.item.type === 'GALLERY';
  }

  async sendCompleted(clientMessageId: string): Promise<void> {
    if (!this.canSendCompleted(clientMessageId)) return;
    // Mark stopped before cancellation wakes upload observers. They must not cancel the server batch.
    this.outbox.setPhase(clientMessageId, 'failed');
    const subject = this.cancelSignals.get(clientMessageId);
    subject?.next();
    subject?.complete();
    this.cancelSignals.delete(clientMessageId);
    // Preserve the server batch and stop only local transmissions.
    await this.localStopActions.get(clientMessageId)?.();
    if (isTauri()) await tauriInvoke('cancel_upload', { clientMessageId });
    const response = await firstValueFrom(this.messages.sendCompletedUploadBatch(clientMessageId));
    if (response.code !== 0) throw new Error(response.message);
    if (response.data?.sent) {
      const threadId = this.outbox.get(clientMessageId)?.task.threadId;
      if (threadId !== undefined) await this.outbox.confirm(threadId, [clientMessageId]);
    }
  }

  progress(clientMessageId: string, loaded: number, total: number): void {
    const current = this.outbox.get(clientMessageId)?.execution;
    if (current?.kind !== 'attachment' || current.phase !== 'sending') return;
    // Browser HttpClient may report the encoded multipart request length (file bytes + boundary/header
    // overhead), while Tauri reports raw file bytes. Never replace the task's original file-size weight
    // with that transport total: doing so grows the aggregate denominator mid-flight and makes the visible
    // progress bar move backwards. Convert the transport reading to a file-relative byte position instead.
    const fileRelativeLoaded =
      total > 0 && current.total > 0
        ? (Math.max(0, loaded) / total) * current.total
        : loaded;
    const normalized = Math.min(
      Math.max(0, fileRelativeLoaded),
      Math.max(0, current.total),
    );
    if (normalized <= current.loaded) return;
    this.outbox.setProgress(clientMessageId, normalized, current.total, current.startedAt);
  }

  requestLatest(threadId: number): void {
    this.latestRequestState.set({ threadId, nonce: Date.now() });
  }

  private releaseTask(clientMessageId: string): void {
    this.cancelSignals.get(clientMessageId)?.next();
    this.cancelSignals.get(clientMessageId)?.complete();
    this.cancelSignals.delete(clientMessageId);
    this.localStopActions.delete(clientMessageId);
    this.discardActions.delete(clientMessageId);
  }
}
