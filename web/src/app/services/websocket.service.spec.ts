import { TestBed } from '@angular/core/testing';
import { ApplicationRef, provideZonelessChangeDetection } from '@angular/core';
import { WebsocketService } from './websocket.service';
import type { StandardMessage } from './realtime-transport';
import { SessionStateService } from './session-state.service';
import { NativeCommitEventsService } from './native-commit-events.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { PushRegistrationService } from './push-registration.service';
import { parseLoginSessionId } from './session/session-identity';

/**
 * WebsocketService unit tests — the countdown-clock + state plumbing of the realtime facade.
 *
 * The whole point of this spec: the `reconnectIn` countdown clock (deadline recorded on
 * {@link RealtimeSink.onReconnectIn}, a 250ms ticker decrementing it, cleared on any state that leaves
 * `reconnecting`) is the most logic-heavy piece the facade owns, and it had no coverage. Everything else
 * the facade does is delegation.
 *
 * The browser transport (`WorkerSseTransport`) spawns a dedicated worker in its `start()`; under Karma that
 * `new Worker(new URL('./sse.worker', import.meta.url))` would spawn a file:// worker that never connects,
 * so `globalThis.Worker` is swapped for {@link FakeWorker} before each test. The fake records itself as the
 * "live" worker so a test can `emit(...)` the exact `ToMain` messages the real worker posts (`state`,
 * `reconnect-in`) and assert what the facade did with them — driving the same sink path the production
 * transport uses, not a mock of it. Credential-free session state and its presence cookie are set
 * authenticated so the connect-on-boot guard fires and the transport actually starts).
 */

/** A drop-in `Worker` stub: captures the instance so a test can push worker→main messages into the
 *  transport's `onmessage`, and no-ops `postMessage`/`terminate`. The constructor signature mirrors the
 *  real one (`url`, `options`) so the transport's `new Worker(new URL(...), { type: 'module' })` call is
 *  shape-compatible. */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly posted: unknown[] = [];
  constructor(_url: unknown, _opts?: unknown) {
    liveWorker = this;
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
    /* captured: the transport posts lifecycle commands here */
  }
  terminate(): void {
    /* no-op */
  }
  /** Push a worker→main message the way `sw.postMessage` would deliver it on the real worker. */
  emit(msg: unknown): void {
    this.onmessage?.({ data: msg });
  }
}

/** The most recently spawned FakeWorker (the facade spawns exactly one on the browser path). */
let liveWorker: FakeWorker | undefined;
/** The real `Worker` ctor, restored after each test so the stub never leaks to other specs. */
let realWorker: typeof Worker | undefined;

