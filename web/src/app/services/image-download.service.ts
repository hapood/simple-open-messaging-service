import { Injectable, computed, inject, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import type { AlbumImage } from '../components/message-cards/chat-item';
import {
  MediaSaveCancelledError,
  MediaSaveService,
} from './media-save.service';
import {
  assetUrl,
  cachedChatThumbnailUrl,
  chatThumbnailUrl,
  isTauri,
  listenEvent,
} from './runtime';
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
  private static readonly PROGRESS_PAINT_INTERVAL_MS = 100;
  private readonly adapter = inject(IMAGE_DOWNLOAD_ADAPTER);
  private readonly mediaSave = inject(MediaSaveService);
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
  private readonly thumbnailRevisions = signal<ReadonlyMap<string, number>>(
    new Map(),
  );
  readonly thumbnailVersion = signal(0);

  readonly tasks = computed(() =>
    [...this.taskMap().values()].sort((a, b) => a.startedAt - b.startedAt),
  );
  readonly activeCount = computed(
    () =>
      this.tasks().filter(
        (task) => task.status === 'downloading' || task.status === 'saving',
      ).length,
  );

  constructor() {
    if (!isTauri()) return;
    void listenEvent<{ sourcePath?: string }>(
      'chat-thumbnail-ready',
      ({ payload }) => {
        const sourcePath = payload?.sourcePath;
        if (!sourcePath?.startsWith('/uploads/')) return;
        const next = new Map(this.thumbnailRevisions());
        next.set(sourcePath, (next.get(sourcePath) ?? 0) + 1);
        this.thumbnailRevisions.set(next);
        this.thumbnailVersion.update((value) => value + 1);
      },
    );
  }

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

  /** Lightweight list-card representation. Detail/gallery/save callers deliberately keep displayUrl(),
   * whose contract is the original media. Optimistic blob/data URLs pass through unchanged. */
  thumbnailUrl(media: Pick<AlbumImage, 'msgId' | 'src'>): string {
    const base = chatThumbnailUrl(media.src);
    const revision = this.thumbnailRevisions().get(media.src) ?? 0;
    if (revision === 0 || !base.includes('/chat-thumbnails/')) return base;
    return `${base}${base.includes('?') ? '&' : '?'}v=${revision}`;
  }

  /** Returns only already-local bytes: an in-memory completed download or a native cache-only URL. */
  cachedThumbnailUrl(media: Pick<AlbumImage, 'msgId' | 'src'>): string {
    const loaded = this.task(media)?.blobUrl;
    if (loaded) return loaded;
    const base = cachedChatThumbnailUrl(media.src);
    const revision = this.thumbnailRevisions().get(media.src) ?? 0;
    if (!base || revision === 0) return base;
    return `${base}${base.includes('?') ? '&' : '?'}v=${revision}`;
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
          if (completed.saveAfterLoad) void this.save(key);
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

  cancel(media: Pick<AlbumImage, 'msgId' | 'src'>): void {
    const key = this.key(media);
    const task = this.taskMap().get(key);
    if (!task || task.status !== 'downloading') return;
    const subscription = this.subscriptions.get(key);
    // Remove the user-cancelled task before tearing down the adapter. Native bridges may report their
    // abort synchronously during teardown; the error callback must not be able to resurrect that benign
    // cancellation as a failed task (or retain its save-after-load intent).
    this.subscriptions.delete(key);
    this.clearProgressThrottle(key);
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
      if (!live) return;
      this.patch(
        key,
        error instanceof MediaSaveCancelledError
          ? { ...live, status: 'loaded', saveAfterLoad: false }
          : { ...live, status: 'failed' },
      );
    }
  }

  private defaultFilename(media: AlbumImage): string {
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
