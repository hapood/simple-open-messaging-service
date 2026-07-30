import { Injectable, signal } from '@angular/core';
import {
  createLocalVideoStream,
  type LocalVideoStream,
  nativeVideoThumbnailUrl,
  openNativeVideo,
  videoCasDigest,
} from './runtime';

/** Shared Android video facade for WebView loopback playback and the dormant Media3 path. */
@Injectable({ providedIn: 'root' })
export class NativeVideoService {
  private readonly revisions = signal<Map<string, number>>(new Map());

  constructor() {
    window.__SOMS_VIDEO_THUMBNAIL__ = (digest) => {
      if (!/^[0-9a-f]{64}$/.test(digest)) return;
      this.revisions.update((current) => {
        const next = new Map(current);
        next.set(digest, (next.get(digest) ?? 0) + 1);
        return next;
      });
    };
  }

  async open(path: string): Promise<boolean> {
    try {
      return await openNativeVideo(path);
    } catch {
      return false;
    }
  }

  async stream(path: string): Promise<LocalVideoStream | null> {
    try {
      return await createLocalVideoStream(path);
    } catch {
      return null;
    }
  }

  async captureThumbnail(
    video: HTMLVideoElement,
    stream: LocalVideoStream,
    path: string,
  ): Promise<void> {
    const digest = videoCasDigest(path);
    const key = digest?.slice(0, 12) ?? 'invalid';
    if (stream.hasThumbnail) return;
    if (video.videoWidth < 1 || video.videoHeight < 1) {
      console.warn(
        `[video-thumbnail] capture skipped: no frame dimensions key=${key} readyState=${video.readyState} size=${video.videoWidth}x${video.videoHeight}`,
      );
      return;
    }
    const scale = Math.min(1, 384 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null;
    try {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', 0.74),
      );
    } catch {
      console.warn(`[video-thumbnail] canvas export failed key=${key}`);
      return;
    }
    if (!blob) {
      console.warn(`[video-thumbnail] canvas returned no blob key=${key}`);
      return;
    }
    try {
      const response = await fetch(stream.thumbnailUploadUrl, {
        method: 'POST',
        body: blob,
      });
      if (response.ok && digest) {
        window.__SOMS_VIDEO_THUMBNAIL__?.(digest);
      } else {
        console.warn(
          `[video-thumbnail] upload rejected key=${key} status=${response.status} bytes=${blob.size}`,
        );
      }
    } catch (error) {
      console.warn(
        `[video-thumbnail] upload failed key=${key} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  thumbnailUrl(path: string): string {
    const digest = videoCasDigest(path);
    if (!digest) return '';
    const revision = this.revisions().get(digest) ?? 0;
    return nativeVideoThumbnailUrl(path, revision);
  }
}
