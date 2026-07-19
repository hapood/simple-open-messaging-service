import { Injectable, inject } from '@angular/core';
import { WebsocketService } from './websocket.service';
import { isTauri } from './runtime';

/**
 * Foreground catch-up for the WebView-owned SSE worker (browser only).
 *
 * On the **browser** the realtime transport is the in-WebView SSE worker. A Web Worker is NOT throttled
 * on tab hide, so the stream stays alive when minimized/hidden — but a worker that died while hidden
 * needs reconnecting on resume, so every `visible` transition calls `connect()` (idempotent — a no-op
 * when the worker is already up). The accompanying `reconnect$` pulse then drives
 * `ConversationListService.load()` to backfill anything missed while away.
 *
 * Under **Tauri** (Android + desktop) this is a NO-OP: the realtime connection is owned NATIVELY — by
 * Kotlin's `RealtimeService` on Android, by the Rust `sse_*` supervisor on desktop — both decoupled from
 * the WebView's lifecycle. The native/Rust owner keeps the stream alive across fg/bg (and a webview
 * reclaim), so the WebView must not touch the transport here.
 */
@Injectable({ providedIn: 'root' })
export class SseLifecycleService {
  private readonly ws = inject(WebsocketService);

  constructor() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private onVisibilityChange = (): void => {
    // Tauri (Android + desktop): the connection is native/Rust-owned — lifecycle-independent. Do nothing.
    if (isTauri()) return;
    if (document.visibilityState === 'visible') {
      // Resume: ensure the SSE worker is up (idempotent — a no-op when already connected). The
      // reconnect$ pulse triggers ConversationListService.load() to backfill missed messages.
      this.ws.connect();
    }
    // hidden: the worker stays alive (a Web Worker isn't throttled on tab hide) — nothing to do.
  };
}
