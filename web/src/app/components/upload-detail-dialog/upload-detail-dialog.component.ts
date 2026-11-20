import {
  Component,
  computed,
  inject,
  input,
  ChangeDetectionStrategy,
  DestroyRef,
  effect,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { switchMap, scan } from 'rxjs';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  MediaTransferService,
  reduceUploadTasks,
} from '../../services/media-transfer.service';
import { BrowserSendFiles, SendAttachmentUnavailableError } from '../../services/browser-send-files.service';
import { parseTextMessageContent } from '../../../../../shared/text-message-content';
import type { SendingTask } from '../../services/thread-send-outbox.service';
import { RouteService } from '../../services/route.service';
import { TransferSpeedMeter } from './transfer-speed-meter';
import { SendingTaskPresentation } from '../../services/sending-task-presentation.service';
import { PageHeaderComponent } from '../page-header/page-header.component';
import {
  categorizeFilename,
  fileExt,
  formatBytes,
  type FileCategory,
} from '../message-cards/file-meta.util';

interface UploadPresentation {
  clientMessageId: string;
  name: string;
  size: number;
  loaded: number;
  startedAt: number;
  status: 'uploading' | 'completed' | 'failed';
  failure: string | null;
}

@Component({
  selector: 'app-upload-detail-dialog',
  standalone: true,
  imports: [TranslocoPipe, PageHeaderComponent],
  templateUrl: './upload-detail-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './upload-detail-dialog.component.scss',
})
export class UploadDetailDialogComponent {
  readonly threadId = input.required<number>();
  private readonly route = inject(RouteService);
  private readonly transloco = inject(TranslocoService);
  private readonly transfers = inject(MediaTransferService);
  private readonly uploadTasks = toSignal(
    toObservable(this.threadId).pipe(switchMap(threadId => this.transfers.watchThread(threadId).pipe(
      scan(reduceUploadTasks, [] as readonly SendingTask[]),
    ))),
    { initialValue: [] },
  );
  private readonly browserFiles = inject(BrowserSendFiles);
  private readonly speedMeter = new TransferSpeedMeter();
  private readonly speedClock = signal(performance.now());

  constructor() {
    const timer = setInterval(
      () => this.speedClock.set(performance.now()),
      1000,
    );
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    const previews = new Map<string, { path: string; url: string }>();
    inject(DestroyRef).onDestroy(() => {
      for (const preview of previews.values()) URL.revokeObjectURL(preview.url);
      previews.clear();
    });
    effect(() => {
      const keep = new Set<string>();
      for (const { task } of this.uploadTasks()) {
        const item = task.item;
        const file = item.type === 'IMAGE' ? item.file
          : item.type === 'GALLERY' ? item.files.find(file => file.intent === 'IMAGE') : undefined;
        if (!file) continue;
        const cid = task.clientMessageId;
        keep.add(cid);
        const previous = previews.get(cid);
        if (previous?.path === file.path) continue;
        if (previous) URL.revokeObjectURL(previous.url);
        previews.delete(cid);
        try {
          previews.set(cid, { path: file.path, url: URL.createObjectURL(this.browserFiles.resolve(file)) });
        } catch (error) {
          if (!(error instanceof SendAttachmentUnavailableError)) throw error;
        }
      }
      for (const [cid, preview] of previews) {
        if (keep.has(cid)) continue;
        URL.revokeObjectURL(preview.url);
        previews.delete(cid);
      }
      this.previewUrls.set(new Map([...previews].map(([cid, preview]) => [cid, preview.url])));
    });
    effect(() => {
      const tasks = this.uploads().filter(
        (task) => task.status === 'uploading',
      );
      const now = performance.now();
      this.speedMeter.retain(
        new Set(tasks.map((task) => task.clientMessageId)),
      );
      for (const task of tasks)
        this.speedMeter.update(task.clientMessageId, task.loaded, now);
      this.speedClock.set(now);
    });
  }

  speedText(task: UploadPresentation): string {
    const now = this.speedClock();
    return `${formatBytes(task.status === 'uploading' ? this.speedMeter.read(task.clientMessageId, now) : 0) || '0 B'}/s`;
  }
  private readonly previewUrls = signal<ReadonlyMap<string, string>>(new Map());

  readonly messageActions = input.required<{
    cancel(cid: string): Promise<void>;
    retry(cid: string): Promise<void>;
  }>();
  readonly messageActionPending = signal(new Set<string>());
  readonly messageActionFailed = signal(new Set<string>());

  async actOnMessage(
    cid: string,
    operation: 'cancel' | 'retry',
  ): Promise<void> {
    if (this.messageActionPending().has(cid)) return;
    this.messageActionPending.update((ids) => new Set(ids).add(cid));
    this.messageActionFailed.update((ids) => {
      const next = new Set(ids);
      next.delete(cid);
      return next;
    });
    try {
      await this.messageActions()[operation](cid);
    } catch {
      this.messageActionFailed.update((ids) => new Set(ids).add(cid));
    } finally {
      this.messageActionPending.update((ids) => {
        const next = new Set(ids);
        next.delete(cid);
        return next;
      });
    }
  }

