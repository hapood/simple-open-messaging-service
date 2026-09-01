import {
  Injectable,
  signal,
  effect,
  untracked,
  OnDestroy,
  isDevMode,
} from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { apiOrigin, isAndroidNative, isTauri } from './runtime';
import {
  RealtimeTransport,
  type ConnectionState,
  type RealtimeSink,
  type StandardMessage,
} from './realtime-transport';
import { WorkerSseTransport } from './worker-sse.transport';
import { NativeEventTransport } from './native-event.transport';
import { RustChannelSseTransport } from './rust-channel-sse.transport';
import { isFullConsoleLoggingEnabled } from './log-buffer';

// Re-exported for downstream consumers (HttpItemSource, ConnectionBanner, …) that
// already import these from here — the canonical home is now realtime-transport.ts.
export type { StandardMessage, ConnectionState } from './realtime-transport';

/** Dev-build-only diagnostic gate for the [sse] receive trace below. */

/**
 * Realtime downlink facade — the single public surface every consumer already depends on
 * (`eventSubject`, `reconnect$`, `state`, `connect()`, `disconnect()`, `retryNow()`). The actual
 * transport is a pluggable {@link RealtimeTransport} selected once at construction by platform:
 *  - Android (Tauri shell): {@link NativeEventTransport} — consumes Kotlin's `/events` bridge
 *    (`window.__SOMS_EVENT__`); the native RealtimeService owns the connection.
 *  - Tauri desktop (pc/mac/linux): {@link RustChannelSseTransport} — consumes the Rust-side `sse_*`
 *    supervisor; Rust owns the /events connection (survives renderer reclaim, no plugin-http).
 *  - browser: {@link WorkerSseTransport} — spawns `sse.worker.ts` (same-origin, no plugin-http).
 *
 * The facade owns the public subjects/signal and the FORCE_LOGOUT side-effect (re-login); the transport
 * is a pure producer that pushes into them via a {@link RealtimeSink}. Because all three transports
 * speak the same sink contract, downstream consumers are byte-identical across platforms — this class
 * carries no platform branching, only the one-time selection.
 */
@Injectable({
  providedIn: 'root',
})
export class WebsocketService implements OnDestroy {
  readonly eventSubject = new Subject<StandardMessage>();
  /** Reconnect-success pulse: http-item-source subscribes and backfills messages missed during the
   *  disconnect via the newestMsgId cursor. */
  readonly reconnect$ = new Subject<void>();
  /** True only after the current shared /events connection has delivered its HELLO handshake. */
  readonly helloReady$ = new BehaviorSubject(false);
  /** Monotonic HELLO generation used by request coordinators to retry work whose terminal SSE
   * event may have been lost with a previous connection. */
  readonly helloGeneration$ = new BehaviorSubject(0);
  /** Connection state for the shell's connection-lost banner. See {@link ConnectionState}. */
  readonly state = signal<ConnectionState>('closed');
  /** Milliseconds remaining until the next reconnect attempt, or null when not in a scheduled backoff.
   *  Driven by the transports' one-shot {@link RealtimeSink.onReconnectIn} deadline (each transport emits a
   *  single scheduled delay when it enters backoff); this facade owns the live countdown clock and
   *  decrements this signal on a 250ms ticker. The ConnectionBanner reads it to render "reconnecting in Ns".
   *  Cleared on any state that leaves `reconnecting` (see the sink's `onState` wiring). */
  readonly reconnectIn = signal<number | null>(null);

  private readonly transport: RealtimeTransport;
  /** Wall-clock deadline (ms epoch) of the current backoff sleep; 0 when none scheduled. */
  private reconnectDeadline = 0;
  /** The 250ms countdown ticker; undefined when not ticking. */
  private reconnectTicker?: ReturnType<typeof setInterval>;

