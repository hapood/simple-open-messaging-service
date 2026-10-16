import { RustChannelSseTransport } from './rust-channel-sse.transport';
import type {
  ConnectionState,
  RealtimeSink,
  StandardMessage,
} from './realtime-transport';

function recordingSink() {
  const events: StandardMessage[] = [];
  const states: ConnectionState[] = [];
  const reconnectIns: (number | null)[] = [];
  const forceLogouts: (string | undefined)[] = [];
  let reconnects = 0;
  const sink: RealtimeSink = {
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    onReconnect: () => reconnects++,
    onForceLogout: (reason) => forceLogouts.push(reason),
    onReconnectIn: (ms) => reconnectIns.push(ms),
  };
  return {
    sink,
    events,
    states,
    reconnectIns,
    forceLogouts,
    reconnects: () => reconnects,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Exercise the real runtime port, not a relative-import mock (unsupported by Angular's runner). */
function installFakeTauri(
  state: ConnectionState = 'closed',
  start?: (sequence: number) => number | Promise<number>,
  registration?: Promise<void>,
) {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const invokes: { cmd: string; args?: Record<string, unknown> }[] = [];
  const released: string[] = [];
  let sequence = 0;
  const root = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  root.__TAURI_INTERNALS__ = {};
  root.__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        invokes.push({ cmd, args });
        if (cmd === 'sse_start') {
          ++sequence;
          return start ? start(sequence) : sequence;
        }
        if (cmd === 'sse_get_state') return state;
        if (cmd === 'sse_retry') return args?.['instance'];
        return undefined;
      },
    },
    event: {
      listen: async (
        name: string,
        callback: (event: { payload: unknown }) => void,
      ) => {
        listeners.set(name, callback);
        if (registration) await registration;
        return () => {
          released.push(name);
          if (listeners.get(name) === callback) listeners.delete(name);
        };
      },
      emit: async () => {},
    },
  };
  return {
    invokes,
    released,
    emit: (name: string, payload: unknown) =>
      listeners.get(name)?.({ payload }),
    handler: (name: string) => listeners.get(name)!,
  };
}

const started = (platform: ReturnType<typeof installFakeTauri>) =>
  vi.waitFor(() =>
    expect(platform.invokes.some((call) => call.cmd === 'sse_get_state')).toBe(
      true,
    ),
  );

