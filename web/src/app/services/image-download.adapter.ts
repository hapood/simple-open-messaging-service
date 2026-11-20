import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  assetUrl,
  listenEvent,
  tauriInvoke,
} from './runtime';

export interface ImageDownloadArtifact {
  /** URL used by <img>/PhotoSwipe after the transfer completes. */
  displayUrl: string;
  /** Canonical resource path passed to the native save adapter; never a renderer-owned Blob URL. */
  savePath: string;
  contentType: string | null;
  size: number;
  release(): void;
}

export type ImageDownloadEvent =
  | { type: 'progress'; loaded: number; total: number | null }
  | { type: 'completed'; artifact: ImageDownloadArtifact };

export interface ImageDownloadAdapter {
  /**
   * Unsubscribing MUST abort the active platform transfer. This is the sole cancellation contract
   * consumed by ImageDownloadService.
   */
  download(path: string): Observable<ImageDownloadEvent>;
}

/** Rust-owned media cache download transport. Browser image loading never uses this adapter. */
@Injectable({ providedIn: 'root' })
export class NativeImageDownloadAdapter implements ImageDownloadAdapter {
  download(path: string): Observable<ImageDownloadEvent> {
    return new Observable<ImageDownloadEvent>((subscriber) => {
      const taskId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `media-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let disposed = false;
      let finished = false;
      let started = false;
      let unlisten: (() => void) | undefined;
      const releaseListener = () => {
        const release = unlisten;
        unlisten = undefined;
        release?.();
      };

      void (async () => {
        try {
        unlisten = await listenEvent<{
          taskId: string;
          loaded: number;
          total: number | null;
        }>('media-download-progress', ({ payload }) => {
          if (payload.taskId !== taskId || disposed) return;
          subscriber.next({
            type: 'progress',
            loaded: payload.loaded,
            total: payload.total,
          });
        });
        if (disposed) return;
          started = true;
          const result = await tauriInvoke<{
            path: string;
            contentType?: string;
            size: number;
          }>('download_media', { path, taskId });
          if (disposed) return;
          finished = true;
          subscriber.next({
            type: 'completed',
            artifact: {
              // assetUrl canonicalizes the authenticated /uploads path to media:// under Tauri. Rust
              // has completed the same cache entry, so the scheme handler serves local bytes.
              displayUrl: assetUrl(path),
              // Existing save commands deliberately accept the canonical remote path and resolve its
              // private cache identity internally; no raw file:// path is exposed to the WebView.
              savePath: path,
              contentType: result.contentType ?? null,
              size: result.size,
              release: () => undefined,
            },
          });
          subscriber.complete();
        } catch (error) {
          finished = true;
          if (!disposed) subscriber.error(error);
        } finally {
          releaseListener();
        }
      })();

      return () => {
        disposed = true;
        releaseListener();
        if (started && !finished) {
          void tauriInvoke('cancel_media_download', { taskId }).catch(
            () => undefined,
          );
        }
      };
    });
  }
}

export const IMAGE_DOWNLOAD_ADAPTER = new InjectionToken<ImageDownloadAdapter>(
  'IMAGE_DOWNLOAD_ADAPTER',
  {
    providedIn: 'root',
    factory: () => inject(NativeImageDownloadAdapter),
  },
);
