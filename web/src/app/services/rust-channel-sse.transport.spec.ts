import { RustChannelSseTransport } from './rust-channel-sse.transport';
import type {
  ConnectionState,
  RealtimeSink,
  StandardMessage,
} from './realtime-transport';

/**
 * RustChannelSseTransport unit tests — the Tauri DESKTOP event-routing seam.
 *
 * This transport is the web-side adapter for the Rust SSE supervisor (src-tauri/src/lib.rs `sse_*`
 * commands): it subscribes to the `soms-sse-*` Tauri events and re-emits them onto the sink, drives
 * `sse_start`/`sse_stop`/`sse_get_state`/`sse_net`, and forwards navigator online/offline. It is pure
 * logic over `window.__TAURI__` (no HttpClient / worker / SSE) — drive the captured event listeners +
 * invoke recorder and assert what the sink received. No Angular surface (mirrors
 * native-event.transport.spec.ts). The Rust half (the supervisor) has no instrumented harness here — it
 * is verified via the manual desktop build.
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

interface FakeTauri {
  /** Dispatch a Rust→JS event the way the supervisor's `app.emit` would. */
  emit: (event: string, payload: unknown) => void;
  /** Every command the transport invoked, in order. */
  invokes: () => {
    cmd: string;
    args?: unknown;
  }[];
}

/** Install a minimal `window.__TAURI__` capturing `event.listen` handlers + recording `core.invoke`. */
function installFakeTauri(initialState: ConnectionState = 'closed'): FakeTauri {
  const listeners: Record<
    string,
    ((e: { payload: unknown }) => void) | undefined
  > = {};
  const invokes: {
    cmd: string;
    args?: unknown;
  }[] = [];
  let nextState = initialState;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: {
      core?: {
        invoke: (cmd: string, args?: unknown) => Promise<unknown>;
      };
      event?: {
        listen: (
          event: string,
          h: (e: { payload: unknown }) => void,
        ) => Promise<() => void>;
        emit: (event: string, payload?: unknown) => Promise<void> | void;
      };
    };
  };
  w.__TAURI_INTERNALS__ = {}; // isTauri() truthy
  w.__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: unknown) => {
        invokes.push({ cmd, args });
        if (cmd === 'sse_get_state') return nextState;
        return undefined;
      },
    },
    event: {
      listen: async (event: string, h: (e: { payload: unknown }) => void) => {
        listeners[event] = h;
        return () => {
          if (listeners[event] === h) delete listeners[event];
        };
      },
      emit: async () => {},
    },
  };
  return {
    emit: (event, payload) => listeners[event]?.({ payload }),
    invokes: () => invokes,
  };
}

/** Wait until the transport's async start-up has fully wired itself. `startAsync` registers the event
 *  listeners first and invokes `sse_start` strictly after, so a recorded `sse_start` proves the
 *  transport is ready to receive emitted events. */
const started = (tauri: ReturnType<typeof installFakeTauri>): Promise<void> =>
  vi.waitFor(() =>
    expect(tauri.invokes().some((i) => i.cmd === 'sse_start')).toBe(true),
  );

