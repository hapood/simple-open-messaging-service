import { Injectable, signal } from '@angular/core';
import { Subject, Subscription, filter, take, finalize } from 'rxjs';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { AuthService } from './auth.service';
import { sseUrl } from './constants';

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
 * Liveness watchdog thresholds. The server emits a `ping` event every HEARTBEAT_MS (25s). If no frame at
 * all (real event or ping) arrives within STALE_MS while a stream is `open`, the connection has silently
 * stalled — a half-open TCP socket or a network drop that never sent an RST, so the fetch never errors and
 * `onerror` never fires. The watchdog aborts the stream so `_run`'s error path flips state to
 * `reconnecting` (and the connection-lost banner appears). Tuned to ~2× the heartbeat + jitter margin.
 */
const STALE_MS = 60_000
const WATCHDOG_CHECK_MS = 5_000

/** Thrown when onopen sees a 401 (access token expired) → the outer loop renews the token and reopens
 *  immediately, without counting as a backoff step. */
class AuthNeededError extends Error {
  constructor() {
    super('auth-needed')
    this.name = 'AuthNeededError'
  }
}

/**
 * Realtime downlink channel (SSE). The filename stays `websocket.service.ts` to avoid touching the
 * 9 import sites; internally it has migrated from WS to `@microsoft/fetch-event-source` (fetch +
 * ReadableStream, supports a Bearer header and fully controllable reconnection).
 *
 * Push-only: sending/fetching messages all go over HTTP; this service only receives NEW_MESSAGE /
 * FORCE_LOGOUT downlink events.
 *
 * Reconnection strategy (the outer _run loop owns it; the library's built-in reconnect is disabled):
 * - Network/server error → exponential backoff + full jitter + 30s cap (thundering-herd defense:
 *   spreads out every client's reconnect when the server restarts).
 * - 401 access-token expiry → renew-access for a fresh token, then reopen immediately (resets backoff,
 *   no wait).
 * - renew failure (reuse/invalid) → redoLoginAuth has already run inside renew → stop reconnecting.
 * - FORCE_LOGOUT received / explicit disconnect() → do not reconnect.
 *
 * Gap recovery: the SSE stream itself does not replay history (the server ignores Last-Event-ID). On a
 * successful reconnect a reconnect$ pulse is emitted; each thread's http-item-source uses it to backfill
 * the messages missed during the disconnect via the newestMsgId cursor.
 */
@Injectable({
  providedIn: 'root',
})
export class WebsocketService {
  private readonly url = sseUrl
  /** True while inside the _run reconnect loop (incl. waiting for a token / stream open / backoff sleep).
   *  Makes connect() idempotent. */
  private _running = false
  /** Set by an explicit disconnect (logout / force-login) so the loop exits and onclose does not reconnect. */
  private _manualClose = false
  /** Backoff step counter (increments on failure, resets to 0 once a stream opens). */
  private _attempt = 0
  /** Whether a stream has ever opened — distinguishes the first connect from a reconnect (only the latter
   *  emits reconnect$). */
  private _openedOnce = false
  private _abort?: AbortController
  private _tokenSub?: Subscription
  /** Timestamp (ms) of the last received SSE frame (real event or server ping). Refreshed on every
   *  dispatch; the liveness watchdog aborts the stream if no frame arrives within STALE_MS. */
  private _lastFrameAt = 0
  /** True once a server `ping` event has been observed. The liveness watchdog only arms after this — so
   *  against an older backend that still emits `: ping` COMMENT frames (invisible to onmessage), the
   *  watchdog stays dormant and never false-triggers in a quiet chat. This decouples the client + server
   *  deploy: the watchdog self-activates the moment the named-ping backend is running. */
  private _pingObserved = false
  /** Liveness watchdog handle. Started in connect(), cleared in disconnect(). */
  private _watchdog?: ReturnType<typeof setInterval>
  /** Bound browser online/offline handlers (kept as fields so disconnect's removeEventListener matches).
   *  These fire instantly on DevTools network throttling / OS network changes — far faster than the
   *  heartbeat watchdog, which is the backstop for silent half-open stalls with navigator.onLine still true. */
  private readonly _onBrowserOffline = (): void => this._handleBrowserOffline()
  private readonly _onBrowserOnline = (): void => this._handleBrowserOnline()
  /** Resolver for the current _sleep, so an `online` event can wake the backoff loop to retry at once. */
  private _sleepResolver?: () => void

