/**
 * The realtime downlink transport abstraction — the adapter that hides platform differences behind one
 * polymorphic surface. The facade ({@link WebsocketService}) selects ONE implementation at construction
 * by platform and delegates `start`/`stop`/`retryNow` to it; both implementations push into the same
 * {@link RealtimeSink}, so the public `eventSubject`/`state`/`reconnect$` are platform-agnostic and every
 * downstream consumer (HttpItemSource, GroupEventService, HomeComponent, ConnectionBanner, HomeShell) is
 * unchanged regardless of whether events arrive from:
 *  - a Web Worker SSE loop (browser + all Tauri desktop: pc/mac/linux) — {@link WorkerSseTransport}; or
 *  - the Android native /events bridge (Kotlin's RealtimeService → `window.__SOMS_EVENT__`) —
 *    {@link NativeEventTransport}.
 *
 * The two implementations are structurally asymmetric (the worker *owns* its connection + token handshake
 * + backoff; the native transport owns *nothing* of the connection — Kotlin does), which is exactly why a
 * Strategy seam beats an `if (isAndroid())` branch in the facade (one class would carry both lifecycles,
 * half of it dead on every platform). The token *type* (access JWT now, session token in Phase 3) stays
 * orthogonal to the transport, so Phase 3's migration does not touch this seam.
 */

/** A single inbound SSE business event, in the shape every downstream consumer already reads from
 *  {@link WebsocketService.eventSubject}. `event` is the server-named SSE event type dispatched on;
 *  `data` is its parsed JSON payload. */
export interface StandardMessage<T = any> {
  event: string;
  status: number;
  message: string;
  data?: T;
}

/** Connection state — the single source of truth the UI reads (via the ConnectionBanner) to surface
 *  connection problems. Mirrors the worker's `WorkerState`. */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The outputs every transport produces, funneled into the facade's single set of subjects/signal. The
 *  transport is a pure producer; the facade owns the public `eventSubject`/`state`/`reconnect$` and the
 *  FORCE_LOGOUT side-effect (re-login). */
export interface RealtimeSink {
  onEvent(message: StandardMessage): void;
  onState(state: ConnectionState): void;
  onReconnect(): void;
  /** Server-initiated kick. `reason` is the FORCE_LOGOUT frame's message (the revoke reason, e.g.
   *  'device_revoke'), threaded so the facade can surface a reason-aware login notice; undefined on
   *  transports that don't carry it (the worker path). */
  onForceLogout(reason?: string): void;
}

/** Abstract realtime transport — the swappable platform adapter. Subclasses push inbound events + state
 *  through the {@link RealtimeSink}; the facade drives `start`/`stop`/`retryNow`. */
export abstract class RealtimeTransport {
  constructor(protected readonly sink: RealtimeSink) {}

  /** Begin receiving (idempotent — no-op if already started). */
  abstract start(): void;

  /** Stop receiving (idempotent — no-op if already stopped). */
  abstract stop(): void;

  /** User-initiated retry (the disconnected chip was clicked). Default no-op — correct for transports
   *  whose platform owns its own reconnect backoff (e.g. the native transport). */
  retryNow(): void {}
}
