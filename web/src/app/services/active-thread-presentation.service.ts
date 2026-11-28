import { Injectable, inject } from '@angular/core';
import { AppDataLifetime } from './app-data-lifetime.service';
import { isAndroidNative, isTauri, tauriInvoke } from './runtime';

/** Reports transient selection facts; Rust owns native notification decisions. */
@Injectable({ providedIn: 'root' })
export class ActiveThreadPresentation {
  private readonly appData = inject(AppDataLifetime);

  constructor() {
    this.appData.signal.addEventListener(
      'abort',
      () => {
        if (!this.isDesktop()) return;
        // Teardown clears presentation, not durable state. This is deliberately
        // allowed after admission closes; ordinary reports cannot follow it.
        void this.send(undefined).catch((error) =>
          console.warn('[notification] active selection cleanup failed', error),
        );
      },
      { once: true },
    );
  }

  reportActiveThread(threadId: number | undefined): void {
    if (this.appData.signal.aborted || !this.isDesktop()) return;
    // Reporting presentation must not turn synchronous navigation into async work.
    // This bridge owns IPC failures; there is no result for the caller to consume.
    void this.send(threadId).catch((error) => {
      if (!this.appData.signal.aborted)
        console.warn('[notification] active selection report failed', error);
    });
  }

  private isDesktop(): boolean {
    // Android's UnreadAttentionService reports through SomsFcm instead. Browser
    // notification suppression reads navigation directly, without another store.
    return isTauri() && !isAndroidNative();
  }

  private send(threadId: number | undefined): Promise<void> {
    return tauriInvoke<void>('native_db_set_active_thread', {
      threadId: threadId ?? 0,
    });
  }
}