  /** The deadline within which the server MUST push its HELLO connect handshake after the stream opens.
   *  HELLO carries the stateFeedEndId the state feed replays through and the newest-message cursor the
   *  durable feed catch-up starts from — without it the list cannot build, so a missing HELLO is a hard failure,
   *  not a graceful wait. The server sends HELLO right after flushing headers (sub-second normally); 10s is
   *  a generous threshold that avoids false triggers on slow networks. If it fires the open stream is
   *  treated as unusable: the disconnect surfaces at the connection indicator and the stream is force-
   *  reconnected so the new connection re-pushes HELLO. The existing staleness watchdogs do NOT cover this
   *  — they arm only after the first ping, so an open stream still receiving pings but never HELLO would
   *  hang the threadlist forever. */
  private static readonly HELLO_TIMEOUT_MS = 10_000;
  private helloTimeout?: ReturnType<typeof setTimeout>;
  constructor(private authService: AuthService) {
    // The sink funnels every transport's outputs onto this facade's single subjects/signal (+ the dev
    // trace + the FORCE_LOGOUT re-login side-effect).
    const sink: RealtimeSink = {
      onEvent: (m) => {
        if (m.event === 'HELLO') {
          const hello = m.data as
            | { userId?: unknown; stateFeedEndId?: unknown }
            | undefined;
          if (
            !Number.isSafeInteger(hello?.userId) ||
            Number(hello?.userId) <= 0 ||
            !Number.isSafeInteger(hello?.stateFeedEndId) ||
            Number(hello?.stateFeedEndId) < 0
          ) {
            console.error('[sse] invalid HELLO stateFeedEndId — reconnecting');
            this.state.set('reconnecting');
            this.transport.forceReconnect();
            return;
          }
        }
        if (m.event === 'STATE_FEED_UPDATED') {
          const feedId = (m.data as { feedId?: unknown } | undefined)?.feedId;
          if (!Number.isSafeInteger(feedId) || Number(feedId) < 0) {
            console.error(
              '[sse] invalid STATE_FEED_UPDATED feedId — reconnecting',
            );
            this.state.set('reconnecting');
            this.transport.forceReconnect();
            return;
          }
        }
        // Dev-only: trace every realtime business event, so signal reception is visible under `ng serve`.
        // Gated by isDevMode() → stripped in prod AOT.
        if (isDevMode()) console.log('[sse] recv', m.event, m.data);
        // HELLO landed — the connect handshake succeeded; cancel the deadline that would otherwise force a
        // reconnect. (Intercepted here, before fan-out, so the timeout clears even though the threadlist is
        // the downstream consumer — mirrors how FORCE_LOGOUT is intercepted in each transport.)
        if (m.event === 'HELLO') {
          this.clearHelloTimeout();
          this.helloReady$.next(true);
          this.helloGeneration$.next(this.helloGeneration$.value + 1);
        }
        this.eventSubject.next(m);
      },
      onState: (s) => {
        if (isFullConsoleLoggingEnabled())
          console.info('[sse] realtime state →', s);
        this.state.set(s);
        if (s !== 'open') this.helloReady$.next(false);
        // Leaving the backoff state — drop any live countdown. (Entering `reconnecting` does NOT set a
        // countdown; the transport emits the deadline separately via onReconnectIn.)
        if (s !== 'reconnecting') this.clearReconnectIn();
        // Arm the HELLO deadline when the stream opens; clear it on any other state (the handshake only
        // applies to an open stream, and a teardown/reconnect re-arms on the next 'open').
        if (s === 'open') this.armHelloTimeout();
        else this.clearHelloTimeout();
      },
      onReconnect: () => this.reconnect$.next(),
      onForceLogout: (reason?: string) => this.onForceLogout(reason),
      onReconnectIn: (ms) => this.onReconnectIn(ms),
    };
    // Select the transport ONCE, by platform:
    //  - Android (Tauri shell): NativeEventTransport — consumes Kotlin's /events bridge; the native
    //    RealtimeService owns the connection.
    //  - Tauri desktop (pc/mac/linux): RustChannelSseTransport — consumes the Rust-side `sse_*`
    //    supervisor (src-tauri/src/lib.rs), which owns the /events connection natively. Replaces the
    //    Web-Worker path under Tauri (the worker's cross-origin plugin-http fetch was the source of the
    //    "resource id is invalid" churn).
    //  - browser: WorkerSseTransport — spawns sse.worker.ts (same-origin, no plugin-http).
    this.transport = isAndroidNative()
      ? new NativeEventTransport(sink)
      : isTauri()
        ? new RustChannelSseTransport(sink)
        : new WorkerSseTransport(sink);
    // Reactive realtime lifecycle: open the stream only while authenticated, tear it down on logout.
    // Replaces the old eager boot connect() — on the browser cookie path that fetched /events with no
    // session → 401 → force-logout → a redirect that aborted in-flight requests (the "Uncaught
    // AbortError"). The effect's initial run opens the boot connection when already authenticated;
    // AuthService.loggedIn is the reactive source (true on login/restore, false on logout/expiry).
    effect(() => {
      const online = this.authService.loggedIn();
      untracked(() => {
        online ? this.connect() : this.disconnect();
      });
    });
    // A backend-origin swap (server-config save) repoints every URL live via the apiOrigin signal. The
    // transport captured the OLD sseUrl at its `start`, so reconnect it against the new host: the first
    // run is skipped (the login effect above already opened the boot connection if authenticated), then
    // every change tears the transport down and restarts it reading the now-current sseUrl(). (On
    // Android this is a harmless hook re-register — Kotlin picks up the new origin on its next
    // reconnect.) untracked so the connect()/disconnect() calls don't themselves get wired into the
    // reactive graph.
    let booted = false;
    effect(() => {
      apiOrigin();
      if (!booted) {
        booted = true;
        return;
      }
      untracked(() => {
        this.disconnect();
        this.connect();
      });
    });
  }