  private readonly sending = inject(SendingTaskPresentation);
  readonly messages = computed(() => {
    const threadId = this.threadId();
    return this.sending
      .snapshot()
      .messages.filter((row) => row.task.threadId === threadId);
  });

  previewUrl(clientMessageId: string): string | undefined {
    return this.previewUrls().get(clientMessageId);
  }

  messagePreview(row: SendingTask): string {
    const item = row.task.item;
    switch (item.type) {
      case 'PURE_TEXT': return parseTextMessageContent(item.content)?.text ?? item.content;
      case 'CONTACT_CARD': return item.target.account;
      case 'LINK': return this.transloco.translate('transfer.linkTaskPreview');
      case 'FORWARD': return this.transloco.translate('transfer.forwardTaskPreview', { count: item.sourceMessages.length });
      default: return '';
    }
  }

  readonly uploads = computed(() =>
    this.currentFirst(
      this.uploadTasks().flatMap(({ task, execution }): UploadPresentation[] => {
        if (task.threadId !== this.threadId() || execution.kind !== 'attachment') return [];
        const item = task.item;
        const files = item.type === 'GALLERY' ? item.files : 'file' in item ? [item.file] : [];
        return [{
          clientMessageId: task.clientMessageId,
          name: files.map(file => file.name).join(', '),
          size: execution.total,
          loaded: execution.loaded,
          startedAt: execution.startedAt,
          failure: execution.failure === null ? null
            : execution.failure.kind === 'attachment-unavailable' ? this.transloco.translate('transfer.attachmentUnavailable')
            : execution.failure.kind === 'size-limit' ? this.transloco.translate('transfer.attachmentTooLarge', { limit: execution.failure.limit })
            : execution.failure.kind === 'transport' ? execution.failure.message
            : this.transloco.translate('transfer.uploadFailed'),
          status: execution.phase === 'sending' ? 'uploading' : 'failed',
        }];
      }),
    ),
  );
  readonly taskCount = computed(
    () => this.uploads().length + this.messages().length,
  );

  close(): void {
    this.route.closeDlg();
  }

  async cancel(task: UploadPresentation): Promise<void> {
    const cid = task.clientMessageId;
    if (this.messageActionPending().has(cid)) return;
    this.messageActionPending.update(ids => new Set(ids).add(cid));
    this.messageActionFailed.update(ids => {
      const next = new Set(ids);
      next.delete(cid);
      return next;
    });
    try {
      await this.transfers.discard(cid);
    } catch {
      this.messageActionFailed.update(ids => new Set(ids).add(cid));
    } finally {
      this.messageActionPending.update(ids => {
        const next = new Set(ids);
        next.delete(cid);
        return next;
      });
    }
  }

  retry(task: UploadPresentation): void {
    void this.actOnMessage(task.clientMessageId, 'retry');
  }

  canSendCompleted(task: UploadPresentation): boolean {
    return this.transfers.canSendCompleted(task.clientMessageId);
  }

  async sendCompleted(task: UploadPresentation): Promise<void> {
    const cid = task.clientMessageId;
    if (this.messageActionPending().has(cid)) return;
    this.messageActionPending.update(ids => new Set(ids).add(cid));
    try {
      await this.transfers.sendCompleted(cid);
    } catch {
      this.messageActionFailed.update(ids => new Set(ids).add(cid));
    } finally {
      this.messageActionPending.update(ids => {
        const next = new Set(ids);
        next.delete(cid);
        return next;
      });
    }
  }

  progress(task: UploadPresentation): number {
    return task.size > 0
      ? Math.min(100, Math.max(0, Math.round((task.loaded / task.size) * 100)))
      : 0;
  }

  progressText(task: UploadPresentation): string {
    const loaded = formatBytes(Math.min(task.loaded, task.size)) || '0 B';
    const size = formatBytes(task.size);
    return size ? `${loaded} / ${size}` : loaded;
  }

  ext(name: string): string {
    return fileExt(name);
  }

  category(name: string): FileCategory {
    return categorizeFilename(name);
  }

  private currentFirst(tasks: UploadPresentation[]): UploadPresentation[] {
    const sorted = [...tasks].sort((a, b) => a.startedAt - b.startedAt);
    const currentIndex = sorted.findIndex(
      (task) =>
        task.status === 'uploading' &&
        task.loaded > 0 &&
        task.loaded < task.size,
    );
    const fallbackIndex = sorted.findIndex(
      (task) => task.status === 'uploading',
    );
    const index = currentIndex >= 0 ? currentIndex : fallbackIndex;
    if (index <= 0) return sorted;
    return [
      sorted[index],
      ...sorted.slice(0, index),
      ...sorted.slice(index + 1),
    ];
  }
}