describe('RustChannelSseTransport', () => {
  // Each test's transport is stopped in afterEach so its window online/offline listeners (and the
  // Tauri-event subscriptions) don't leak into the next test — `tauriInvoke` reads the LIVE
  // `window.__TAURI__`, so a leaked handler from test N would fire against test N+1's fake.
  let active: RustChannelSseTransport[] = [];
  const make = (sink: RealtimeSink): RustChannelSseTransport => {
    const t = new RustChannelSseTransport(sink);
    active.push(t);
    return t;
  };

  afterEach(() => {
    for (const t of active) t.stop();
    active = [];
    const w = window as unknown as {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
    };
    delete w.__TAURI_INTERNALS__;
    delete w.__TAURI__;
  });

  it('starts the supervisor and seeds the banner from sse_get_state', async () => {
    const t = installFakeTauri('reconnecting');
    const rec = recordingSink();
    make(rec.sink).start();
    // The seed lands right after sse_start (sse_get_state follows it in startAsync) — waiting on the
    // seeded banner state also proves sse_start was invoked.
    await vi.waitFor(() => expect(rec.states).toContain('reconnecting'));
    expect(t.invokes().some((i) => i.cmd === 'sse_start')).toBe(true);
  });

  it('forwards a soms-sse-event frame verbatim into a StandardMessage', async () => {
    const t = installFakeTauri();
    const rec = recordingSink();
    make(rec.sink).start();
    await started(t);
    t.emit('soms-sse-event', {
      event: 'STATE_FEED_UPDATED',
      status: 0,
      message: 'new message',
      data: { id: 5 },
    });
    expect(rec.events).toEqual([
      {
        event: 'STATE_FEED_UPDATED',
        status: 0,
        message: 'new message',
        data: { id: 5 },
      },
    ]);
  });

  it('forwards soms-sse-state transitions onto the sink (banner tracks the Rust socket)', async () => {
    const t = installFakeTauri('closed');
    const rec = recordingSink();
    make(rec.sink).start();
    await started(t);
    t.emit('soms-sse-state', 'connecting');
    t.emit('soms-sse-state', 'open');
    expect(rec.states).toContain('connecting');
    expect(rec.states).toContain('open');
  });

  it('forwards the soms-sse-reconnect pulse (Rust owns the openedOnce logic, not this class)', async () => {
    const t = installFakeTauri();
    const rec = recordingSink();
    make(rec.sink).start();
    await started(t);
    t.emit('soms-sse-reconnect', null);
    expect(rec.reconnects()).toBe(1);
  });

  it('forwards soms-sse-reconnect-in (the supervisor backoff deadline) for the countdown chip', async () => {
    const t = installFakeTauri();
    const rec = recordingSink();
    make(rec.sink).start();
    await started(t);
    t.emit('soms-sse-reconnect-in', 8000);
    expect(rec.reconnectIns()).toEqual([8000]);
  });

  it('threads the FORCE_LOGOUT reason from the Rust payload for a tailored notice', async () => {
    const t = installFakeTauri();
    const rec = recordingSink();
    make(rec.sink).start();
    await started(t);
    t.emit('soms-sse-force-logout', { reason: 'device_revoke' });
    expect(rec.forceLogouts()).toEqual(['device_revoke']);
  });

  it('force-logout with no reason resolves to undefined', async () => {
    const t = installFakeTauri();
    const rec = recordingSink();
    make(rec.sink).start();
    await started(t);
    t.emit('soms-sse-force-logout', {});
    expect(rec.forceLogouts()).toEqual([undefined]);
  });

  it('navigator offline → sse_net(online:false); online → sse_net(online:true)', async () => {
    const t = installFakeTauri();
    const rec = recordingSink();
    make(rec.sink).start();
    await started(t);
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      const nets = t
        .invokes()
        .filter((i) => i.cmd === 'sse_net')
        .map(
          (i) =>
            (
              i.args as
                | {
                    online?: boolean;
                  }
                | undefined
            )?.online,
        );
      expect(nets).toEqual([false, true]);
    });
  });

  it('retryNow() invokes sse_net(online:true) so the supervisor resets backoff + retries at once', async () => {
    const t = installFakeTauri();
    const rec = recordingSink();
    const transport = make(rec.sink);
    transport.start();
    await started(t);
    transport.retryNow();
    await vi.waitFor(() =>
      expect(
        t.invokes().some(
          (i) =>
            i.cmd === 'sse_net' &&
            (
              i.args as {
                online?: boolean;
              }
            )?.online === true,
        ),
      ).toBe(true),
    );
  });

  it('retryNow() drops the scheduled countdown (the manual retry voids the backoff deadline)', async () => {
    const t = installFakeTauri();
    const rec = recordingSink();
    const transport = make(rec.sink);
    transport.start();
    await started(t);
    transport.retryNow();
    // retryNow() drops the countdown synchronously via the sink.
    expect(rec.reconnectIns()).toContain(null);
  });

  it('stop() invokes sse_stop, detaches the listeners (further emits are no-ops), and emits closed', async () => {
    const t = installFakeTauri('open');
    const rec = recordingSink();
    const transport = make(rec.sink);
    transport.start();
    await started(t);
    transport.stop();
    // Remove from `active` so afterEach doesn't double-stop (stop is idempotent anyway).
    active = active.filter((x) => x !== transport);
    // stop() detaches listeners + emits closed synchronously; only the fire-and-forget sse_stop
    // invoke records a microtask later — wait on that record.
    await vi.waitFor(() =>
      expect(t.invokes().some((i) => i.cmd === 'sse_stop')).toBe(true),
    );
    expect(rec.states[rec.states.length - 1]).toBe('closed');
    // Listeners detached → a Rust emit no longer reaches the sink.
    t.emit('soms-sse-event', {
      event: 'STATE_FEED_UPDATED',
      status: 0,
      message: 'new message',
      data: { id: 9 },
    });
    expect(rec.events.length).toBe(0);
  });

  it('start() is idempotent — a second start does not re-subscribe or re-spawn', async () => {
    const t = installFakeTauri();
    const rec = recordingSink();
    const transport = make(rec.sink);
    transport.start();
    await started(t);
    const firstStarts = t.invokes().filter((i) => i.cmd === 'sse_start').length;
    transport.start();
    // Negative (absence) assertion: the sync idempotence guard already returned before startAsync
    // could run; a single macrotask turn fully drains the microtask chains (the fakes schedule no
    // timers), so a would-be second sse_start would be visible here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondStarts = t
      .invokes()
      .filter((i) => i.cmd === 'sse_start').length;
    expect(secondStarts).toBe(firstStarts);
  });
});
