import { Injectable, inject } from '@angular/core';
import { WebsocketService } from './websocket.service';
import { isAndroidNative } from './runtime';

/**
 * Foreground catch-up for the WebView-owned SSE worker (browser + desktop).
 *
 * On **browser + Tauri desktop (pc/mac/linux)** the realtime transport is the in-WebView SSE worker. A
 * Web Worker is NOT throttled on tab hide, so the stream stays alive when minimized/hidden — but a worker
 * that died while hidden needs reconnecting on resume, so every `visible` transition calls `connect()`
 * (idempotent — a no-op when the worker is already up). The accompanying `reconnect$` pulse then drives
 * `ConversationListService.load()` to backfill anything missed while away.
 *
 * On **Android** this is a NO-OP: the realtime connection is owned by Kotlin's `RealtimeService`
 * (continuous fg/bg), and the WebView's `NativeEventTransport` is a passive listener on
 * `window.__SOMS_EVENT__`. The fg/bg connection lifecycle (promote to FGS on background, drop the
 * persistent notification on resume) is driven by `MainActivity.onResume/onStop`, NOT by the WebView's
 * visibility — so the WebView must not touch the transport here.
 */
@Injectable({ providedIn: 'root' })
export class SseLifecycleService {
  private readonly ws = inject(WebsocketService);

  constructor() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private onVisibilityChange = (): void => {
    // Android: Kotlin owns the connection; the WebView is a passive listener — do nothing.
    if (isAndroidNative()) return;
    if (document.visibilityState === 'visible') {
      // Resume: ensure the SSE worker is up (idempotent — a no-op when already connected). The
      // reconnect$ pulse triggers ConversationListService.load() to backfill missed messages.
      this.ws.connect();
    }
    // hidden: the worker stays alive (a Web Worker isn't throttled on tab hide) — nothing to do.
  };
}
