import { Injectable, signal, effect, untracked } from '@angular/core';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { apiOrigin, isAndroidNative } from './runtime';
import {
  RealtimeTransport,
  type ConnectionState,
  type RealtimeSink,
  type StandardMessage,
} from './realtime-transport';
import { WorkerSseTransport } from './worker-sse.transport';
import { NativeEventTransport } from './native-event.transport';

// Re-exported for downstream consumers (HttpItemSource, GroupEventService, ConnectionBanner, …) that
// already import these from here — the canonical home is now realtime-transport.ts.
export type { StandardMessage, ConnectionState } from './realtime-transport';

/** Dev-build-only diagnostic gate (mirrors Angular's own per-file declaration): truthy under
 *  `ng serve`, dead-code-eliminated in prod AOT — see the [sse] recv trace below. */
declare const ngDevMode: boolean | null | undefined;

/**
 * Realtime downlink facade — the single public surface every consumer already depends on
 * (`eventSubject`, `reconnect$`, `state`, `connect()`, `disconnect()`, `retryNow()`). The actual
 * transport is a pluggable {@link RealtimeTransport} selected once at construction by platform:
 *  - Android (Tauri shell): {@link NativeEventTransport} — consumes Kotlin's `/events` bridge
 *    (`window.__SOMS_EVENT__`); the native RealtimeService owns the connection.
 *  - browser + all Tauri desktop (pc/mac/linux): {@link WorkerSseTransport} — spawns `sse.worker.ts`.
 *
 * The facade owns the public subjects/signal and the FORCE_LOGOUT side-effect (re-login); the transport
 * is a pure producer that pushes into them via a {@link RealtimeSink}. Because both transports speak the
 * same sink contract, downstream consumers are byte-identical across platforms — this class carries no
 * platform branching, only the one-time selection.
 */
@Injectable({
  providedIn: 'root',
})
export class WebsocketService {
  readonly eventSubject = new Subject<StandardMessage>();
  /** Reconnect-success pulse: http-item-source subscribes and backfills messages missed during the
   *  disconnect via the newestMsgId cursor. */
  readonly reconnect$ = new Subject<void>();
  /** Connection state for the shell's connection-lost banner. See {@link ConnectionState}. */
  readonly state = signal<ConnectionState>('closed')

  private readonly transport: RealtimeTransport;

  constructor(private authService: AuthService) {
    // The sink funnels every transport's outputs onto this facade's single subjects/signal (+ the dev
    // trace + the FORCE_LOGOUT re-login side-effect).
    const sink: RealtimeSink = {
      onEvent: (m) => {
        // Dev-only: trace every realtime business event, so signal reception is visible under `ng serve`.
        // Gated by ngDevMode → stripped in prod AOT.
        if (ngDevMode) console.log('[sse] recv', m.event, m.data);
        this.eventSubject.next(m);
      },
      onState: (s) => this.state.set(s),
      onReconnect: () => this.reconnect$.next(),
      onForceLogout: () => this.onForceLogout(),
    };
    // Select the transport ONCE, by platform. Android consumes the native /events bridge; every other
    // client runs its own SSE worker. No branching anywhere else in this class.
    this.transport = isAndroidNative()
      ? new NativeEventTransport(sink)
      : new WorkerSseTransport(sink, authService);
    this.connect()
    // A backend-origin swap (server-config save) repoints every URL live via the apiOrigin signal. The
    // transport captured the OLD sseUrl at its `start`, so reconnect it against the new host: the first
    // run is skipped (this.connect() above already used the boot origin), then every change tears the
    // transport down and restarts it reading the now-current sseUrl(). (On Android this is a harmless
    // hook re-register — Kotlin picks up the new origin on its next reconnect.) untracked so the
    // connect()/disconnect() calls don't themselves get wired into the reactive graph.
    let booted = false
    effect(() => {
      apiOrigin()
      if (!booted) { booted = true; return }
      untracked(() => { this.disconnect(); this.connect() })
    })
  }

  /** Begin receiving (idempotent). On mobile this is called on every visible transition. */
  public connect() {
    this.transport.start()
  }

  /** Logout / force-login / origin swap: stop the transport and let it clear its state. */
  public disconnect() {
    this.transport.stop()
  }

  /** User-initiated retry (the disconnected chip clicked while `reconnecting`). No-op on platforms whose
   *  transport owns its own backoff (Android). */
  public retryNow(): void {
    this.transport.retryNow()
  }

  /** Server-initiated kick (all-device logout / password change): drop the transport + re-run login. */
  private onForceLogout(): void {
    this.disconnect()
    this.authService.redoLoginAuth()
  }
}
