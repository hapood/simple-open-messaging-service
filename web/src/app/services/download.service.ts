import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { assetUrl, isTauri, listenEvent, tauriInvoke } from './runtime';
import { MediaSaveCancelledError, MediaSaveService } from './media-save.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbService } from './webdb.service';
import type { StoredDownloadRecord } from './download-history-storage';

export interface DownloadRequest {
  threadId: number;
  path: string;
  filename: string;
  mimeType: string;
}

export interface DownloadTask {
  readonly id: string;
  readonly request: DownloadRequest;
  readonly loaded: number;
  readonly total: number | null;
  readonly phase: 'downloading' | 'saving' | 'completed' | 'failed';
  readonly error: string | null;
  readonly destination?: string | null;
}

export type DownloadTaskEvent =
  | { type: 'snapshot'; tasks: readonly DownloadTask[] }
  | { type: 'upsert'; task: DownloadTask }
  | { type: 'remove'; id: string };

export function reduceDownloadTasks(tasks: readonly DownloadTask[], event: DownloadTaskEvent): readonly DownloadTask[] {
  if (event.type === 'snapshot') return event.tasks;
  if (event.type === 'remove') return tasks.filter(task => task.id !== event.id);
  const found = tasks.some(task => task.id === event.task.id);
  return found ? tasks.map(task => task.id === event.task.id ? event.task : task) : [...tasks, event.task];
}

type DownloadUpdate = Pick<DownloadTask, 'loaded' | 'total' | 'phase' | 'error'> & { destination?: string | null };

export interface DownloadAdapter {
  download(request: DownloadRequest, signal: AbortSignal, publish: (update: DownloadUpdate) => void): Promise<void>;
}

/** Executes synchronously while the originating click still holds browser user activation. */
export class BrowserDownloadAdapter implements DownloadAdapter {
  download(request: DownloadRequest): Promise<void> {
    const anchor = document.createElement('a');
    anchor.href = assetUrl(request.path);
    anchor.download = request.filename;
    anchor.rel = 'noopener';
    anchor.hidden = true;
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
    return Promise.resolve();
  }
}

@Injectable({ providedIn: 'root' })
class NativeDownloadAdapter implements DownloadAdapter {
  private readonly save = inject(MediaSaveService);

  async download(request: DownloadRequest, signal: AbortSignal, publish: (update: DownloadUpdate) => void): Promise<void> {
    const taskId = crypto.randomUUID();
    let loaded = 0;
    let total: number | null = null;
    publish({ phase: 'downloading', loaded, total, error: null });
    const unlisten = await listenEvent<{ taskId: string; loaded: number; total: number | null }>('media-download-progress', ({ payload }) => {
      if (payload.taskId !== taskId || signal.aborted) return;
      loaded = payload.loaded;
      total = payload.total;
      publish({ phase: 'downloading', loaded, total, error: null });
    });
    const abort = () => { void tauriInvoke('cancel_media_download', { taskId }).catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw new MediaSaveCancelledError();
      const destination = await this.save.save(request, taskId);
      if (signal.aborted) throw new MediaSaveCancelledError();
      publish({ phase: 'completed', loaded, total, error: null, destination });
    } finally {
      signal.removeEventListener('abort', abort);
      unlisten?.();
    }
  }
}

export const DOWNLOAD_ADAPTER = new InjectionToken<DownloadAdapter>('DOWNLOAD_ADAPTER', {
  providedIn: 'root',
  factory: () => isTauri() ? inject(NativeDownloadAdapter) : new BrowserDownloadAdapter(),
});

/** Platform-neutral entry point. Only adapters publishing progress create managed tasks. */
@Injectable({ providedIn: 'root' })
export class DownloadService {
  private readonly adapter = inject(DOWNLOAD_ADAPTER);
  private readonly lifecycle = inject(SessionLifecycleService);
  private readonly records = inject(WebdbService, { optional: true });
  private readonly tasks = new Map<string, DownloadTask>();
  private readonly executions = new Map<string, AbortController>();
  private readonly changes = new Subject<Exclude<DownloadTaskEvent, { type: 'snapshot' }>>();

  constructor() {
    void this.restore();
    this.lifecycle.invalidated$.subscribe(() => {
      for (const abort of this.executions.values()) abort.abort();
      this.executions.clear();
      for (const id of [...this.tasks.keys()]) this.remove(id);
    });
  }

  watchAll(): Observable<DownloadTaskEvent> { return this.watch(); }

  watchThread(threadId: number): Observable<DownloadTaskEvent> { return this.watch(threadId); }

