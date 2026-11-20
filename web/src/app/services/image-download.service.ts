import { Injectable, computed, inject, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import type { AlbumMedia } from '../components/message-cards/chat-item';
import { assetUrl, chatThumbnailUrl, isTauri } from './runtime';
import {
  IMAGE_DOWNLOAD_ADAPTER,
  type ImageDownloadArtifact,
} from './image-download.adapter';

type ImageDownloadStatus =
  | 'downloading'
  | 'loaded'
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
  blobUrl: string | null;
  startedAt: number;
}

/**
 * Native image-preview cache requests shared by virtualized rows and the fullscreen gallery.
 * User-initiated saves belong to DownloadService; browser images use ordinary resource URLs.
 */
@Injectable({ providedIn: 'root' })
export class ImageDownloadService {
  private static readonly PROGRESS_PAINT_INTERVAL_MS = 100;
  private readonly adapter = inject(IMAGE_DOWNLOAD_ADAPTER);
  private readonly taskMap = signal<ReadonlyMap<string, ImageDownloadTask>>(
    new Map(),
  );
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly artifacts = new Map<string, ImageDownloadArtifact>();
  private readonly progressTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly pendingProgress = new Map<
    string,
    { loaded: number; total: number | null }
  >();
  private readonly lastProgressPaint = new Map<string, number>();

  readonly tasks = computed(() =>
    [...this.taskMap().values()].sort((a, b) => a.startedAt - b.startedAt),
  );
  readonly activeCount = computed(
    () =>
      this.tasks().filter(
        (task) => task.status === 'downloading',
      ).length,
  );

  key(media: Pick<AlbumMedia, 'msgId' | 'src'>): string {
    return `${media.msgId ?? 0}:${media.src}`;
  }

  task(
    media: Pick<AlbumMedia, 'msgId' | 'src'>,
  ): ImageDownloadTask | undefined {
    return this.taskMap().get(this.key(media));
  }

  displayUrl(media: Pick<AlbumMedia, 'msgId' | 'src'>): string {
    return this.task(media)?.blobUrl ?? assetUrl(media.src);
  }

  /** Lightweight list-card representation. Detail/gallery/save callers deliberately keep displayUrl(),
   * whose contract is the original media. Optimistic blob/data URLs pass through unchanged. */
  thumbnailUrl(media: Pick<AlbumMedia, 'msgId' | 'src'>): string {
    return chatThumbnailUrl(media.src);
  }

  isLoaded(media: Pick<AlbumMedia, 'msgId' | 'src'>): boolean {
    return Boolean(this.task(media)?.blobUrl);
  }

  /** Load an original image into the native preview cache. Saving is a separate download task. */
  start(media: AlbumMedia, threadId: number): void {
    if (!isTauri()) throw new Error('Browser images are loaded by the browser, not a download task');
    const key = this.key(media);
    const current = this.taskMap().get(key);
    if (current) {
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
          this.publishProgress(key, event.loaded, event.total);
        } else if (event.type === 'completed') {
          this.clearProgressThrottle(key);
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
        }
      },
      error: () => {
        this.clearProgressThrottle(key);
        const live = this.taskMap().get(key);
        if (live) this.patch(key, { ...live, status: 'failed' });
        this.subscriptions.delete(key);
      },
    });
    this.subscriptions.set(key, subscription);
  }

  cancel(media: Pick<AlbumMedia, 'msgId' | 'src'>): void {
    const key = this.key(media);
    const task = this.taskMap().get(key);
    if (!task || task.status !== 'downloading') return;
    const subscription = this.subscriptions.get(key);
    // Remove the user-cancelled task before tearing down the adapter. Native bridges may report their
    // abort synchronously during teardown; the error callback must not be able to resurrect that benign
    // cancellation as a failed task.
    this.subscriptions.delete(key);
    this.clearProgressThrottle(key);
    this.remove(key);
    subscription?.unsubscribe();
  }

  retry(media: AlbumMedia, threadId: number): void {
    this.start(media, threadId);
  }

  private defaultFilename(media: AlbumMedia): string {
    return `image-${media.msgId ?? Date.now()}.jpg`;
  }

  private publishProgress(
    key: string,
    loaded: number,
    total: number | null,
  ): void {
    const now = Date.now();
    const lastPaint = this.lastProgressPaint.get(key) ?? 0;
    const elapsed = now - lastPaint;
    if (elapsed >= ImageDownloadService.PROGRESS_PAINT_INTERVAL_MS) {
      this.paintProgress(key, loaded, total);
      return;
    }

    const pending = this.pendingProgress.get(key);
    this.pendingProgress.set(key, {
      loaded: Math.max(pending?.loaded ?? 0, loaded),
      total: total ?? pending?.total ?? null,
    });
    if (this.progressTimers.has(key)) return;

    const timer = setTimeout(() => {
      this.progressTimers.delete(key);
      const next = this.pendingProgress.get(key);
      this.pendingProgress.delete(key);
      if (next) this.paintProgress(key, next.loaded, next.total);
    }, ImageDownloadService.PROGRESS_PAINT_INTERVAL_MS - elapsed);
    this.progressTimers.set(key, timer);
  }

  private paintProgress(
    key: string,
    loaded: number,
    total: number | null,
  ): void {
    const live = this.taskMap().get(key);
    if (!live || live.status !== 'downloading') return;
    this.lastProgressPaint.set(key, Date.now());
    this.patch(key, {
      ...live,
      loaded: Math.max(live.loaded, loaded),
      total: total ?? live.total,
    });
  }

  private clearProgressThrottle(key: string): void {
    const timer = this.progressTimers.get(key);
    if (timer) clearTimeout(timer);
    this.progressTimers.delete(key);
    this.pendingProgress.delete(key);
    this.lastProgressPaint.delete(key);
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