  /** Begin receiving (idempotent). On mobile this is called on every visible transition.
   *
   *  No-op while unauthenticated: the realtime stream is meaningless without a session, and on the
   *  browser (cookie auth) opening it pre-login fetches `/events` with no session cookie → a guaranteed
   *  401 → `force-logout` → `redoLoginAuth()` → a same-route redirect that tears down any in-flight
   *  request (the `Uncaught (in promise) AbortError` logged at `login:1`). Gating here covers every
   *  caller — the boot `connect()` below, `HomeComponent` on login, and `SseLifecycleService`'s
   *  visibility handler. The Tauri path already blocks pre-login via the worker's `need-token`
   *  handshake (the worker awaits the first non-null token before fetching); this gate gives the browser
   *  cookie path the same "don't connect until authenticated" contract. (Under Tauri the desktop
   *  `RustChannelSseTransport` blocks pre-login in the Rust supervisor's token wait; Android's
   *  `NativeEventTransport` is driven by Kotlin after login.) */
  public connect() {
    if (!this.authService.isLoggedIn()) return;
    this.transport.start();
  }

  /** Logout / force-login / origin swap: stop the transport and let it clear its state. */
  public disconnect() {
    this.transport.stop();
  }

  /** User-initiated retry (the disconnected chip clicked while `reconnecting`). No-op on platforms whose
   *  transport owns its own backoff (Android). */
  public retryNow(): void {
    this.transport.retryNow();
  }

  /** A transport announced its next reconnect is scheduled in `ms` (emitted once on entering backoff).
   *  Record the wall-clock deadline and arm the countdown ticker that publishes the live remaining-ms onto
   *  {@link reconnectIn}. A non-positive/null value clears it. */
  private onReconnectIn(ms: number | null): void {
    if (ms == null || ms <= 0) {
      this.clearReconnectIn();
      return;
    }
    this.reconnectDeadline = Date.now() + ms;
    this.reconnectIn.set(ms);
    if (this.reconnectTicker) return;
    this.reconnectTicker = setInterval(() => {
      const remaining = Math.max(0, this.reconnectDeadline - Date.now());
      this.reconnectIn.set(remaining);
      if (remaining <= 0) {
        clearInterval(this.reconnectTicker);
        this.reconnectTicker = undefined;
      }
    }, 250);
  }

  /** Drop the countdown: stop the ticker, forget the deadline, null the signal. Called when the state
   *  leaves `reconnecting` and on a non-positive `onReconnectIn` (so a stale deadline can't keep ticking). */
  private clearReconnectIn(): void {
    if (this.reconnectTicker) {
      clearInterval(this.reconnectTicker);
      this.reconnectTicker = undefined;
    }
    this.reconnectDeadline = 0;
    this.reconnectIn.set(null);
  }

  /** Arm the HELLO-handshake deadline — the server must push HELLO within {@link HELLO_TIMEOUT_MS} of the
   *  stream opening. Cleared by HELLO receipt (in the sink's onEvent) or by any state leaving 'open'. */
  private armHelloTimeout(): void {
    this.clearHelloTimeout();
    this.helloTimeout = setTimeout(
      () => this.onHelloTimeout(),
      WebsocketService.HELLO_TIMEOUT_MS,
    );
  }

  private clearHelloTimeout(): void {
    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = undefined;
    }
  }

  /** HELLO never arrived within the deadline — the open stream is unusable (the threadlist cannot build
   *  without the handshake's stateFeedEndId + newest-message cursor). Surface it as a disconnect at the
   *  connection indicator, then force a reconnect so the new connection re-pushes HELLO. */
  private onHelloTimeout(): void {
    this.helloTimeout = undefined;
    console.error(
      `[sse] HELLO not received within ${WebsocketService.HELLO_TIMEOUT_MS}ms — forcing reconnect`,
    );
    this.state.set('reconnecting'); // show disconnected at the indicator
    this.transport.forceReconnect();
  }

  ngOnDestroy(): void {
    this.clearReconnectIn();
    this.clearHelloTimeout();
  }

  /** Server-initiated kick (all-device logout / password change / app-session replaced): drop the transport
   *  + re-run login. `reason` (the revoke reason) is threaded to the login page as a one-shot notice. */
  private onForceLogout(reason?: string): void {
    this.disconnect();
    this.authService.redoLoginAuth(reason);
  }
}
