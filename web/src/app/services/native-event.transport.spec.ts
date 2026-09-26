import { NativeEventTransport } from './native-event.transport';
import type {
  ConnectionState,
  RealtimeSink,
  StandardMessage,
} from './realtime-transport';
import { SSE_EVENT_FORCE_LOGOUT } from './sse-worker-protocol';

/**
 * NativeEventTransport unit tests — the Android event-routing seam.
 *
 * This transport is the ONLY web-side code that turns Kotlin's forwarded /events frames into the
 * StandardMessage shape every downstream consumer reads, and it owns the FORCE_LOGOUT interception + the
 * `SomsFcm.getConnState()` seeding that keeps the connection banner correct on a freshly-booted WebView
 * (Kotlin only pushes state on transitions). It is pure logic with no HttpClient / Web Worker / SSE
 * dependency — drive `window.__SOMS_EVENT__` / `window.__SOMS_CONN_STATE__` and assert what the sink
 * received. No Angular surface (mirrors runtime.spec.ts). The Kotlin half (the service that feeds these
 * hooks) has no instrumented harness — it is verified via the manual `make apk-dev` flow.
 */

/** A recording sink: captures every call so each test asserts exactly what the transport emitted. */
function recordingSink() {
  const events: StandardMessage[] = [];
  const states: ConnectionState[] = [];
  let reconnects = 0;
  const forceLogouts: (string | undefined)[] = [];
  const reconnectIns: (number | null)[] = [];
  const sink: RealtimeSink = {
    onEvent: (m) => events.push(m),
    onState: (s) => states.push(s),
    onReconnect: () => reconnects++,
    onForceLogout: (reason) => forceLogouts.push(reason),
    onReconnectIn: (ms) => reconnectIns.push(ms),
  };
  return {
    sink,
    events,
    states,
    reconnects: () => reconnects,
    forceLogouts: () => forceLogouts,
    reconnectIns: () => reconnectIns,
  };
}

/** Install a minimal `window.SomsFcm` exposing what the transport reads on start plus the retry channel.
 *  `replayHello` is called whenever Kotlin reports an already-open retained stream: the fresh WebView
 *  missed that stream's one-shot HELLO and asks native to replay its cached copy. */
function installFakeFcm(connState: string): {
  retryNows: () => number;
  helloReplays: () => number;
} {
  let retryNows = 0;
  let helloReplays = 0;
  (
    window as unknown as {
      SomsFcm: {
        getConnState: () => string;
        retryNow: () => void;
        replayHello: () => void;
      };
    }
  ).SomsFcm = {
    getConnState: () => connState,
    retryNow: () => {
      retryNows++;
    },
    replayHello: () => {
      helloReplays++;
    },
  };
  return { retryNows: () => retryNows, helloReplays: () => helloReplays };
}

/** Invoke the currently-installed (or not) Kotlin push hook the way RealtimeService.forwardToJs does. */
function fireEvent(type: string, data: unknown): void {
  window.__SOMS_EVENT__?.(type, data);
}

/** Invoke the conn-state push hook the way RealtimeService.pushConnState does. */
function fireConnState(state: string): void {
  window.__SOMS_CONN_STATE__?.(state as ConnectionState);
}

/** Invoke the reconnect-in push hook the way RealtimeService.scheduleReopen does. */
function fireReconnectIn(ms: number): void {
  window.__SOMS_RECONNECT_IN__?.(ms);
}

