import { NativeEventTransport } from './native-event.transport';
import type {
  ConnectionState,
  RealtimeSink,
  StandardMessage,
} from './realtime-transport';
import { SSE_EVENT_FORCE_LOGOUT } from './sse-worker-protocol';

const LOGIN = 'd91f007f-10c4-410f-a837-65ba4edff6b5';
const NEXT_LOGIN = '1c19d615-4296-495a-94d7-f2cf9670991e';

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
    forceLogouts,
    reconnectIns,
  };
}

function envelope(
  event: string,
  data?: unknown,
  loginSessionId = LOGIN,
): StandardMessage {
  return { event, status: 0, message: 'native event', data, loginSessionId };
}

function installFakeFcm(connState: string, replay?: () => void) {
  let retryNows = 0;
  let helloReplays = 0;
  let forceReconnects = 0;
  vi.stubGlobal('SomsFcm', {
    getConnState: () => connState,
    retryNow: () => retryNows++,
    forceReconnect: () => forceReconnects++,
    replayHello: () => {
      helloReplays++;
      replay?.();
    },
  });
  return {
    retryNows: () => retryNows,
    helloReplays: () => helloReplays,
    forceReconnects: () => forceReconnects,
  };
}

function fireEvent(message: StandardMessage): void {
  window.__SOMS_EVENT__?.(message);
}

function fireConnState(state: ConnectionState): void {
  window.__SOMS_CONN_STATE__?.(state);
}

function fireReconnectIn(ms: number): void {
  window.__SOMS_RECONNECT_IN__?.(ms);
}

