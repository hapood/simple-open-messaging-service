import {
  RealtimeTransport,
  type ConnectionState,
  type RealtimeSink,
  type StandardMessage,
} from './realtime-transport';
import { listenEvent, tauriInvoke } from './runtime';

/**
 * The Tauri DESKTOP realtime transport: consumes the `/events` frames + connection-state transitions a
 * Rust-side supervisor (src-tauri/src/lib.rs `sse_*` commands) pushes over Tauri events. The supervisor
 * owns the long-lived SSE connection (reqwest holds `/api/v1/events`, reads the Bearer straight from
 * `ProxyState.token`, runs its own backoff + watchdog + 401→force-logout); this class is a passive
 * listener that re-emits what Rust pushes, in the same `StandardMessage` shape the worker + native
 * transports produce — so every downstream consumer is identical across the three platforms.
 *
 * Why this exists (and replaces the desktop Web-Worker path under Tauri): the worker fetched the SSE
 * stream cross-origin through `tauri-plugin-http`, whose `__TAURI_CHANNEL__` teardown raced on every
 * reconnect and cancelled request (the "resource id is invalid" console flood). Rust owns the socket
 * instead — decoupled from the renderer (it survives a webview reclaim, tied to the AppHandle), and it
 * never touches plugin-http. The webview selects this transport for `isTauri() && !isAndroid` (Android
 * still uses {@link NativeEventTransport} — Kotlin owns SSE there); the browser still uses
 * {@link WorkerSseTransport}.
 *
 * `sse_start` is called eagerly at boot (before login); the supervisor blocks on `ProxyState.token`
 * internally until login provides one — no token handshake here (mirrors Android's model). `stop` only
 * tells Rust to cancel + detaches the JS listeners; it does not outlive the SPA. The `openedOnce`
 * reconnect pulse is emitted by Rust as a dedicated `soms-sse-reconnect` event (Rust owns that logic
 * since it owns the connection), so — unlike {@link NativeEventTransport} — this class does NOT track
 * `openedOnce` itself; it just forwards the four events.
 */
export class RustChannelSseTransport extends RealtimeTransport {
  /** Guards idempotent start/stop (the facade may call start on every visibility transition + origin swap). */
  private installed = false;
  /** Unlisten handles for the four Rust→JS events, detached on stop(). */
  private readonly unlisteners: Array<() => void> = [];
  /** navigator online/offline → `sse_net` so Rust detects a dropped network before the 60s watchdog. */
  private readonly onOnline = (): void => {
    void tauriInvoke('sse_net', { online: true });
  };
  private readonly onOffline = (): void => {
    void tauriInvoke('sse_net', { online: false });
  };

  start(): void {
    if (this.installed) return;
    this.installed = true;
    // Fire-and-forget: the abstract contract is `start(): void`, but the listener registration + the
    // start/seed invokes are async. They run in the background; the banner shows the seeded state as
    // soon as `sse_get_state` resolves.
    void this.startAsync();
  }

  private async startAsync(): Promise<void> {
    // Rust → JS: state transitions, business events, the reconnect backfill pulse, force-logout, and the
    // scheduled-backoff deadline for the countdown chip. (Rust emits `soms-sse-reconnect` itself on
    // reconnect opens — no `openedOnce` inference here.)
    const subs: Array<Promise<(() => void) | undefined>> = [
      listenEvent<ConnectionState>('soms-sse-state', (e) =>
        this.sink.onState(e.payload),
      ),
      listenEvent<StandardMessage>('soms-sse-event', (e) =>
        this.sink.onEvent(e.payload),
      ),
      listenEvent('soms-sse-reconnect', () => this.sink.onReconnect()),
      listenEvent<{ reason?: string }>('soms-sse-force-logout', (e) =>
        this.sink.onForceLogout(e.payload?.reason),
      ),
      listenEvent<number>('soms-sse-reconnect-in', (e) =>
        this.sink.onReconnectIn(e.payload),
      ),
    ];
    for (const sub of subs) {
      const un = await sub;
      if (un) this.unlisteners.push(un);
    }
    if (!this.installed) return; // stop() won the race while we were subscribing — detach happens there

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }

    // Idempotent: a no-op if the supervisor is already running (renderer-reclaim re-attach after a
    // webview reload — the Rust stream kept running across the reclaim).
    await tauriInvoke('sse_start');

    // Seed the banner: Rust only pushes state on *transitions*, so without this a freshly-booted
    // renderer wouldn't know the live state until the next transition (mirrors Android's
    // `SomsFcm.getConnState()` seed in NativeEventTransport).
    const live = await tauriInvoke<string>('sse_get_state');
    if (!this.installed) return; // stop() won the race while we were subscribing — the seed is stale
    if (live === 'open') {
      // The connection was RETAINED across this webview attach (renderer reclaim) or the supervisor opened
      // it before the webview mounted (cold start). The supervisor emits state only on TRANSITIONS, so a
      // retained-open connection would never push 'open' to this fresh webview → seed it ourselves (else the
      // banner stays 'closed' despite a live connection). Then replay the cached+merged HELLO: a retained
      // connection does NOT re-push HELLO (sent once per register), yet this webview needs it to bootstrap.
      // Seeding 'open' re-arms the facade's HELLO-timeout; the replayed HELLO clears it (cache empty → the
      // timeout backstop force-reconnects for a fresh one).
      this.sink.onState('open');
      await tauriInvoke('sse_replay_hello');
    } else if (live) {
      this.sink.onState(live as ConnectionState);
    }
  }

  stop(): void {
    if (!this.installed) return;
    this.installed = false;
    for (const un of this.unlisteners) {
      try {
        un();
      } catch {
        /* listener already gone — best-effort */
      }
    }
    this.unlisteners.length = 0;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
    void tauriInvoke('sse_stop'); // cancel the supervisor (promptly — every await is cancel-aware)
    this.sink.onState('closed');
  }

  /** User-initiated retry (the disconnected chip). Routes through `sse_net(online)` so the supervisor
   *  resets its backoff + retries at once (it owns the connection, like Android's Kotlin service). The
   *  scheduled backoff is voided, so drop the countdown immediately; a fresh deadline is emitted on the
   *  next failure, and success clears it via the state event. */
  override retryNow(): void {
    this.sink.onReconnectIn(null);
    void (async () => {
      const state = await tauriInvoke<string>('sse_get_state');
      if (state === 'closed') {
        // An SSE_REPLACED shutdown exits the supervisor, rather than entering
        // backoff. An explicit retry must replace its completed task.
        await tauriInvoke('sse_stop');
        await tauriInvoke('sse_start');
      } else {
        await tauriInvoke('sse_net', { online: true });
      }
    })();
  }
}
