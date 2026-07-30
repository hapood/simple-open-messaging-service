import { Injectable, computed, inject, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import type { AlbumImage } from '../components/message-cards/chat-item';
import { MediaSaveService } from './media-save.service';
import { assetUrl } from './runtime';
import {
  IMAGE_DOWNLOAD_ADAPTER,
  type ImageDownloadArtifact,
} from './image-download.adapter';

export type ImageDownloadStatus =
  | 'downloading'
  | 'loaded'
  | 'saving'
  | 'saved'
  | 'failed';

export interface ImageDownloadTask {
  key: string;
  threadId: number;
  msgId: number;
  src: string;
  name: string;
  expectedSize: number;
  loaded: number;
  total: number;
  status: ImageDownloadStatus;
  saveAfterLoad: boolean;
  blobUrl: string | null;
  startedAt: number;
}

/**
 * One app-scoped, cancellable image download store. A task is keyed by the owning message + source URL,
 * so the virtualized chat row, fullscreen gallery and global transfer surface always render the same
 * progress instead of starting competing requests.
 */
@Injectable({ providedIn: 'root' })
export class ImageDownloadService {
  private readonly adapter = inject(IMAGE_DOWNLOAD_ADAPTER);
  private readonly mediaSave = inject(MediaSaveService);
  private readonly taskMap = signal<ReadonlyMap<string, ImageDownloadTask>>(
    new Map(),
  );
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly artifacts = new Map<string, ImageDownloadArtifact>();

  readonly tasks = computed(() =>
    [...this.taskMap().values()].sort((a, b) => a.startedAt - b.startedAt),
  );
  readonly activeCount = computed(
    () =>
      this.tasks().filter(
        (task) => task.status === 'downloading' || task.status === 'saving',
      ).length,
  );

  key(media: Pick<AlbumImage, 'msgId' | 'src'>): string {
    return `${media.msgId ?? 0}:${media.src}`;
  }

  task(
    media: Pick<AlbumImage, 'msgId' | 'src'>,
  ): ImageDownloadTask | undefined {
    return this.taskMap().get(this.key(media));
  }

  displayUrl(media: Pick<AlbumImage, 'msgId' | 'src'>): string {
    return this.task(media)?.blobUrl ?? assetUrl(media.src);
  }

  isLoaded(media: Pick<AlbumImage, 'msgId' | 'src'>): boolean {
    return Boolean(this.task(media)?.blobUrl);
  }

  /** Start a load, or upgrade the existing load to "save when ready". */
  start(media: AlbumImage, threadId: number, saveAfterLoad = false): void {
    const key = this.key(media);
    const current = this.taskMap().get(key);
    if (current) {
      if (saveAfterLoad && !current.saveAfterLoad) {
        this.patch(key, { ...current, saveAfterLoad: true });
      }
      if (current.blobUrl && saveAfterLoad) {
        void this.save(key);
        return;
      }
      if (current.status !== 'failed') return;
    }

    const expectedSize = Math.max(0, media.size ?? 0);
    const task: ImageDownloadTask = {
      key,
      threadId,
      msgId: media.msgId ?? 0,
      src: media.src,
      name: media.name || this.defaultFilename(media),
      expectedSize,
      loaded: 0,
      total: expectedSize,
      status: 'downloading',
      saveAfterLoad,
      blobUrl: current?.blobUrl ?? null,
      startedAt: current?.startedAt ?? Date.now(),
    };
    this.patch(key, task);

    this.subscriptions.get(key)?.unsubscribe();
    const subscription = this.adapter.download(media.src).subscribe({
      next: (event) => {
        const live = this.taskMap().get(key);
        if (!live || live.status !== 'downloading') return;
        if (event.type === 'progress') {
          this.patch(key, {
            ...live,
            loaded: Math.max(live.loaded, event.loaded),
            total: event.total ?? live.total,
          });
        } else if (event.type === 'completed') {
          this.artifacts.get(key)?.release();
          this.artifacts.set(key, event.artifact);
          const completed: ImageDownloadTask = {
            ...live,
            loaded: event.artifact.size || live.total || live.expectedSize,
            total: live.total || event.artifact.size || live.expectedSize,
            status: 'loaded',
            blobUrl: event.artifact.displayUrl,
          };
          this.patch(key, completed);
          this.subscriptions.delete(key);
          if (completed.saveAfterLoad) void this.save(key);
        }
      },
      error: () => {
        const live = this.taskMap().get(key);
        if (live) this.patch(key, { ...live, status: 'failed' });
        this.subscriptions.delete(key);
      },
    });
    this.subscriptions.set(key, subscription);
  }

  cancel(media: Pick<AlbumImage, 'msgId' | 'src'>): void {
    const key = this.key(media);
    const task = this.taskMap().get(key);
    if (!task || task.status !== 'downloading') return;
    const subscription = this.subscriptions.get(key);
    // Remove the user-cancelled task before tearing down the adapter. Native bridges may report their
    // abort synchronously during teardown; the error callback must not be able to resurrect that benign
    // cancellation as a failed task (or retain its save-after-load intent).
    this.subscriptions.delete(key);
    this.remove(key);
    subscription?.unsubscribe();
  }

  retry(media: AlbumImage, threadId: number): void {
    this.start(media, threadId, this.task(media)?.saveAfterLoad ?? false);
  }

  async save(key: string): Promise<void> {
    const task = this.taskMap().get(key);
    if (!task?.blobUrl || task.status === 'saving') return;
    this.patch(key, { ...task, status: 'saving', saveAfterLoad: true });
    try {
      await this.mediaSave.save({
        path: this.artifacts.get(key)?.savePath ?? task.blobUrl,
        filename: task.name,
        mimeType: 'image/jpeg',
      });
      const live = this.taskMap().get(key);
      if (live) this.patch(key, { ...live, status: 'saved' });
    } catch (error) {
      const live = this.taskMap().get(key);
      if (live) this.patch(key, { ...live, status: 'failed' });
    }
  }

  private defaultFilename(media: AlbumImage): string {
    return `image-${media.msgId ?? Date.now()}.jpg`;
  }

  private patch(key: string, task: ImageDownloadTask): void {
    const next = new Map(this.taskMap());
    next.set(key, task);
    this.taskMap.set(next);
  }

  private remove(key: string): void {
    const current = this.taskMap().get(key);
    this.artifacts.get(key)?.release();
    this.artifacts.delete(key);
    const next = new Map(this.taskMap());
    next.delete(key);
    this.taskMap.set(next);
  }
}
