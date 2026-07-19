import {
  RealtimeTransport,
  type ConnectionState,
  type RealtimeSink,
  type StandardMessage,
} from './realtime-transport';
import { SSE_EVENT_FORCE_LOGOUT, SSE_EVENT_PING } from './sse-worker-protocol';

/**
 * The Android realtime transport: consumes the `/events` frames Kotlin's RealtimeService forwards via
 * `window.__SOMS_EVENT__(type, data)`. The native service owns the single SSE connection (the WebView does
 * NOT open its own worker on Android); this class is a passive listener that re-emits each frame onto the
 * {@link RealtimeSink} in the same `StandardMessage` shape the worker transport produces, so all downstream
 * consumers are identical across platforms.
 *
 * Connection state arrives via `window.__SOMS_CONN_STATE__` (Kotlin pushes connect/reconnect/close). On
 * `start` the current state is seeded from `SomsFcm.getConnState()`, because Kotlin only pushes on
 * *transitions* — a freshly-booted WebView (or a renderer-reclaim reload) would otherwise not know the
 * live state until the next transition, leaving the banner stale.
 *
 * There is no token handshake and no reconnect backoff here: Kotlin authenticates `/events` with the
 * session token it already holds and owns its own backoff + `START_STICKY` restart. `stop` only detaches
 * the JS listeners (logout / origin swap) — it does NOT close the native stream, whose lifecycle is
 * independent (driven by `SomsFcm.setSessionToken` + fg/bg).
 */
export class NativeEventTransport extends RealtimeTransport {
  /** Guards idempotent start/stop (the facade may call start on every visibility transition). */
  private installed = false;
  /** Mirrors the worker's `openedOnce`: only an open AFTER the first emits the reconnect backfill pulse, so
   *  the initial connect doesn't spuriously fire `reconnect$` (downstream boots the list + catch-up itself
   *  via its own DB-ready trigger). Reset on `stop` so a fresh start treats the next open as the first. */
  private openedOnce = false;

  start(): void {
    if (this.installed) return;
    this.installed = true;
    // Kotlin → JS: one /events frame. FORCE_LOGOUT is intercepted (the facade re-logs in); ping is
    // skipped defensively (Kotlin already drops it before forwarding). Everything else is re-emitted as a
    // StandardMessage in the exact shape the worker transport produces.
    window.__SOMS_EVENT__ = (type: string, data: unknown) => {
      if (type === SSE_EVENT_PING) return;
      if (type === SSE_EVENT_FORCE_LOGOUT) {
        // The FORCE_LOGOUT frame's `message` carries the revoke reason — e.g. 'device_revoke' when the user
        // signs this session out from the device list. Thread it to the facade so the kicked client can show
        // a reason-aware notice instead of a generic "session ended".
        const reason = (data as { message?: string } | null | undefined)?.message;
        this.sink.onForceLogout(reason);
        return;
      }
      this.sink.onEvent({ event: type, status: 0, message: 'new message', data } as StandardMessage);
    };
    // Kotlin → JS: connection-state transitions (mirrors the worker's `state` messages). Routed through
    // onConnState so an open-after-the-first also emits the reconnect backfill pulse.
    window.__SOMS_CONN_STATE__ = (state: string) => {
      this.onConnState(state as ConnectionState);
    };
    // Kotlin → JS: the scheduled-ms-until-next-reconnect from `scheduleReopen`'s backoff, so the chip can
    // render a live countdown (the facade owns the clock; this just hands it the deadline).
    window.__SOMS_RECONNECT_IN__ = (ms: number) => {
      this.sink.onReconnectIn(ms);
    };
    // Seed the current state — Kotlin won't re-push on a fresh WebView attach. This transport only runs
    // on Android (the facade selects it via isAndroidNative), so SomsFcm is always injected — call it
    // directly; a missing bridge is a wiring bug that should surface, not be swallowed by `?`.
    const live = window.SomsFcm!.getConnState();
    if (live) this.onConnState(live as ConnectionState);
  }

  /** A connection-state transition from Kotlin. Forwards it to the banner, AND emits the reconnect backfill
   *  pulse on every open after the first — so a native reconnect (Android resume after the stream was
   *  dropped, or a transient-drop recovery) drives the SAME downstream backfill the worker transport does:
   *  `ThreadRepository` force-reboots the list snapshot, and `MissedSyncService` catches up missed message
   *  bodies. Without this, `reconnect$` (and thus post-resume catch-up) would be dead on Android, since the
   *  native transport owns no connection of its own to observe. */
  private onConnState(state: ConnectionState): void {
    this.sink.onState(state);
    if (state === 'open') {
      if (this.openedOnce) this.sink.onReconnect();
      else this.openedOnce = true;
    }
  }

  stop(): void {
    if (!this.installed) return;
    this.installed = false;
    this.openedOnce = false;
    // Detach the listeners so Kotlin's forwarded frames become no-ops (`window.__SOMS_EVENT__ && ...`).
    // The native stream itself is untouched — Kotlin's service lifecycle is independent of the JS hooks.
    window.__SOMS_EVENT__ = undefined;
    window.__SOMS_CONN_STATE__ = undefined;
    window.__SOMS_RECONNECT_IN__ = undefined;
    this.sink.onState('closed');
  }

  /** User-initiated retry (the disconnected chip). Routes through `SomsFcm.retryNow()` → an ACTION_RETRY
   *  Intent that cancels Kotlin's pending backoff + reconnects at once (parity with the worker's
   *  retry-now and Rust's sse_net). The scheduled backoff is voided, so drop the countdown; a fresh
   *  deadline is pushed on the next failure, success clears it via the state transition. */
  override retryNow(): void {
    this.sink.onReconnectIn(null);
    window.SomsFcm!.retryNow();
  }
}
