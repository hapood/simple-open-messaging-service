import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { SseFrame } from '../../../../shared/sse-client';
import { consumeAppSse } from './sse-client';
import { mediaSource } from '../components/message-cards/media-source';
import { apiPrefix } from './constants';
import type { AlbumMedia } from '../components/message-cards/chat-item';

export type MediaFileProgress = {
  loaded: number;
  total: number | null;
} & (
  | { status: 'downloading'; bytesPerSecond: number }
  | { status: 'pending' | 'ready' | 'failed'; bytesPerSecond: null }
);

/** Each mounted painter owns its observation, never the underlying file download. */
@Injectable({ providedIn: 'root' })
export class MediaFileProgressService {
  observe(media: AlbumMedia): Observable<MediaFileProgress> {
    return new Observable((subscriber) => {
      const source = mediaSource(media.src);
      if (source.kind === 'unmanaged') {
        // Local previews have no server acquisition task to observe.
        subscriber.next({
          status: 'ready',
          loaded: 0,
          total: null,
          bytesPerSecond: null,
        });
        subscriber.complete();
        return;
      }
      const path = `${apiPrefix()}/message/media-file-progress?threadId=${source.threadId}&seq=${source.seq}&digest=${source.digest}`;
      const onFrame = (frame: SseFrame) => {
        if (
          subscriber.closed ||
          frame.event !== 'MEDIA_FILE_DOWNLOAD_PROGRESS' ||
          !frame.data
        )
          return;
        const value: unknown = JSON.parse(frame.data);
        if (!isProgress(value)) throw new Error('Invalid media progress');
        subscriber.next(value);
        if (value.status === 'ready' || value.status === 'failed')
          subscriber.complete();
      };
      const ended = () => {
        if (!subscriber.closed)
          subscriber.error(new Error('Media progress ended before completion'));
      };
      const aborter = new AbortController();
      void consumeAppSse(path, { signal: aborter.signal, onFrame }).then(
        ended,
        (error) => {
          if (!aborter.signal.aborted) subscriber.error(error);
        },
      );
      return () => aborter.abort();
    });
  }
}

function isProgress(value: unknown): value is MediaFileProgress {
  if (!value || typeof value !== 'object') return false;
  const progress = value as Record<string, unknown>;
  if (!isNonNegativeNumber(progress['loaded'])) return false;
  if (progress['total'] !== null && !isNonNegativeNumber(progress['total']))
    return false;

  switch (progress['status']) {
    case 'downloading':
      return isNonNegativeNumber(progress['bytesPerSecond']);
    case 'pending':
    case 'ready':
    case 'failed':
      return progress['bytesPerSecond'] === null;
    default:
      return false;
  }
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
