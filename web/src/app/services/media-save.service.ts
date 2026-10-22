import { Injectable } from '@angular/core';
import {
  assetUrl,
  isAndroidNative,
  isTauri,
  tauriInvoke,
} from './runtime';

export interface SaveMediaRequest {
  path: string;
  filename: string;
  mimeType?: string;
}

/** The user closed the platform save picker without choosing a destination. */
export class MediaSaveCancelledError extends Error {
  constructor() {
    super('Media save was cancelled');
    this.name = 'MediaSaveCancelledError';
  }
}

/**
 * One business-level media save API with deliberately separate platform transports:
 * browser/PWA keeps native HTTP download semantics; Tauri reuses the Rust media cache, then exposes
 * the cached file through the platform's public-file API.
 */
@Injectable({ providedIn: 'root' })
export class MediaSaveService {
  private readonly pendingAndroidSaves = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  constructor() {
    window.__SOMS_MEDIA_SAVE_RESULT__ = ({
      requestId,
      success,
      cancelled,
    }) => {
      const pending = this.pendingAndroidSaves.get(requestId);
      if (!pending) return;
      this.pendingAndroidSaves.delete(requestId);
      if (success) pending.resolve();
      else if (cancelled) pending.reject(new MediaSaveCancelledError());
      else pending.reject(new Error('Android document save was cancelled or failed'));
    };
  }

  async save(request: SaveMediaRequest): Promise<void> {
    if (!isTauri()) {
      this.saveInBrowser(request);
      return;
    }

    if (isAndroidNative()) {
      const cached = await tauriInvoke<{ path: string }>('cache_media', {
        path: request.path,
      });
      const requestId = crypto.randomUUID();
      const legacyResult = new Promise<void>((resolve, reject) => {
        this.pendingAndroidSaves.set(requestId, { resolve, reject });
      });
      const saved = window.SomsMedia?.save(
        requestId,
        cached.path,
        request.filename,
        request.mimeType ?? '',
      );
      if (!saved) {
        this.pendingAndroidSaves.delete(requestId);
        throw new Error('Android media save bridge is unavailable');
      }
      if (saved === 'pending') await legacyResult;
      else this.pendingAndroidSaves.delete(requestId);
      return;
    }

    await tauriInvoke<string>('save_media_desktop', {
      path: request.path,
      filename: request.filename,
    });
  }

  private saveInBrowser(request: SaveMediaRequest): void {
    const anchor = document.createElement('a');
    anchor.href = assetUrl(request.path);
    anchor.download = request.filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}