describe('WebsocketService (reconnect countdown clock)', () => {
  let ws: WebsocketService;

  beforeEach(() => {
    realWorker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    liveWorker = undefined;
    TestBed.configureTestingModule({
      providers: [
        { provide: PushRegistrationService, useValue: { onEvent: vi.fn() } },
        provideZonelessChangeDetection(),
        WebsocketService,
      ],
    });
    document.cookie = 'logged_in=1; Path=/';
    TestBed.inject(SessionStateService).setAuthenticated(true);
    ws = TestBed.inject(WebsocketService);
    ws.connect();
    // Transport mechanics are driven explicitly; application lifecycle is tested separately.
    TestBed.inject(ApplicationRef).tick();
  });

  afterEach(async () => {
    // Stop any running countdown ticker + tear the transport down so it never leaks into the next spec.
    ws?.disconnect();
    document.cookie = 'logged_in=; Max-Age=0; Path=/';
    // One bounded task-turn drain of the teardown's pending promises. This is not a timed wait —
    // transport.stop() schedules no timers, so a single turn always suffices.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (realWorker) globalThis.Worker = realWorker;
    liveWorker = undefined;
  });

  it('ignores callbacks from an invalidated connection after a new connection starts', () => {
    const oldWorker = liveWorker!;
    const events = vi.fn();
    ws.eventSubject.subscribe(events);
    TestBed.inject(SessionLifecycleService).invalidateSession();
    expect(ws.state()).toBe('closed');
    ws.connect();
    expect(liveWorker).not.toBe(oldWorker);
    oldWorker.emit({ type: 'event', payload: { event: 'OLD' } });
    oldWorker.emit({ type: 'state', state: 'open' });
    expect(events).not.toHaveBeenCalled();
    expect(ws.state()).toBe('connecting');
    liveWorker!.emit({ type: 'event', payload: { event: 'CURRENT' } });
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('does not mark a stream ready merely because it is open and receiving transport heartbeats', () => {
    vi.useFakeTimers();
    try {
      const initial = liveWorker;
      liveWorker!.emit({ type: 'state', state: 'open' });
      // Transport heartbeats are consumed below the facade; no HELLO is delivered.
      expect(ws.helloReady$.value).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(liveWorker).not.toBe(initial);
      expect(ws.helloReady$.value).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports forced logout after stopping transport without constructing AuthService', () => {
    const revoked = vi.fn(() => expect(ws.state()).toBe('closed'));
    ws.forcedLogout$.subscribe(revoked);
    liveWorker!.emit({ type: 'force-logout' });
    expect(revoked).toHaveBeenCalledOnce();
  });

  it('publishes native completions only from the current login owner and transport', () => {
    const lifecycle = TestBed.inject(SessionLifecycleService);
    const originalId = parseLoginSessionId(
      '11111111-1111-4111-8111-111111111111',
    );
    const successorId = parseLoginSessionId(
      '22222222-2222-4222-8222-222222222222',
    );
    lifecycle.bindSession(originalId);
    ws.connect();
    const completed = vi.fn();
    TestBed.inject(NativeCommitEventsService).committed$.subscribe(completed);
    const old = liveWorker!;
    const message = {
      event: 'LOCAL_STATE_FEED_COMMITTED',
      loginSessionId: originalId,
      status: 0,
      message: '',
      data: { userId: 42 },
    };
    old.emit({ type: 'event', payload: message });
    expect(completed).toHaveBeenCalledWith(message);
    lifecycle.bindSession(successorId);
    ws.connect();
    completed.mockClear();
    old.emit({ type: 'event', payload: message });
    expect(completed).not.toHaveBeenCalled();
    liveWorker!.emit({ type: 'event', payload: message });
    expect(completed).not.toHaveBeenCalled();
    liveWorker!.emit({
      type: 'event',
      payload: { ...message, loginSessionId: successorId },
    });
    expect(completed).toHaveBeenCalledOnce();
    liveWorker!.emit({
      type: 'event',
      payload: { ...message, event: 'HELLO_OTHER' },
    });
    expect(completed).toHaveBeenCalledOnce();
  });

  it('transfers the DB port to the active SSE worker', () => {
    const channel = new MessageChannel();
    const post = vi.spyOn(liveWorker!, 'postMessage');
    ws.attachThreadFeed(channel.port1, 1);
    expect(post).toHaveBeenCalledTimes(1);
    const [message, transfer] = post.mock.calls[0] as unknown as [
      { type: string; port: MessagePort; userId: number },
      MessagePort[],
    ];
    expect(message.type).toBe('thread-feed-port');
    expect(message.userId).toBe(1);
    expect(message.port).toBe(channel.port1);
    expect(transfer[0]).toBe(channel.port1);
    channel.port1.close();
    channel.port2.close();
  });

  it('boots connecting, spawns the SSE worker, and has no countdown scheduled', () => {
    // The transport's start() posts `connecting` immediately; reconnectIn is null until a backoff is scheduled.
    expect(liveWorker).toBeInstanceOf(FakeWorker);
    expect(ws.state()).toBe('connecting');
    expect(ws.reconnectIn()).toBeNull();
  });

  it('does not reconnect a replaced session automatically, but permits explicit takeover', () => {
    const old = liveWorker!;
    old.emit({ type: 'replaced' });
    expect(ws.state()).toBe('closed');
    window.dispatchEvent(new Event('online'));
    expect(old.posted).not.toContainEqual({ type: 'network-online' });
    ws.retryNow();
    expect(liveWorker).not.toBe(old);
    expect(ws.state()).toBe('connecting');
    old.emit({ type: 'state', state: 'open' });
    expect(ws.state()).toBe('connecting');
  });

  it('forwards main-thread network changes to the active worker', () => {
    const posted = liveWorker!.posted as Array<{ type: string }>;
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(posted.map((message) => message.type)).toContain('network-offline');
    expect(posted.map((message) => message.type)).toContain('network-online');
  });

  it('removes main-thread network listeners when the transport stops', () => {
    ws.disconnect();
    const stoppedWorker = liveWorker!;
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(
      stoppedWorker.posted.map((message: any) => message.type),
    ).not.toContain('network-offline');
    expect(
      stoppedWorker.posted.map((message: any) => message.type),
    ).not.toContain('network-online');
  });

  it('records the deadline on reconnect-in and the ticker decrements it over time', async () => {
    // The ticker is a real setInterval(250) reading Date.now() — fake timers advance both the
    // interval queue and the virtual clock, so exactly one tick fires with zero wall-clock dependence.
    vi.useFakeTimers();
    try {
      liveWorker!.emit({ type: 'state', state: 'reconnecting' });
      liveWorker!.emit({ type: 'reconnect-in', ms: 5000 });
      expect(ws.state()).toBe('reconnecting');
      // Right after the deadline lands: ~5000ms remaining (allow a hair for the synchronous set).
      expect(ws.reconnectIn()).not.toBeNull();
      expect(ws.reconnectIn()!).toBeGreaterThan(4500);
      // Advance exactly one 250ms tick → the remaining time must have dropped.
      await vi.advanceTimersByTimeAsync(250);
      expect(ws.reconnectIn()!).toBeLessThan(4800);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-reconnecting state (open) clears the countdown + stops the ticker', async () => {
    vi.useFakeTimers();
    try {
      liveWorker!.emit({ type: 'state', state: 'reconnecting' });
      liveWorker!.emit({ type: 'reconnect-in', ms: 5000 });
      expect(ws.reconnectIn()).not.toBeNull();
      liveWorker!.emit({ type: 'state', state: 'open' });
      expect(ws.reconnectIn()).toBeNull();
      // Deterministic negative: a full second of timer time cannot revive a cleared ticker.
      await vi.advanceTimersByTimeAsync(1000);
      expect(ws.reconnectIn()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retryNow() drops the stale countdown immediately (the manual retry voids the backoff)', () => {
    liveWorker!.emit({ type: 'state', state: 'reconnecting' });
    liveWorker!.emit({ type: 'reconnect-in', ms: 5000 });
    expect(ws.reconnectIn()).not.toBeNull();
    ws.retryNow(); // browser transport: onReconnectIn(null) + posts retry-now to the worker
    expect(ws.reconnectIn()).toBeNull();
  });

  it('a reconnect-in of null / non-positive is a clear, never a negative countdown', () => {
    liveWorker!.emit({ type: 'state', state: 'reconnecting' });
    liveWorker!.emit({ type: 'reconnect-in', ms: 5000 });
    liveWorker!.emit({ type: 'reconnect-in', ms: null });
    expect(ws.reconnectIn()).toBeNull();
    liveWorker!.emit({ type: 'reconnect-in', ms: 0 });
    expect(ws.reconnectIn()).toBeNull();
  });

  it('forwards state-feed wakes immediately', () => {
    const received: number[] = [];
    ws.eventSubject.subscribe((message) =>
      received.push(
        (
          message.data as {
            feedId: number;
          }
        ).feedId,
      ),
    );
    for (const feedId of [6, 9, 8]) {
      liveWorker!.emit({
        type: 'event',
        payload: {
          event: 'STATE_FEED_UPDATED',
          status: 0,
          message: '',
          data: { feedId },
        },
      });
    }
    expect(received).toEqual([6, 9, 8]);
  });

  it('rejects HELLO without the mandatory stateFeedEndId', () => {
    const received: StandardMessage[] = [];
    ws.eventSubject.subscribe((message) => received.push(message));
    liveWorker!.emit({ type: 'state', state: 'open' });
    liveWorker!.emit({
      type: 'event',
      payload: {
        event: 'HELLO',
        status: 0,
        message: '',
        data: { userId: 1 },
      },
    });
    // forceReconnect tears down and immediately starts the replacement transport,
    // whose first observable state is `connecting`.
    expect(ws.state()).toBe('connecting');
    expect(received).toEqual([]);
  });

  it('requires the thread cursor in HELLO and passes a complete handshake through', () => {
    const received: StandardMessage[] = [];
    ws.eventSubject.subscribe((message) => received.push(message));
    liveWorker!.emit({
      type: 'event',
      payload: {
        event: 'HELLO',
        status: 0,
        message: '',
        data: { userId: 1, stateFeedEndId: 2 },
      },
    });
    expect(received).toEqual([]);
    liveWorker!.emit({
      type: 'event',
      payload: {
        event: 'HELLO',
        status: 0,
        message: '',
        data: { userId: 1, stateFeedEndId: 2, threadFeedEndId: 3 },
      },
    });
    expect(received).toHaveLength(1);
  });

  it('rejects THREAD_FEED_UPDATED without a valid thread cursor', () => {
    const received: StandardMessage[] = [];
    ws.eventSubject.subscribe((message) => received.push(message));
    liveWorker!.emit({
      type: 'event',
      payload: {
        event: 'THREAD_FEED_UPDATED',
        status: 0,
        message: '',
        data: { threadFeedEndId: -1 },
      },
    });
    expect(received).toEqual([]);
  });

  it('rejects STATE_FEED_UPDATED without the mandatory feedId', () => {
    const received: StandardMessage[] = [];
    ws.eventSubject.subscribe((message) => received.push(message));
    liveWorker!.emit({ type: 'state', state: 'open' });
    liveWorker!.emit({
      type: 'event',
      payload: {
        event: 'STATE_FEED_UPDATED',
        status: 0,
        message: '',
        data: {},
      },
    });
    expect(ws.state()).toBe('connecting');
    expect(received).toEqual([]);
  });
});
