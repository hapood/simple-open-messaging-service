import { TestBed } from '@angular/core/testing';
import {
  ApplicationRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { WebsocketService } from './websocket.service';
import type { StandardMessage } from './realtime-transport';
import { AuthService } from './auth.service';
import { ThreadDeletionLockService } from './thread-deletion-lock.service';

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
 * transport uses, not a mock of it. AuthService is a one-method stub (`isLoggedIn` → true, so the
 * connect-on-boot guard fires and the transport actually starts).
 */

/** A drop-in `Worker` stub: captures the instance so a test can push worker→main messages into the
 *  transport's `onmessage`, and no-ops `postMessage`/`terminate`. The constructor signature mirrors the
 *  real one (`url`, `options`) so the transport's `new Worker(new URL(...), { type: 'module' })` call is
 *  shape-compatible. */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(_url: unknown, _opts?: unknown) {
    liveWorker = this;
  }
  postMessage(_msg: unknown): void {
    /* captured: the transport posts `start`/`retry-now`/`stop` here */
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

/** Drain the macrotask queue so the ctor's `connect()` + the 250ms ticker settle before assertions. */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WebsocketService (reconnect countdown clock)', () => {
  let ws: WebsocketService;
  let deletionLock: ThreadDeletionLockService;

  beforeEach(() => {
    realWorker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    liveWorker = undefined;
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        WebsocketService,
        {
          provide: AuthService,
          useValue: { loggedIn: signal(true), isLoggedIn: () => true },
        },
      ],
    });
    ws = TestBed.inject(WebsocketService);
    deletionLock = TestBed.inject(ThreadDeletionLockService);
    // Flush the ctor's apiOrigin effect's first (no-op) run so it can't fire during a test.
    TestBed.inject(ApplicationRef).tick();
  });

  afterEach(async () => {
    // Stop any running countdown ticker + tear the transport down so it never leaks into the next spec.
    ws?.disconnect();
    await flush(0);
    if (realWorker) globalThis.Worker = realWorker;
    liveWorker = undefined;
  });

  it('boots connecting, spawns the SSE worker, and has no countdown scheduled', () => {
    // The transport's start() posts `connecting` immediately; reconnectIn is null until a backoff is scheduled.
    expect(liveWorker).toBeInstanceOf(FakeWorker);
    expect(ws.state()).toBe('connecting');
    expect(ws.reconnectIn()).toBeNull();
  });

  it('records the deadline on reconnect-in and the ticker decrements it over time', async () => {
    liveWorker!.emit({ type: 'state', state: 'reconnecting' });
    liveWorker!.emit({ type: 'reconnect-in', ms: 5000 });
    expect(ws.state()).toBe('reconnecting');
    // Right after the deadline lands: ~5000ms remaining (allow a hair for the synchronous set).
    expect(ws.reconnectIn()).not.toBeNull();
    expect(ws.reconnectIn()!).toBeGreaterThan(4500);
    // The 250ms ticker fires within the wait → the remaining time must have dropped.
    await flush(320);
    expect(ws.reconnectIn()!).toBeLessThan(4800);
  });

  it('a non-reconnecting state (open) clears the countdown + stops the ticker', async () => {
    liveWorker!.emit({ type: 'state', state: 'reconnecting' });
    liveWorker!.emit({ type: 'reconnect-in', ms: 5000 });
    expect(ws.reconnectIn()).not.toBeNull();
    liveWorker!.emit({ type: 'state', state: 'open' });
    expect(ws.reconnectIn()).toBeNull();
    // The ticker is stopped, so the signal stays null even after the interval would have fired.
    await flush(320);
    expect(ws.reconnectIn()).toBeNull();
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

  it('defers thread revisions behind a deletion lock and releases only the highest watermark', () => {
    const received: number[] = [];
    ws.eventSubject.subscribe((message) =>
      received.push(
        (
          message.data as {
            stateRevision: number;
          }
        ).stateRevision,
      ),
    );
    deletionLock.begin(7);

    for (const stateRevision of [6, 9, 8]) {
      liveWorker!.emit({
        type: 'event',
        payload: {
          event: 'STATE_REV_UPDATED',
          status: 0,
          message: '',
          data: { stateRevision },
        },
      });
    }
    expect(received).toEqual([]);

    deletionLock.end(7);

    expect(received).toEqual([9]);
  });

  it('keeps a deferred revision until every deletion lock has been released', () => {
    const received: number[] = [];
    ws.eventSubject.subscribe((message) =>
      received.push(
        (
          message.data as {
            stateRevision: number;
          }
        ).stateRevision,
      ),
    );
    deletionLock.begin(7);
    deletionLock.begin(8);
    liveWorker!.emit({
      type: 'event',
      payload: {
        event: 'STATE_REV_UPDATED',
        status: 0,
        message: '',
        data: { stateRevision: 9 },
      },
    });

    deletionLock.end(7);
    expect(received).toEqual([]);
    deletionLock.end(8);
    expect(received).toEqual([9]);
  });

  it('rejects HELLO without the mandatory stateRevision', () => {
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

  it('rejects STATE_REV_UPDATED without the mandatory stateRevision', () => {
    const received: StandardMessage[] = [];
    ws.eventSubject.subscribe((message) => received.push(message));
    liveWorker!.emit({ type: 'state', state: 'open' });
    liveWorker!.emit({
      type: 'event',
      payload: {
        event: 'STATE_REV_UPDATED',
        status: 0,
        message: '',
        data: {},
      },
    });
    expect(ws.state()).toBe('connecting');
    expect(received).toEqual([]);
  });
});
