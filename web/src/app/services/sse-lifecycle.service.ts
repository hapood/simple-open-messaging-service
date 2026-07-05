import { Injectable, inject } from '@angular/core';
import { WebsocketService } from './websocket.service';
import { isAndroid, isTauri } from './runtime';

/**
 * Mobile-only SSE backgrounding + universal foreground catch-up.
 *
 * On **Tauri Android** the OS suspends the WebView shortly after backgrounding — any held SSE socket
 * dies a half-open death that the server only notices after the 25s heartbeat, and the reconnect thrash
 * on resume wastes resources. So when the Android shell goes hidden we **proactively disconnect** the
 * SSE worker (graceful — the server sees the close immediately and stops treating the user as online).
 * On resume we reconnect, and the existing `reconnect$ → ConversationListService.load()` flow backfills
 * anything missed while away.
 *
 * **PC (Tauri desktop) and browser** keep SSE alive when minimized/hidden (the OS doesn't aggressively
 * suspend them) — per the user's explicit directive that desktop must NOT disconnect. The discriminator
 * is `isTauri() && isAndroid()`.
 *
 * `connect()` is idempotent (no-op when the worker already exists), so calling it on every visible
 * transition is safe across all platforms — on PC it's a no-op, on mobile it respawns the worker.
 */
@Injectable({ providedIn: 'root' })
export class SseLifecycleService {
  private readonly ws = inject(WebsocketService);

  constructor() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private onVisibilityChange = (): void => {
    const mobile = isTauri() && isAndroid();
    if (document.visibilityState === 'hidden') {
      // Mobile backgrounding → graceful SSE close. PC/browser: leave it connected.
      if (mobile) this.ws.disconnect();
    } else if (document.visibilityState === 'visible') {
      // Resume: ensure the SSE worker is up. Idempotent on PC (no-op when already connected); on
      // mobile it respawns the worker that disconnect() tore down. The reconnect$ pulse then
      // triggers ConversationListService.load() (wired in HomeComponent) to backfill missed messages.
      this.ws.connect();
    }
  };
}
