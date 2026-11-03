import { Injectable } from '@angular/core';
import {
  chatThumbnailUrl,
  createLocalVideoStream,
  type LocalVideoStream,
  openNativeVideo,
} from './runtime';

/** Video playback shares the authenticated native cache; posters come from the server. */
@Injectable({ providedIn: 'root' })
export class NativeVideoService {
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

  thumbnailUrl(path: string): string {
    return chatThumbnailUrl(path);
  }
}
