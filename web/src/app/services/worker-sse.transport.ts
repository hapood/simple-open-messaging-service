import { firstValueFrom, filter } from 'rxjs';
import type { AuthService } from './auth.service';
import { sseUrl } from './constants';
import {
  RealtimeTransport,
  type ConnectionState,
  type RealtimeSink,
  type StandardMessage,
} from './realtime-transport';
import type { ToMain, ToWorker } from './sse-worker-protocol';

/**
 * The browser + desktop (pc/mac/linux Tauri) realtime transport: spawns the dedicated `sse.worker.ts`
 * that owns the native `fetch` + `ReadableStream` SSE loop, the reconnect/backoff, the liveness watchdog,
 * and the online/offline fast-path — everything off the main thread so SSE parsing never contends with
 * the virtual-scroll kernel or the Tiptap editor. This class is a thin `postMessage` bridge: it spawns
 * the worker, forwards its `state`/`event`/`reconnect`/`force-logout` messages onto the {@link RealtimeSink},
 * and answers the worker's token requests via {@link AuthService} (which only the main thread can reach).
 *
 * Token handshake (the worker cannot reach AuthService or localStorage, so it asks us):
 *  - `need-token` → return the current access token (wait for one if none held yet). Cheap path.
 *  - `renew-token` → a 401 occurred; call `renewAccessToken()` (single-flight across concurrent
 *    requests), return the fresh token or `token-failed` (which stops the worker — `redoLoginAuth`
 *    has already run inside renew). Replies are routed to the specific `Worker` instance that asked,
 *    so a reply computed before a `stop()`/reconnect can never land in a freshly-spawned worker.
 */
export class WorkerSseTransport extends RealtimeTransport {
  /** The spawned SSE worker. Undefined while stopped (or between an error and the respawn). */
  private worker?: Worker;
  /** The pending 1s respawn from {@link onWorkerError}, cancelled if {@link retryNow} fires first. */
  private respawnTimer?: ReturnType<typeof setTimeout>;
  /** Single-flight in-progress token renew, so concurrent `renew-token` requests share one call.
   *  `AuthService.renewAccessToken()` nulls `acTkSub` mid-flight, so un-collapsed concurrent callers
   *  would both see null and loop — this collapses them onto the same Promise. */
  private renewInFlight?: Promise<string | null>;

  constructor(sink: RealtimeSink, private readonly authService: AuthService) {
    super(sink);
  }

  start(): void {
    if (this.worker) return; // idempotent — the worker owns the single connection
    this.respawnTimer = undefined; // respawn fired (or retryNow spawned directly) — no longer pending
    this.sink.onState('connecting');
    // `new URL('./sse.worker', import.meta.url)` is what tells the `application` builder to emit the
    // worker as its own hashed chunk (auto-bundled; no separate tsConfig needed). `type: 'module'`
    // because the worker is ESM. sseUrl() is read fresh so a backend-origin swap (the facade tears this
    // transport down and restarts it) reconnects against the new host.
    const worker = new Worker(new URL('./sse.worker', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<ToMain>) => this.onMessage(data);
    worker.onerror = () => this.onWorkerError();
    this.worker = worker
    worker.postMessage({ type: 'start', url: sseUrl() } satisfies ToWorker)
  }

  /** Logout / force-login / origin swap: tell the worker to stop, terminate it. */
  stop(): void {
    this.worker?.postMessage({ type: 'stop' } satisfies ToWorker)
    this.worker?.terminate()
    this.worker = undefined
    clearTimeout(this.respawnTimer)
    this.respawnTimer = undefined
    this.renewInFlight = undefined
    this.sink.onState('closed')
  }

  /** User-initiated retry (the disconnected chip clicked while `reconnecting`). Two cases:
   *  - worker alive but in its backoff loop: tell it to skip the current backoff sleep and retry now;
   *  - worker died (between {@link onWorkerError}'s terminate and its 1s respawn): cancel the pending
   *    respawn and reconnect at once. No-op when neither holds (already `open`, or `closed`). */
  override retryNow(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'retry-now' } satisfies ToWorker)
    } else if (this.respawnTimer) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = undefined
      this.start()
    }
  }

  private onMessage(m: ToMain): void {
    switch (m.type) {
      case 'state': this.sink.onState(m.state as ConnectionState); break;
      case 'event': this.sink.onEvent(m.payload as StandardMessage); break;
      case 'reconnect': this.sink.onReconnect(); break;
      case 'need-token': void this.handleNeedToken(m.reqId); break;
      case 'renew-token': void this.handleRenewToken(m.reqId); break;
      case 'force-logout':
        // Server-initiated kick — the facade clears state + re-logs in (onForceLogout).
        this.sink.onForceLogout();
        break;
    }
  }

  /** Cheap path — provide the current access token, waiting for one if none is held yet. */
  private async handleNeedToken(reqId: string): Promise<void> {
    const worker = this.worker
    if (!worker) return
    let token = this.authService.accessToken
    if (!token) {
      token = await this.waitForAccessToken()
    }
    // If stop()/reconnect swapped the worker while we were waiting, drop the reply.
    if (this.worker !== worker) return
    this.postTokenReply(worker, reqId, token)
  }

  /** Expensive path — a 401 occurred; renew the access token (single-flight), then reply. On failure
   *  `redoLoginAuth` has already run inside renew → reply `token-failed` and the worker stops. */
  private async handleRenewToken(reqId: string): Promise<void> {
    const worker = this.worker
    if (!worker) return
    if (!this.renewInFlight) {
      this.renewInFlight = new Promise<string | null>((resolve) => {
        this.authService.renewAccessToken().subscribe({
          next: (res) => resolve(res.code === 0 ? this.authService.accessToken : null),
          error: () => resolve(null),
        })
      })
    }
    const token = await this.renewInFlight
    this.renewInFlight = undefined
    if (this.worker !== worker) return
    this.postTokenReply(worker, reqId, token)
  }

  private postTokenReply(worker: Worker, reqId: string, token: string | null): void {
    worker.postMessage(
      (token
        ? { type: 'token', reqId, token }
        : { type: 'token-failed', reqId }) satisfies ToWorker,
    )
  }

  /** Resolve the first non-null access token from AuthService. Returns null if none arrives — the worker
   *  treats null as "give up" (only happens on the failure path, where redoLoginAuth ran). */
  private async waitForAccessToken(): Promise<string | null> {
    const cur = this.authService.accessToken
    if (cur) return cur
    try {
      return await firstValueFrom(
        this.authService.acTkSub.pipe(filter((t): t is string => t !== null)),
      )
    } catch {
      return null
    }
  }

  /** A dedicated worker that throws an uncaught exception is dead — it will never recover on its own,
   *  so SSE would silently stop forever. Flip to `reconnecting` (so the banner explains the outage) and
   *  respawn the worker after a short delay; the worker's own backoff then paces reconnect attempts. */
  private onWorkerError(): void {
    this.worker?.terminate()
    this.worker = undefined
    this.renewInFlight = undefined
    this.sink.onState('reconnecting')
    this.respawnTimer = setTimeout(() => this.start(), 1000)
  }
}
