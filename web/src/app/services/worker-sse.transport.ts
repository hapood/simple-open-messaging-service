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
 * and answers the worker's `need-token` request with the long-lived session token.
 *
 * Token handshake: the worker is spawned at boot (pre-login) and asks for the token via `need-token`. We
 * hand it the current session token, waiting for the first non-null emission if login hasn't happened yet
 * (the worker must BLOCK, not busy-loop). The token is long-lived + reused across reconnects — there is no
 * `renew-token` (a 401 means the session is dead; the worker posts `force-logout` and stops). Replies are
 * routed to the specific `Worker` instance that asked, so a reply computed before a `stop()`/reconnect can
 * never land in a freshly-spawned worker.
 */
export class WorkerSseTransport extends RealtimeTransport {
  /** The spawned SSE worker. Undefined while stopped (or between an error and the respawn). */
  private worker?: Worker;
  /** The pending 1s respawn from {@link onWorkerError}, cancelled if {@link retryNow} fires first. */
  private respawnTimer?: ReturnType<typeof setTimeout>;

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
      case 'force-logout':
        // The session token 401'd (revoked/expired) OR the server pushed FORCE_LOGOUT — the worker has
        // already stopped itself; the facade clears state + re-logs in (onForceLogout).
        this.sink.onForceLogout();
        break;
    }
  }

  /** Provide the long-lived session token. If none is held yet (the worker spawned at boot, pre-login),
   *  block on the first non-null emission so the worker doesn't busy-loop. If `stop()`/reconnect swapped
   *  the worker while we were waiting, drop the reply. A null result (logout won the race) is replied as
   *  `token-failed`, which makes the worker treat it as a give-up (it stops + the facade re-logs in). */
  private async handleNeedToken(reqId: string): Promise<void> {
    const worker = this.worker
    if (!worker) return
    let token = this.authService.sessionToken
    if (!token) {
      token = await firstValueFrom(
        this.authService.sessionToken$.pipe(filter((t): t is string => t !== null)),
      ).catch(() => null)
    }
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

  /** A dedicated worker that throws an uncaught exception is dead — it will never recover on its own,
   *  so SSE would silently stop forever. Flip to `reconnecting` (so the banner explains the outage) and
   *  respawn the worker after a short delay; the worker's own backoff then paces reconnect attempts. */
  private onWorkerError(): void {
    this.worker?.terminate()
    this.worker = undefined
    this.sink.onState('reconnecting')
    this.respawnTimer = setTimeout(() => this.start(), 1000)
  }
}