/** Simulate the actual WebView delivery boundary, including native events queued before a new login. */
describe('NativeEventTransport', () => {
  afterEach(() => {
    window.__SOMS_EVENT__ = undefined;
    window.__SOMS_CONN_STATE__ = undefined;
    window.__SOMS_RECONNECT_IN__ = undefined;
    vi.unstubAllGlobals();
  });

  it('seeds an already-open connection and asks Rust to replay HELLO', () => {
    const fcm = installFakeFcm('open');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, LOGIN).start();
    expect(rec.states).toEqual(['open']);
    expect(fcm.helloReplays()).toBe(1);
  });

  it('seeds closed too, without replaying HELLO', () => {
    const fcm = installFakeFcm('closed');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, LOGIN).start();
    expect(rec.states).toEqual(['closed']);
    expect(fcm.helloReplays()).toBe(0);
  });

  it.each([
    'STATE_FEED_UPDATED',
    'LOCAL_THREAD_FEED_COMMITTED',
    'LOCAL_GROUP_META_COMMITTED',
    'LOCAL_TOMBSTONE_COMMITTED',
  ])(
    'preserves the complete %s envelope rather than reconstructing it',
    (event) => {
      installFakeFcm('open');
      const rec = recordingSink();
      new NativeEventTransport(rec.sink, LOGIN).start();
      const message = {
        ...envelope(event, { userId: 42, feedId: 5 }),
        status: 7,
        message: 'original message',
      };
      fireEvent(message);
      expect(rec.events).toEqual([message]);
      expect(rec.events[0]).toBe(message);
    },
  );

  it('preserves the login UUID on synchronously replayed HELLO', () => {
    const hello = envelope('HELLO', { userId: 42, sessionId: 1 });
    installFakeFcm('open', () => fireEvent(hello));
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, LOGIN).start();
    expect(rec.events).toEqual([hello]);
  });

  it('rejects events without an owner instead of adopting the renderer login', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, LOGIN).start();
    const missing = envelope('LOCAL_THREAD_FEED_COMMITTED', { userId: 42 });
    delete missing.loginSessionId;
    fireEvent(missing);
    expect(missing.loginSessionId).toBeUndefined();
    expect(rec.events).toEqual([]);
  });

  it.each(['HELLO', 'STATE_FEED_UPDATED', 'LOCAL_THREAD_FEED_COMMITTED'])(
    'rejects an old %s delivered after a same-account fresh login',
    (event) => {
      installFakeFcm('closed');
      const old = recordingSink();
      const original = new NativeEventTransport(old.sink, LOGIN);
      original.start();
      const queued = envelope(event, { userId: 42 });
      original.stop();
      const successor = recordingSink();
      new NativeEventTransport(successor.sink, NEXT_LOGIN).start();
      fireEvent(queued);
      fireEvent(envelope(event, { userId: 42 }, NEXT_LOGIN));
      expect(old.events).toEqual([]);
      expect(successor.events).toHaveLength(1);
      expect(successor.events[0].loginSessionId).toBe(NEXT_LOGIN);
    },
  );

  it('rejects events while signed out', () => {
    installFakeFcm('closed');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, null).start();
    fireEvent(envelope('HELLO', { userId: 42 }));
    expect(rec.events).toEqual([]);
  });

  it('intercepts the original FORCE_LOGOUT reason without emitting a data event', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, LOGIN).start();
    fireEvent({
      ...envelope(SSE_EVENT_FORCE_LOGOUT, null),
      message: 'device_revoke',
    });
    expect(rec.forceLogouts).toEqual(['device_revoke']);
    expect(rec.events).toEqual([]);
  });

  it('uses an unspecified reason for an empty FORCE_LOGOUT message', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, LOGIN).start();
    fireEvent({ ...envelope(SSE_EVENT_FORCE_LOGOUT, null), message: '' });
    expect(rec.forceLogouts).toEqual([undefined]);
  });

  it('does not let a queued FORCE_LOGOUT end a successor login', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, NEXT_LOGIN).start();
    fireEvent(envelope(SSE_EVENT_FORCE_LOGOUT, null));
    expect(rec.forceLogouts).toEqual([]);
  });

  it('forwards connection state and reconnect countdowns', () => {
    installFakeFcm('connecting');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, LOGIN).start();
    fireConnState('open');
    fireConnState('reconnecting');
    fireReconnectIn(4000);
    fireReconnectIn(2000);
    expect(rec.states).toEqual(['connecting', 'open', 'reconnecting']);
    expect(rec.reconnectIns).toEqual([4000, 2000]);
  });

  it('retryNow clears the countdown and forwards the retry command to Rust', () => {
    const fcm = installFakeFcm('reconnecting');
    const rec = recordingSink();
    const transport = new NativeEventTransport(rec.sink, LOGIN);
    transport.start();
    transport.retryNow();
    expect(rec.reconnectIns).toContain(null);
    expect(fcm.retryNows()).toBe(1);
  });

  it('forceReconnect forwards the command without replacing the event hook', () => {
    const fcm = installFakeFcm('open');
    const rec = recordingSink();
    const transport = new NativeEventTransport(rec.sink, LOGIN);
    transport.start();
    const hook = window.__SOMS_EVENT__;
    transport.forceReconnect();
    expect(fcm.forceReconnects()).toBe(1);
    expect(window.__SOMS_EVENT__).toBe(hook);
  });

  it('emits reconnect only on open transitions after the first open', () => {
    installFakeFcm('closed');
    const rec = recordingSink();
    new NativeEventTransport(rec.sink, LOGIN).start();
    fireConnState('open');
    expect(rec.reconnects()).toBe(0);
    fireConnState('reconnecting');
    fireConnState('open');
    fireConnState('reconnecting');
    fireConnState('open');
    expect(rec.reconnects()).toBe(2);
  });

  it('start is idempotent', () => {
    installFakeFcm('open');
    const rec = recordingSink();
    const transport = new NativeEventTransport(rec.sink, LOGIN);
    transport.start();
    transport.start();
    expect(rec.states).toEqual(['open']);
  });

  it('stop detaches every hook, emits closed, and resets first-open tracking', () => {
    installFakeFcm('closed');
    const rec = recordingSink();
    const transport = new NativeEventTransport(rec.sink, LOGIN);
    transport.start();
    fireConnState('open');
    transport.stop();
    fireEvent(envelope('STATE_FEED_UPDATED', { feedId: 9 }));
    expect(rec.events).toEqual([]);
    expect(window.__SOMS_EVENT__).toBeUndefined();
    expect(window.__SOMS_CONN_STATE__).toBeUndefined();
    expect(window.__SOMS_RECONNECT_IN__).toBeUndefined();
    expect(rec.states.at(-1)).toBe('closed');
    transport.start();
    fireConnState('open');
    expect(rec.reconnects()).toBe(0);
  });
});
