import { HttpClient, HttpEventType } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  assetUrl,
  isTauri,
  listenEvent,
  tauriInvoke,
} from './runtime';

export interface ImageDownloadArtifact {
  /** URL used by <img>/PhotoSwipe after the transfer completes. */
  displayUrl: string;
  /** Path passed to the platform save adapter. Web uses the same blob URL; native may use a cache path. */
  savePath: string;
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

/** Browser/PWA transport: XHR-backed HttpClient events provide byte progress; unsubscribe aborts it. */
@Injectable({ providedIn: 'root' })
export class WebImageDownloadAdapter implements ImageDownloadAdapter {
  private readonly http = inject(HttpClient);

  download(path: string): Observable<ImageDownloadEvent> {
    return new Observable<ImageDownloadEvent>((subscriber) => {
      const request = this.http
        .get(assetUrl(path), {
          observe: 'events',
          reportProgress: true,
          responseType: 'blob',
        })
        .subscribe({
          next: (event) => {
            if (event.type === HttpEventType.DownloadProgress) {
              subscriber.next({
                type: 'progress',
                loaded: event.loaded,
                total: event.total ?? null,
              });
            } else if (event.type === HttpEventType.Response && event.body) {
              const blob = event.body;
              const url = URL.createObjectURL(blob);
              subscriber.next({
                type: 'completed',
                artifact: {
                  displayUrl: url,
                  savePath: url,
                  size: blob.size,
                  release: () => URL.revokeObjectURL(url),
                },
              });
              subscriber.complete();
            }
          },
          error: (error) => subscriber.error(error),
        });
      return () => request.unsubscribe();
    });
  }
}

/**
 * Native seam. TauriHttpBackend already keeps authenticated media bytes outside normal browser HTTP
 * concerns, so this compatibility implementation shares the web event adapter today. Rust/Kotlin can
 * replace only this class with command + progress-event + cancel-command plumbing without changing the
 * task store or any UI.
 */
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
      let unlisten: (() => void) | undefined;

      void (async () => {
        unlisten = await listenEvent<{
          taskId: string;
          loaded: number;
          total: number;
        }>('media-download-progress', ({ payload }) => {
          if (payload.taskId !== taskId || disposed) return;
          subscriber.next({
            type: 'progress',
            loaded: payload.loaded,
            total: payload.total > 0 ? payload.total : null,
          });
        });
        if (disposed) {
          unlisten?.();
          return;
        }
        try {
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
              size: result.size,
              release: () => undefined,
            },
          });
          subscriber.complete();
        } catch (error) {
          if (!disposed) subscriber.error(error);
        } finally {
          unlisten?.();
        }
      })();

      return () => {
        disposed = true;
        unlisten?.();
        if (!finished) {
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
    factory: () =>
      isTauri()
        ? inject(NativeImageDownloadAdapter)
        : inject(WebImageDownloadAdapter),
  },
);