  readonly eventSubject = new Subject<StandardMessage>();
  /** Reconnect-success pulse: http-item-source subscribes and backfills messages missed during the
   *  disconnect via the newestMsgId cursor. */
  readonly reconnect$ = new Subject<void>();
  /** Connection state for the shell's connection-lost banner. See {@link ConnectionState}. */
  readonly state = signal<ConnectionState>('closed')

  constructor(private authService: AuthService) {
    this.connect()
  }

  public connect() {
    if (this._running) {
      return
    }
    this._running = true
    this._manualClose = false
    this._attempt = 0
    this.state.set('connecting')
    this._startWatchdog()
    this._startBrowserListeners()
    void this._run()
  }

  /** Logout / force-login: abort the stream and any token wait, set _manualClose so the loop stops
   *  reconnecting until the next connect(). */
  public disconnect() {
    this._manualClose = true
    this._running = false
    this.state.set('closed')
    this._tokenSub?.unsubscribe()
    this._tokenSub = undefined
    this._abort?.abort()
    this._abort = undefined
    this._stopWatchdog()
    this._stopBrowserListeners()
  }

  /** Reconnect main loop: each _openOnce call is one complete attempt to open the stream. */
  private async _run() {
    while (!this._manualClose) {
      try {
        await this._openOnce()
        if (this._manualClose) break
        // Stream closed cleanly by the server (e.g. a restart) → back off and reconnect.
        this.state.set('reconnecting')
        this._attempt++
        await this._sleep(this._backoff())
      } catch (err) {
        if (this._manualClose) break
        if (err instanceof AuthNeededError) {
          // 401: renew for a fresh token; on success reopen immediately (reset backoff), on failure stop
          // (redoLoginAuth already ran).
          this.state.set('reconnecting')
          const ok = await this._renewForReconnect()
          if (!ok || this._manualClose) break
          this._attempt = 0
          continue
        }
        // Network / other error: back off and retry.
        this.state.set('reconnecting')
        this._attempt++
        await this._sleep(this._backoff())
      }
    }
    this._running = false
    this.state.set('closed')
  }

  /** Open one SSE stream. A successful onopen resets backoff (and emits reconnect$ on a reconnect); a 401
   *  throws AuthNeededError; any other error is thrown up to the outer loop's backoff handling. */
  private async _openOnce() {
    const token = await this._waitForToken()
    if (token == null || this._manualClose) return

    this._abort = new AbortController()
    await fetchEventSource(this.url, {
      signal: this._abort.signal,
      headers: { Authorization: `Bearer ${token}` },
      // Keep receiving while the tab is in the background (chat pushes must not pause on tab switch).
      openWhenHidden: true,
      onopen: async (res) => {
        if (res.status === 401) {
          throw new AuthNeededError()
        }
        if (!res.ok) {
          throw new Error(`SSE open failed: ${res.status}`)
        }
        // Stream opened → reset backoff; a non-first open is a reconnect → emit the backfill pulse.
        this._attempt = 0
        if (this._openedOnce) this.reconnect$.next()
        this._openedOnce = true
        this._lastFrameAt = Date.now()
        this.state.set('open')
      },
      onmessage: (ev) => {
        this._dispatch(ev.event, ev.data)
      },
      onerror: (err) => {
        // Re-throw → disable the library's built-in auto-reconnect; the outer _run handles everything
        // (backoff / auth).
        throw err
      },
    })
  }

  /** Dispatch by the event field; wrap as a StandardMessage so the downstream contract matches the old WS
   *  shape (http-item-source is unchanged). */
  private _dispatch(event: string, rawData: string | undefined) {
    // Any frame (including the server's periodic ping) proves the stream is alive — refresh liveness
    // before anything else so the watchdog measures from the most recent frame.
    this._lastFrameAt = Date.now()
    const data = rawData ? JSON.parse(rawData) : undefined
    if (event === 'ping') {
      // Server heartbeat — liveness only, not a business event. Observing it also arms the watchdog
      // (see _pingObserved), which stays dormant against an older backend still sending comment pings.
      this._pingObserved = true
      return
    }
    if (event === 'FORCE_LOGOUT') {
      // Server-initiated kick (all-device logout / password change) → clear the token, re-login, do not reconnect.
      this.disconnect()
      this.authService.redoLoginAuth()
      return
    }
    this.eventSubject.next({ event, status: 0, message: 'new message', data })
  }