describe('NativeEventTransport', () => {
  // The transport installs global hooks; restore both globals after each test so a leftover hook from one
  // case never bleeds into the next, and a test's fake SomsFcm never leaks to specs that expect it absent.
  afterEach(() => {
    window.__SOMS_EVENT__ = undefined;
    window.__SOMS_CONN_STATE__ = undefined;
    window.__SOMS_RECONNECT_IN__ = undefined;
    (
      window as unknown as {
        SomsFcm?: unknown;
      }
    ).SomsFcm = undefined;
  });

  it('seeds the connection banner from SomsFcm.getConnState() on start (Kotlin only pushes on transitions)', () => {
    const fcm = installFakeFcm('open');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink).start();
    expect(rec.states).toEqual(['open']);
    expect(fcm.helloReplays()).toBe(1);
  });

  it('seeds "closed" too (a truthy state) — a fresh process with no connection still pins the banner', () => {
    installFakeFcm('closed');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink).start();
    expect(rec.states).toEqual(['closed']);
  });

  it('forwards a STATE_FEED_UPDATED frame verbatim into a StandardMessage', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink).start();
    fireEvent('STATE_FEED_UPDATED', { feedId: 5 });
    expect(rec.events).toEqual([
      {
        event: 'STATE_FEED_UPDATED',
        status: 0,
        message: 'new message',
        data: { feedId: 5 },
      },
    ]);
  });

  it('intercepts FORCE_LOGOUT (the facade re-logs in) and does NOT re-emit it as a data event', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink).start();
    fireEvent(SSE_EVENT_FORCE_LOGOUT, {});
    expect(rec.forceLogouts().length).toBe(1);
    expect(rec.events.length).toBe(0);
  });

  it('threads the FORCE_LOGOUT reason (e.g. device_revoke) to the sink for a tailored notice', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink).start();
    fireEvent(SSE_EVENT_FORCE_LOGOUT, { message: 'device_revoke' });
    expect(rec.forceLogouts()).toEqual(['device_revoke']);
  });

  it('mirrors __SOMS_CONN_STATE__ transitions onto the sink so the banner tracks the native socket', () => {
    installFakeFcm('connecting');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink).start();
    fireConnState('open');
    fireConnState('reconnecting');
    expect(rec.states).toEqual(['connecting', 'open', 'reconnecting']);
  });

  it('forwards __SOMS_RECONNECT_IN__ (scheduleReopen backoff) so the chip can render a countdown', () => {
    installFakeFcm('reconnecting');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink).start();
    fireReconnectIn(4000);
    fireReconnectIn(2000);
    expect(rec.reconnectIns()).toEqual([4000, 2000]);
  });

  it('retryNow() clears the countdown and invokes SomsFcm.retryNow() (cancel Kotlin backoff + reconnect)', () => {
    const fcm = installFakeFcm('reconnecting');
    const rec = recordingSink();
    const t = new NativeEventTransport(rec.sink);
    t.start();
    t.retryNow();
    // The manual retry voids the scheduled backoff → countdown cleared (parity with the worker/Rust).
    expect(rec.reconnectIns()).toContain(null);
    // ...and the JS→native retry channel fires (the real one posts the ACTION_RETRY Intent).
    expect(fcm.retryNows()).toBe(1);
  });

  it('does NOT emit a reconnect pulse on the FIRST open (downstream boots its own catch-up)', () => {
    installFakeFcm('connecting');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink).start();
    fireConnState('open'); // first open
    expect(rec.reconnects()).toBe(0);
  });

  it('emits a reconnect pulse on every open AFTER the first (native reconnect → downstream backfill)', () => {
    installFakeFcm('closed');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink).start();
    fireConnState('open'); // first open — no pulse
    fireConnState('reconnecting'); // stream dropped (Android backgrounded / transient failure)
    fireConnState('open'); // reconnect pulse drives the ClientStateFeed drain
    fireConnState('reconnecting');
    fireConnState('open'); // another reconnect — pulse again
    expect(rec.reconnects()).toBe(2);
  });

  it('start() is idempotent — a second start does not re-seed or re-install (no banner flicker)', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    const t = new NativeEventTransport(rec.sink);
    t.start();
    t.start();
    expect(rec.states).toEqual(['open']); // exactly one seed
  });

  it('stop() detaches the hooks (further Kotlin pushes become no-ops via the && guard) and emits closed', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    const t = new NativeEventTransport(rec.sink);
    t.start();
    t.stop();
    // The transport reports its own stream as closed; Kotlin's service is unaffected (independent lifecycle).
    expect(rec.states[rec.states.length - 1]).toBe('closed');
    // Hooks detached → a forwarded frame no longer reaches the sink.
    fireEvent('STATE_FEED_UPDATED', { feedId: 9 });
    expect(rec.events.length).toBe(0);
    expect(window.__SOMS_EVENT__).toBeUndefined();
    expect(window.__SOMS_CONN_STATE__).toBeUndefined();
    expect(window.__SOMS_RECONNECT_IN__).toBeUndefined();
  });

  it('stop() is idempotent — calling it twice emits closed exactly once', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    const t = new NativeEventTransport(rec.sink);
    t.start();
    t.stop();
    t.stop();
    expect(rec.states.filter((s) => s === 'closed')).toEqual(['closed']);
  });
});
