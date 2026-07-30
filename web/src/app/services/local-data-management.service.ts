import { Injectable } from '@angular/core';
import { isAndroidNative, isTauri, tauriInvoke, clearNativeMediaCache } from './runtime';

/** Destructive device-wide local-data operations exposed only through the Settings confirmation flow. */
@Injectable({ providedIn: 'root' })
export class LocalDataManagementService {
  async clearAll(): Promise<void> {
    if (!isTauri()) return;
    await Promise.all([
      tauriInvoke('native_db_clear_all'),
      tauriInvoke('clear_media_cache'),
    ]);
    if (isAndroidNative()) clearNativeMediaCache();
  }
}