  private watch(threadId?: number): Observable<DownloadTaskEvent> {
    return new Observable(subscriber => {
      // Queue reentrant mutations until the initial snapshot has been delivered.
      const ids = new Set([...this.tasks.values()].filter(task => threadId === undefined || task.request.threadId === threadId).map(task => task.id));
      const snapshot = [...ids].map(id => this.tasks.get(id)!);
      let ready = false;
      const pending: DownloadTaskEvent[] = [];
      const subscription = this.changes.subscribe(event => {
        if (event.type === 'upsert') {
          if (threadId !== undefined && event.task.request.threadId !== threadId) return;
          ids.add(event.task.id);
        } else if (!ids.delete(event.id)) return;
        if (ready) subscriber.next(event);
        else pending.push(event);
      });
      subscriber.next({ type: 'snapshot', tasks: snapshot });
      ready = true;
      for (const event of pending) subscriber.next(event);
      return subscription;
    });
  }

  download(request: DownloadRequest): Promise<void> {
    return this.execute(crypto.randomUUID(), request);
  }

  retry(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.phase !== 'failed' || this.executions.has(id))
      return Promise.reject(new Error('Download task is not available for retry'));
    return this.execute(id, task.request);
  }

  private execute(id: string, request: DownloadRequest): Promise<void> {
    const captured = { ...request };
    const scope = this.lifecycle.capture();
    const abort = new AbortController();
    this.executions.set(id, abort);
    let result: Promise<void>;
    try {
      // Do not defer: browser download delegation must retain user activation.
      result = this.adapter.download(captured, abort.signal, update => {
        if (abort.signal.aborted || !this.lifecycle.isCurrent(scope)) return;
        const task = { destination: this.tasks.get(id)?.destination ?? null, id, request: captured, ...update };
        this.tasks.set(id, task);
        this.changes.next({ type: 'upsert', task });
        void this.remember(task);
      });
    } catch (error) { result = Promise.reject(error); }
    return result.catch(error => {
      if (!this.lifecycle.isCurrent(scope)) return;
      if (error instanceof MediaSaveCancelledError || abort.signal.aborted) { this.remove(id); return; }
      const task = this.tasks.get(id);
      if (task) {
        const failed: DownloadTask = { ...task, phase: 'failed', error: error instanceof Error ? error.message : String(error) };
        this.tasks.set(id, failed);
        this.changes.next({ type: 'upsert', task: failed });
        void this.remember(failed);
      }
      throw error;
    }).finally(() => this.executions.delete(id));
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    // The OS save picker/copy is not cancellable through the download transport.
    if (task?.phase === 'saving') return;
    this.executions.get(id)?.abort();
    this.remove(id);
  }

  dismiss(id: string): void {
    if (!this.executions.has(id)) {
      this.remove(id);
      void this.records?.removeDownloadRecord(id);
    }
  }

  async clearHistory(deleteFiles: boolean): Promise<void> {
    const contentUris = await this.records?.clearDownloadRecords(deleteFiles) ?? [];
    if (deleteFiles) {
      for (const uri of contentUris) window.SomsMedia?.deleteSaved?.(uri);
    }
    for (const [id, task] of [...this.tasks]) {
      if (task.phase === 'completed' || task.phase === 'failed') this.remove(id);
    }
  }

  private async restore(): Promise<void> {
    const rows = await this.records?.downloadRecords() ?? [];
    for (const record of rows) {
      if (this.tasks.has(record.id)) continue;
      const task = taskFromRecord(record);
      this.tasks.set(task.id, task);
      this.changes.next({ type: 'upsert', task });
    }
  }

  private async remember(task: DownloadTask): Promise<void> {
    if (task.phase !== 'completed' && task.phase !== 'failed') return;
    await this.records?.putDownloadRecord({
      id: task.id,
      threadId: task.request.threadId,
      path: task.request.path,
      filename: task.request.filename,
      mimeType: task.request.mimeType,
      phase: task.phase,
      error: task.error,
      destination: task.destination ?? null,
      loaded: task.loaded,
      total: task.total,
    });
  }

  private remove(id: string): void {
    if (this.tasks.delete(id)) this.changes.next({ type: 'remove', id });
  }
}

function taskFromRecord(record: StoredDownloadRecord): DownloadTask {
  return {
    id: record.id,
    request: { threadId: record.threadId, path: record.path, filename: record.filename, mimeType: record.mimeType },
    loaded: record.loaded,
    total: record.total,
    phase: record.phase,
    error: record.error,
    destination: record.destination,
  };
}
