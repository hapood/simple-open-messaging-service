import { Injectable, signal } from '@angular/core';
import { Subject, filter, firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { sseUrl } from './constants';
import type { ToMain, ToWorker } from './sse-worker-protocol';

export interface StandardMessage<T = any> {
  event: string,
  status: number,
  message: string,
  data?: T
}

/**
 * SSE connection state — the single source of truth the UI reads to surface connection problems.
 *  - `connecting`: first attempt in progress (no live frame has ever arrived).
 *  - `open`: the stream is up; live frames are flowing.
 *  - `reconnecting`: a dropped stream / network error / 401-renew is in the backoff loop.
 *  - `closed`: `disconnect()` (logout / force-login) — no reconnection will happen.
 * The shell renders a slim banner whenever state is `connecting` or `reconnecting` so a silent
 * disconnect never looks like "messages just stopped" (the exact failure mode this signal exists for).
 */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/**
 * Realtime downlink channel (SSE), now bridged through a dedicated Web Worker (`sse.worker.ts`).
 *
 * The filename stays `websocket.service.ts` to avoid touching the import sites; internally it long
 * since migrated from WS to SSE, and the SSE connection loop now lives in the worker so it no longer
 * contends with the main thread. This class is a thin `postMessage` bridge: it owns NO connection
 * state itself — it spawns the worker, forwards its `state` / `event` / `reconnect` messages onto the
 * unchanged RxJS subjects + signal that every consumer already reads, and answers the worker's token
 * requests using {@link AuthService} (which only the main thread can reach).
 *
 * The public surface — `eventSubject`, `reconnect$`, `state`, `connect()`, `disconnect()` — is
 * byte-identical to the pre-worker version, so {@link HttpItemSource}, {@link GroupEventService},
 * {@link HomeComponent}, {@link ConnectionBannerComponent} and {@link HomeShellComponent} are untouched.
 *
 * Token handshake (the worker cannot reach AuthService or localStorage, so it asks us):
 *  - `need-token` → return the current access token (wait for one if none held yet). Cheap path.
 *  - `renew-token` → a 401 occurred; call `renewAccessToken()` (single-flight across concurrent
 *    requests), return the fresh token or `token-failed` (which stops the worker — `redoLoginAuth`
 *    has already run inside renew).
 * Replies are routed to the specific `Worker` instance that asked, so a reply computed before a
 * `disconnect()`/reconnect can never land in a freshly-spawned worker.
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

  /** The spawned SSE worker. Undefined while disconnected (or between an error and the respawn). */
  private worker?: Worker;
  /** The pending 1s respawn from {@link onWorkerError}, cancelled if {@link retryNow} fires first. */
  private respawnTimer?: ReturnType<typeof setTimeout>;
  /** Single-flight in-progress token renew, so concurrent `renew-token` requests share one call.
   *  `AuthService.renewAccessToken()` nulls `acTkSub` mid-flight, so un-collapsed concurrent callers
   *  would both see null and loop — this collapses them onto the same Promise. */
  private renewInFlight?: Promise<string | null>;

  constructor(private authService: AuthService) {
    this.connect()
  }

  public connect() {
    if (this.worker) {
      return // idempotent — the worker owns the single connection
    }
    this.respawnTimer = undefined // respawn fired (or retryNow spawned directly) — no longer pending
    this.state.set('connecting')
    // `new URL('./sse.worker', import.meta.url)` is what tells the `application` builder to emit the
    // worker as its own hashed chunk (auto-bundled; no separate tsConfig needed). `type: 'module'`
    // because the worker is ESM.
    const worker = new Worker(new URL('./sse.worker', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }: MessageEvent<ToMain>) => this.onMessage(data)
    worker.onerror = () => this.onWorkerError()
    this.worker = worker
    worker.postMessage({ type: 'start', url: sseUrl } satisfies ToWorker)
  }

  /** Logout / force-login: tell the worker to stop, terminate it, and clear main-side state. */
  public disconnect() {
    this.worker?.postMessage({ type: 'stop' } satisfies ToWorker)
    this.worker?.terminate()
    this.worker = undefined
    clearTimeout(this.respawnTimer)
    this.respawnTimer = undefined
    this.renewInFlight = undefined
    this.state.set('closed')
  }

  private onMessage(m: ToMain): void {
    switch (m.type) {
      case 'state': this.state.set(m.state); break
      case 'event': this.eventSubject.next(m.payload as StandardMessage); break
      case 'reconnect': this.reconnect$.next(); break
      case 'need-token': void this.handleNeedToken(m.reqId); break
      case 'renew-token': void this.handleRenewToken(m.reqId); break
      case 'force-logout':
        // Server-initiated kick: stop the worker and re-run the login flow.
        this.disconnect()
        this.authService.redoLoginAuth()
        break
    }
  }

  /** Cheap path — provide the current access token, waiting for one if none is held yet (mirrors the
   *  old main-thread `_waitForToken`). */
  private async handleNeedToken(reqId: string): Promise<void> {
    const worker = this.worker
    if (!worker) return
    let token = this.authService.accessToken
    if (!token) {
      token = await this.waitForAccessToken()
    }
    // If disconnect()/reconnect swapped the worker while we were waiting, drop the reply.
    if (this.worker !== worker) return
    this.postTokenReply(worker, reqId, token)
  }

  /** Expensive path — a 401 occurred; renew the access token (single-flight), then reply. On failure
   *  `redoLoginAuth` has already run inside renew → we reply `token-failed` and the worker stops. */
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

  /** Resolve the first non-null access token from AuthService. Returns null if none arrives — the
   *  worker treats null as "give up" (only happens on the failure path, where redoLoginAuth ran). */
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
    this.state.set('reconnecting')
    this.respawnTimer = setTimeout(() => this.connect(), 1000)
  }

  /** User-initiated retry (the disconnected chip is clicked while `reconnecting`). Two cases:
   *  - worker alive but in its backoff loop: tell it to skip the current backoff sleep and retry now
   *    (resets the attempt counter too, so a fresh failure restarts backoff from 1s);
   *  - worker died (between {@link onWorkerError}'s terminate and its 1s respawn): cancel the pending
   *    respawn and reconnect at once.
   *  No-op when neither condition holds (e.g. already `open`, or `closed` = logged out). */
  public retryNow(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'retry-now' } satisfies ToWorker)
    } else if (this.respawnTimer) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = undefined
      this.connect()
    }
  }
}
