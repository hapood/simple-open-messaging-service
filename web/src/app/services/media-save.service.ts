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
function isMediaSaveCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('media save cancelled');
}

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
    { resolve: (destination: string | null) => void; reject: (error: Error) => void }
  >();

  constructor() {
    window.__SOMS_MEDIA_SAVE_RESULT__ = ({
      requestId,
      success,
      cancelled,
      destination,
    }) => {
      const pending = this.pendingAndroidSaves.get(requestId);
      if (!pending) return;
      this.pendingAndroidSaves.delete(requestId);
      if (success) pending.resolve(destination ?? null);
      else if (cancelled) pending.reject(new MediaSaveCancelledError());
      else pending.reject(new Error('Android document save was cancelled or failed'));
    };
  }

  async save(request: SaveMediaRequest, taskId = ''): Promise<string | null> {
    if (!isTauri()) {
      this.saveInBrowser(request);
      return null;
    }

    if (isAndroidNative()) {
      const requestId = crypto.randomUUID();
      const saveResult = new Promise<string | null>((resolve, reject) => {
        this.pendingAndroidSaves.set(requestId, { resolve, reject });
      });
      try {
        const saved = window.SomsMedia?.save(
          requestId,
          request.path,
          request.filename,
          request.mimeType ?? '',
          taskId,
        );
        if (!saved) throw new Error('Android media save bridge is unavailable');
        if (saved === 'pending') return await saveResult;
        return null;
      } finally {
        this.pendingAndroidSaves.delete(requestId);
      }
    }

    try {
      return await tauriInvoke<string>('save_media_desktop', {
        path: request.path,
        filename: request.filename,
        taskId: taskId || null,
      });
    } catch (error) {
      if (isMediaSaveCancelled(error)) throw new MediaSaveCancelledError();
      throw error;
    }
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
