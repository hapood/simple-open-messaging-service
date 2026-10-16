import {
  RealtimeTransport,
  type ConnectionState,
  type RealtimeSink,
  type StandardMessage,
} from './realtime-transport';
import { SSE_EVENT_FORCE_LOGOUT } from './sse-worker-protocol';

/**
 * The Android realtime transport: consumes the `/events` frames Kotlin's RealtimeService forwards via
 * `window.__SOMS_EVENT__(type, data)`. The shared Rust runtime owns the SSE connection (the WebView does
 * NOT open its own worker on Android); this class is a passive listener that re-emits each frame onto the
 * {@link RealtimeSink} in the same `StandardMessage` shape the worker transport produces, so all downstream
 * consumers are identical across platforms.
 *
 * Connection state arrives via `window.__SOMS_CONN_STATE__` (Kotlin pushes connect/reconnect/close). On
 * `start` the current state is seeded from `SomsFcm.getConnState()`, because Kotlin only pushes on
 * *transitions* — a freshly-booted WebView (or a renderer-reclaim reload) would otherwise not know the
 * live state until the next transition, leaving the banner stale.
 *
 * There is no token handshake and no reconnect backoff here: Rust authenticates and owns connection
 * policy; Kotlin supplies OS service/connectivity adapters. `stop` only detaches
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
    // Kotlin → JS: one /events frame. FORCE_LOGOUT is intercepted (the facade re-logs in).
    // Everything else is re-emitted as a
    // StandardMessage in the exact shape the worker transport produces.
    window.__SOMS_EVENT__ = (type: string, data: unknown) => {
      if (type === SSE_EVENT_FORCE_LOGOUT) {
        // The FORCE_LOGOUT frame's `message` carries the revoke reason — e.g. 'device_revoke' when the user
        // signs this session out from the device list. Thread it to the facade so the kicked client can show
        // a reason-aware notice instead of a generic "session ended".
        const reason = (data as { message?: string } | null | undefined)
          ?.message;
        this.sink.onForceLogout(reason);
        return;
      }
      this.sink.onEvent({
        event: type,
        status: 0,
        message: 'new message',
        data,
      } as StandardMessage);
    };
    // Kotlin → JS: connection-state transitions (mirrors the worker's `state` messages). Routed through
    // onConnState so an open-after-the-first also emits the reconnect backfill pulse.
    window.__SOMS_CONN_STATE__ = (state: string) => {
      this.onConnState(state as ConnectionState);
    };
    // Android adapter → JS: the shared runtime's next-reconnect deadline, so the chip can
    // render a live countdown (the facade owns the clock; this just hands it the deadline).
    window.__SOMS_RECONNECT_IN__ = (ms: number) => {
      this.sink.onReconnectIn(ms);
    };
    // Seed the current state — Kotlin won't re-push on a fresh WebView attach. This transport only runs
    // on Android (the facade selects it via isAndroidNative), so SomsFcm is always injected — call it
    // directly; a missing bridge is a wiring bug that should surface, not be swallowed by `?`.
    const live = window.SomsFcm!.getConnState();
    if (live === 'open') {
      // The native stream was RETAINED across this webview attach (renderer reclaim) or the FGS opened it
      // before the webview mounted (cold start). Kotlin pushes conn-state only on TRANSITIONS, so a
      // retained-open stream would never push 'open' to this fresh webview → seed it ourselves (else the
      // banner stays 'closed' despite a live connection). Then replay the cached+merged HELLO: a retained
      // stream does NOT re-push HELLO (sent once per register), yet this webview needs it to bootstrap.
      // (Fresh transport instance → onConnState('open') sets openedOnce without a reconnect pulse; the
      // replayed HELLO clears the facade's handshake timeout.)
      this.onConnState('open');
      window.SomsFcm!.replayHello();
    } else if (live) {
      this.onConnState(live as ConnectionState);
    }
  }

  /** A connection-state transition from Kotlin. Forwards it to the banner, AND emits the reconnect backfill
   *  pulse on every open after the first — so a native reconnect (Android resume after the stream was
   *  dropped, or a transient-drop recovery) drives the SAME downstream backfill the worker transport does:
   *  `ThreadRepository` force-reboots the list snapshot and drains the unified state feed
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
   *  Intent that asks Rust to cancel pending backoff + reconnect at once (parity with the worker's
   *  retry-now and Rust's sse_net). The scheduled backoff is voided, so drop the countdown; a fresh
   *  deadline is pushed on the next failure, success clears it via the state transition. */
  override retryNow(): void {
    this.sink.onReconnectIn(null);
    window.SomsFcm!.retryNow();
  }

  /** Force-reconnect the native stream (the HELLO-timeout path). Unlike {@link retryNow} (which only
   *  cancels pending backoff — a no-op against an already-open stream), this asks Kotlin to CANCEL the open
   *  EventSource and reopen it, because JS cannot close the native socket. The reopen re-pushes HELLO on the
   *  fresh connection. (Default `stop()+start()` is wrong here — it only detaches + re-attaches the JS hooks
   *  and leaves the Kotlin stream untouched.) */
  override forceReconnect(): void {
    window.SomsFcm!.forceReconnect();
  }
}