  /** Wait for a usable access token: return immediately if one is held, otherwise wait for acTkSub to emit
   *  a non-null value (after login / renew). Resolves null on disconnect. */
  private _waitForToken(): Promise<string | null> {
    const cur = this.authService.accessToken
    if (cur) return Promise.resolve(cur)
    return new Promise<string | null>((resolve) => {
      let resolved = false
      const done = (v: string | null) => {
        if (!resolved) { resolved = true; resolve(v) }
      }
      this._tokenSub = this.authService.acTkSub.pipe(
        filter((t): t is string => t !== null),
        take(1),
        // Either a token arrived (take completes) or disconnect unsubscribed us → both resolve.
        finalize(() => done(null)),
      ).subscribe((t) => done(t))
    })
  }

  /** Single-flight renew after a 401; resolves true on success (outer loop reopens) or false on failure
   *  (outer loop stops — redoLoginAuth already ran). */
  private _renewForReconnect(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let resolved = false
      this.authService.renewAccessToken().subscribe({
        next: (res) => { if (!resolved) { resolved = true; resolve(res.code === 0) } },
        error: () => { if (!resolved) { resolved = true; resolve(false) } },
      })
    })
  }

  /** Exponential backoff + full jitter: delay = random(0, min(1000·2^attempt, 30000)). Base 1s, capped at 30s. */
  private _backoff(): number {
    const ceil = Math.min(1000 * 2 ** this._attempt, 30000)
    return Math.random() * ceil
  }

  private _sleep(ms: number): Promise<void> {
    this._sleepResolver = undefined
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      // Stored so an `online` event can resolve the current backoff sleep early and retry at once.
      this._sleepResolver = () => { clearTimeout(timer); resolve() }
    })
  }

  /** Start the liveness watchdog. If no frame has arrived within STALE_MS while a stream is `open`, the
   *  connection has silently stalled (half-open TCP / network drop with no RST) — abort it so `_run`'s
   *  error path flips state to `reconnecting` and the connection-lost banner appears. This is the ONLY
   *  way to detect a silently-dead SSE stream: `fetch-event-source`'s fetch neither errors nor closes on a
   *  stall, so without it the client believes it is connected forever. */
  private _startWatchdog(): void {
    this._stopWatchdog()
    this._watchdog = setInterval(() => {
      // Only enforce once we've seen the server's named ping — otherwise an old comment-ping backend
      // would make a quiet chat look stalled → spurious reconnects every STALE_MS.
      if (!this._pingObserved || this.state() !== 'open' || this._lastFrameAt === 0) return
      if (Date.now() - this._lastFrameAt > STALE_MS) {
        console.warn('[sse] liveness watchdog: no frame in %sms — aborting stalled stream', STALE_MS)
        this._abort?.abort()
      }
    }, WATCHDOG_CHECK_MS)
  }

  private _stopWatchdog(): void {
    if (this._watchdog) {
      clearInterval(this._watchdog)
      this._watchdog = undefined
    }
  }

  /** Listen to the browser's online/offline events. These fire instantly on DevTools network throttling /
   *  OS network changes — the heartbeat watchdog can't match that latency (a stall takes STALE_MS to
   *  detect), so this is the fast path for the common "user went offline" case; the watchdog remains as
   *  the backstop for silent half-open stalls where navigator.onLine is still true. */
  private _startBrowserListeners(): void {
    if (typeof window === 'undefined') return // SSR / non-browser guard
    window.addEventListener('offline', this._onBrowserOffline)
    window.addEventListener('online', this._onBrowserOnline)
  }

  private _stopBrowserListeners(): void {
    if (typeof window === 'undefined') return
    window.removeEventListener('offline', this._onBrowserOffline)
    window.removeEventListener('online', this._onBrowserOnline)
  }

  /** Network dropped (DevTools offline / Wi-Fi off / sleep) → flip to `reconnecting` immediately and abort
   *  the stream. The abort routes through `_run`'s error path, which keeps retrying (and backing off) while
   *  offline; each failed attempt re-asserts `reconnecting` so the banner stays up. Setting state here,
   *  before the async abort propagates, is what makes the banner appear the instant the drop is detected. */
  private _handleBrowserOffline(): void {
    if (this._manualClose) return
    this.state.set('reconnecting')
    this._abort?.abort()
  }

  /** Network returned → reset backoff to zero and wake the current sleep so `_run` retries at once instead
   *  of waiting out the (possibly long) backoff. If the loop isn't sleeping, this is a no-op and the
   *  in-flight attempt resolves the state normally. */
  private _handleBrowserOnline(): void {
    if (this._manualClose) return
    this._attempt = 0
    this._sleepResolver?.()
  }
}