describe('RustChannelSseTransport', () => {
  let active: RustChannelSseTransport[] = [];
  const make = (sink: RealtimeSink) => {
    const transport = new RustChannelSseTransport(sink);
    active.push(transport);
    return transport;
  };
  afterEach(() => {
    for (const transport of active) transport.stop();
    active = [];
    const root = window as unknown as {
      __TAURI__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    };
    delete root.__TAURI__;
    delete root.__TAURI_INTERNALS__;
  });

  it('starts the supervisor and seeds the banner from the owned state', async () => {
    const platform = installFakeTauri('reconnecting');
    const output = recordingSink();
    make(output.sink).start();
    await vi.waitFor(() => expect(output.states).toContain('reconnecting'));
    expect(platform.invokes).toContainEqual({
      cmd: 'sse_get_state',
      args: { instance: 1 },
    });
  });
  it('forwards a business frame verbatim', async () => {
    const platform = installFakeTauri();
    const output = recordingSink();
    make(output.sink).start();
    await started(platform);
    const message = {
      event: 'STATE_FEED_UPDATED',
      status: 0,
      message: 'new message',
      data: { id: 5 },
    };
    platform.emit('soms-sse-event', message);
    expect(output.events).toEqual([message]);
  });
  it('forwards connection-state transitions', async () => {
    const platform = installFakeTauri();
    const output = recordingSink();
    make(output.sink).start();
    await started(platform);
    platform.emit('soms-sse-state', 'connecting');
    platform.emit('soms-sse-state', 'open');
    expect(output.states).toContain('connecting');
    expect(output.states).toContain('open');
  });
  it('forwards reconnect pulses without inferring openedOnce', async () => {
    const platform = installFakeTauri();
    const output = recordingSink();
    make(output.sink).start();
    await started(platform);
    platform.emit('soms-sse-reconnect', null);
    expect(output.reconnects()).toBe(1);
  });
  it('forwards scheduled reconnect deadlines', async () => {
    const platform = installFakeTauri();
    const output = recordingSink();
    make(output.sink).start();
    await started(platform);
    platform.emit('soms-sse-reconnect-in', 8000);
    expect(output.reconnectIns).toEqual([8000]);
  });
  it('preserves the forced-logout reason', async () => {
    const platform = installFakeTauri();
    const output = recordingSink();
    make(output.sink).start();
    await started(platform);
    platform.emit('soms-sse-force-logout', { reason: 'device_revoke' });
    expect(output.forceLogouts).toEqual(['device_revoke']);
  });
  it('preserves an absent forced-logout reason', async () => {
    const platform = installFakeTauri();
    const output = recordingSink();
    make(output.sink).start();
    await started(platform);
    platform.emit('soms-sse-force-logout', {});
    expect(output.forceLogouts).toEqual([undefined]);
  });
  it('forwards navigator facts using the owned lease', async () => {
    const platform = installFakeTauri();
    make(recordingSink().sink).start();
    await started(platform);
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    const facts = platform.invokes
      .filter((call) => call.cmd === 'sse_net')
      .slice(-2);
    expect(facts.map((call) => call.args)).toEqual([
      { instance: 1, online: false },
      { instance: 1, online: true },
    ]);
  });
  it('delegates retry while reconnecting to Rust', async () => {
    const platform = installFakeTauri('reconnecting');
    const transport = make(recordingSink().sink);
    transport.start();
    await started(platform);
    transport.retryNow();
    expect(platform.invokes).toContainEqual({
      cmd: 'sse_retry',
      args: { instance: 1, force: false },
    });
  });
  it('delegates terminal-worker restart rather than deciding it in the renderer', async () => {
    const platform = installFakeTauri('closed');
    const transport = make(recordingSink().sink);
    transport.start();
    await started(platform);
    transport.retryNow();
    expect(platform.invokes).toContainEqual({
      cmd: 'sse_retry',
      args: { instance: 1, force: false },
    });
    expect(
      platform.invokes.filter((call) => call.cmd === 'sse_start'),
    ).toHaveLength(1);
    expect(platform.invokes.some((call) => call.cmd === 'sse_stop')).toBe(
      false,
    );
  });
  it('clears the countdown synchronously on manual retry', async () => {
    const platform = installFakeTauri();
    const output = recordingSink();
    const transport = make(output.sink);
    transport.start();
    await started(platform);
    transport.retryNow();
    expect(output.reconnectIns).toContain(null);
  });
  it('stop releases its lease and detaches every listener', async () => {
    const platform = installFakeTauri('open');
    const output = recordingSink();
    const transport = make(output.sink);
    transport.start();
    await started(platform);
    transport.stop();
    expect(platform.invokes).toContainEqual({
      cmd: 'sse_stop',
      args: { instance: 1 },
    });
    expect(output.states.at(-1)).toBe('closed');
    platform.emit('soms-sse-event', { event: 'HELLO', status: 0, message: '' });
    expect(output.events).toEqual([]);
    expect(platform.released).toHaveLength(5);
  });
  it('start is idempotent while attached', async () => {
    const platform = installFakeTauri();
    const transport = make(recordingSink().sink);
    transport.start();
    await started(platform);
    transport.start();
    expect(
      platform.invokes.filter((call) => call.cmd === 'sse_start'),
    ).toHaveLength(1);
  });
  it('delegates force reconnect separately from retry', async () => {
    const platform = installFakeTauri();
    const transport = make(recordingSink().sink);
    transport.start();
    await started(platform);
    transport.forceReconnect();
    expect(platform.invokes).toContainEqual({
      cmd: 'sse_retry',
      args: { instance: 1, force: true },
    });
  });
  it('late start completion stops only its obsolete lease', async () => {
    const first = deferred<number>();
    const platform = installFakeTauri('open', (sequence) =>
      sequence === 1 ? first.promise : sequence,
    );
    const transport = make(recordingSink().sink);
    transport.start();
    await vi.waitFor(() =>
      expect(platform.invokes.some((call) => call.cmd === 'sse_start')).toBe(
        true,
      ),
    );
    transport.stop();
    transport.start();
    await vi.waitFor(() =>
      expect(platform.invokes).toContainEqual({
        cmd: 'sse_replay_hello',
        args: { instance: 2 },
      }),
    );
    first.resolve(1);
    await vi.waitFor(() =>
      expect(platform.invokes).toContainEqual({
        cmd: 'sse_stop',
        args: { instance: 1 },
      }),
    );
    expect(platform.invokes).not.toContainEqual({
      cmd: 'sse_stop',
      args: { instance: 2 },
    });
  });
  it('queued callbacks from an old attach cannot publish into a new attach', async () => {
    const platform = installFakeTauri();
    const output = recordingSink();
    const transport = make(output.sink);
    transport.start();
    await started(platform);
    const stale = platform.handler('soms-sse-event');
    transport.stop();
    transport.start();
    await vi.waitFor(() =>
      expect(
        platform.invokes.filter((call) => call.cmd === 'sse_start'),
      ).toHaveLength(2),
    );
    stale({ payload: { event: 'HELLO', status: 0, message: '' } });
    expect(output.events).toEqual([]);
    platform.emit('soms-sse-event', { event: 'HELLO', status: 0, message: '' });
    expect(output.events).toHaveLength(1);
  });
  it('late registrations are disposed without starting a native worker', async () => {
    const registration = deferred<void>();
    const platform = installFakeTauri(
      'closed',
      undefined,
      registration.promise,
    );
    const transport = make(recordingSink().sink);
    transport.start();
    transport.stop();
    registration.resolve();
    await vi.waitFor(() => expect(platform.released).toHaveLength(5));
    expect(platform.invokes.some((call) => call.cmd === 'sse_start')).toBe(
      false,
    );
  });
});
