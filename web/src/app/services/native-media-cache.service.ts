import { Injectable, signal } from '@angular/core';
import {
  clearNativeMediaCache,
  isAndroidNative,
  isTauri,
  tauriInvoke,
} from './runtime';

export interface NativeMediaCacheInfo {
  limitMb: number;
  usedBytes: number;
}

export const MEDIA_CACHE_LIMIT_OPTIONS_MB = [128, 256, 512, 1024, 2048] as const;

/** Settings facade for the authoritative Rust media cache. Browser/PWA deliberately has no instance
 * of this cache and continues to rely on standard private HTTP caching. */
@Injectable({ providedIn: 'root' })
export class NativeMediaCacheService {
  private readonly infoState = signal<NativeMediaCacheInfo>({
    limitMb: 512,
    usedBytes: 0,
  });
  readonly info = this.infoState.asReadonly();
  readonly available = isTauri();

  constructor() {
    if (this.available) void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.available) return;
    this.infoState.set(
      await tauriInvoke<NativeMediaCacheInfo>('get_media_cache_info'),
    );
  }

  async setLimit(limitMb: number): Promise<void> {
    if (!this.available) return;
    this.infoState.set(
      await tauriInvoke<NativeMediaCacheInfo>('set_media_cache_limit', {
        limitMb,
      }),
    );
  }

  async clear(): Promise<void> {
    if (!this.available) return;
    this.infoState.set(
      await tauriInvoke<NativeMediaCacheInfo>('clear_media_cache'),
    );
    // Android WebView may retain a second, non-authoritative decoded/HTTP cache. Clear it too so the
    // media-cache action also clears the WebView's decoded media; durable profile avatar files stay intact.
    if (isAndroidNative()) clearNativeMediaCache();
  }
}
