import {
  RealtimeTransport,
  type ConnectionState,
  type RealtimeSink,
  type StandardMessage,
} from './realtime-transport';
import type { ToMain, ToWorker } from './sse-worker-protocol';
import { sseUrl } from './constants';

/**
 * The browser realtime transport: spawns the dedicated `sse.worker.ts` that owns the native `fetch` +
 * `ReadableStream` SSE loop, the reconnect/backoff, the liveness watchdog, and the online/offline fast-path
 * — everything off the main thread so SSE parsing never contends with the virtual-scroll kernel or the
 * Tiptap editor. This class is a thin `postMessage` bridge: it spawns the worker, forwards its
 * `state`/`event`/`reconnect`/`force-logout` messages onto the {@link RealtimeSink}, and owns the respawn
 * lifecycle.
 *
 * Browser-only by construction (the facade selects `RustChannelSseTransport` under Tauri desktop +
 * `NativeEventTransport` under Android), so the stream is SAME-ORIGIN and authenticates via the httpOnly
 * session cookie (fetch's default `credentials: same-origin` attaches it) — NO session token is held in JS
 * or handed to the worker. A 401 means the session is revoked/expired → the worker posts `force-logout`
 * (main re-logs in) and stops; there is no token renewal.
 */
export class WorkerSseTransport extends RealtimeTransport {
  /** The spawned SSE worker. Undefined while stopped (or between an error and the respawn). */
  private worker?: Worker;
  /** The pending 1s respawn from {@link onWorkerError}, cancelled if {@link retryNow} fires first. */
  private respawnTimer?: ReturnType<typeof setTimeout>;
  /** Main-thread fallback for browsers that do not deliver online/offline to DedicatedWorkerGlobalScope. */
  private readonly onOffline = (): void => {
    this.worker?.postMessage({ type: 'network-offline' } satisfies ToWorker);
  };
  private readonly onOnline = (): void => {
    this.worker?.postMessage({ type: 'network-online' } satisfies ToWorker);
  };

  constructor(sink: RealtimeSink) {
    super(sink);
  }

  attachThreadFeed(port: MessagePort, userId: number): void {
    if (!this.worker) {
      port.close();
      return;
    }
    this.worker.postMessage(
      { type: 'thread-feed-port', port, userId } satisfies ToWorker,
      [port],
    );
  }

  start(): void {
    if (this.worker) return; // idempotent — the worker owns the single connection
    this.respawnTimer = undefined; // respawn fired (or retryNow spawned directly) — no longer pending
    this.sink.onState('connecting');
    // `new URL('./sse.worker', import.meta.url)` is what tells the `application` builder to emit the
    // worker as its own hashed chunk (auto-bundled; no separate tsConfig needed). `type: 'module'`
    // because the worker is ESM. sseUrl() is read fresh so a backend-origin swap (the facade tears this
    // transport down and restarts it) reconnects against the new host.
    const worker = new Worker(new URL('./sse.worker', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = ({ data }: MessageEvent<ToMain>) => {
      if (this.worker === worker) this.onMessage(data);
    };
    worker.onerror = () => {
      if (this.worker === worker) this.onWorkerError();
    };
    this.worker = worker;
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this.onOffline);
      window.addEventListener('online', this.onOnline);
    }
    worker.postMessage({ type: 'start', url: sseUrl() } satisfies ToWorker);
  }

  /** Logout / force-login / origin swap: tell the worker to stop, terminate it. */
  stop(): void {
    this.removeNetworkListeners();
    this.worker?.postMessage({ type: 'stop' } satisfies ToWorker);
    this.worker?.terminate();
    this.worker = undefined;
    clearTimeout(this.respawnTimer);
    this.respawnTimer = undefined;
    this.sink.onState('closed');
  }

  /** User-initiated retry (the disconnected chip clicked while `reconnecting`). Two cases:
   *  - worker alive but in its backoff loop: tell it to skip the current backoff sleep and retry now;
   *  - worker died (between {@link onWorkerError}'s terminate and its 1s respawn): cancel the pending
   *    respawn and reconnect at once. No-op when neither holds (already `open`, or `closed`). */
  override retryNow(): void {
    // A manual retry voids the scheduled backoff (the current sleep is resolved, the loop reconnects at
    // once), so drop the countdown immediately — otherwise the chip keeps ticking a stale deadline while
    // the reconnect is in flight. A fresh deadline is posted on the next failure; success clears via state.
    this.sink.onReconnectIn(null);
    if (this.worker) {
      this.worker.postMessage({ type: 'retry-now' } satisfies ToWorker);
    } else if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = undefined;
      this.start();
    }
  }

  private onMessage(m: ToMain): void {
    switch (m.type) {
      case 'state':
        this.sink.onState(m.state as ConnectionState);
        break;
      case 'event':
        this.sink.onEvent(m.payload as StandardMessage);
        break;
      case 'reconnect':
        this.sink.onReconnect();
        break;
      case 'reconnect-in':
        this.sink.onReconnectIn(m.ms);
        break;
      case 'force-logout':
        // The session 401'd (cookie revoked/expired) OR the server pushed FORCE_LOGOUT — the worker has
        // already stopped itself; the facade clears state + re-logs in (onForceLogout).
        this.sink.onForceLogout();
        break;
    }
  }

  /** A dedicated worker who throws an uncaught exception is dead — it will never recover on its own,
   *  so SSE would silently stop forever. Flip to `reconnecting` (so the banner explains the outage) and
   *  respawn the worker after a short delay; the worker's own backoff then paces reconnect attempts. */
  private onWorkerError(): void {
    this.removeNetworkListeners();
    this.worker?.terminate();
    this.worker = undefined;
    this.sink.onState('reconnecting');
    // Announce the respawn delay so the countdown ticks during this main-thread wait too (the worker
    // isn't alive to emit its own deadline; `start()` posts `connecting` on respawn, which clears it).
    this.sink.onReconnectIn(1000);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      this.start();
    }, 1000);
  }

  private removeNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('online', this.onOnline);
  }
}
