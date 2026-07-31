import { Component, computed, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  MediaTransferService,
  type MediaTransferTask,
} from '../../services/media-transfer.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { RouteService } from '../../services/route.service';
import { displayThreadName } from '../../services/model';
import { AppIconType, IconComponent } from '../icon/icon.component';
import {
  categorizeFilename,
  fileExt,
  formatBytes,
  type FileCategory,
} from '../message-cards/file-meta.util';

interface UploadGroup {
  threadId: number;
  title: string;
  tasks: MediaTransferTask[];
}

@Component({
  selector: 'app-upload-detail-dialog',
  standalone: true,
  imports: [IconComponent, TranslocoPipe],
  templateUrl: './upload-detail-dialog.component.html',
  styleUrl: './upload-detail-dialog.component.scss',
})
export class UploadDetailDialogComponent {
  readonly AppIconType = AppIconType;
  readonly threadId = input<number>();
  private readonly route = inject(RouteService);
  private readonly transfers = inject(MediaTransferService);
  private readonly conversations = inject(ConversationListService);

  readonly groups = computed<UploadGroup[]>(() => {
    const threadId = this.threadId();
    const grouped = new Map<number, MediaTransferTask[]>();
    for (const task of this.transfers.tasks()) {
      if (threadId !== undefined && task.threadId !== threadId) continue;
      const tasks = grouped.get(task.threadId) ?? [];
      tasks.push(task);
      grouped.set(task.threadId, tasks);
    }
    return [...grouped.entries()].map(([threadId, tasks]) => ({
      threadId,
      title: this.threadName(threadId),
      tasks: this.currentFirst(tasks),
    }));
  });
  readonly taskCount = computed(() =>
    this.groups().reduce((total, group) => total + group.tasks.length, 0),
  );
  readonly isGlobal = computed(() => this.threadId() === undefined);

  close(): void {
    this.route.closeDlg();
  }

  cancel(task: MediaTransferTask): void {
    this.transfers.discard(task.clientMessageId);
  }

  retry(task: MediaTransferTask): void {
    this.transfers.retry(task.clientMessageId);
  }

  progress(task: MediaTransferTask): number {
    return task.size > 0
      ? Math.min(100, Math.max(0, Math.round((task.loaded / task.size) * 100)))
      : 0;
  }

  progressText(task: MediaTransferTask): string {
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

  private threadName(threadId: number): string {
    const thread = this.conversations
      .items()
      .find((item) => item.threadId === threadId);
    return thread ? displayThreadName(thread) : `#${threadId}`;
  }

  private currentFirst(tasks: MediaTransferTask[]): MediaTransferTask[] {
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
