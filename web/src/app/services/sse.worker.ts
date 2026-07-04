/// <reference lib="webworker" />
/**
 * SSE downlink worker. Owns a native `fetch` + `ReadableStream` SSE connection, the reconnect/backoff
 * loop, the liveness watchdog, and the browser online/offline fast-path — everything that used to
 * live on the main thread inside `WebsocketService`. Moving it off the main thread means SSE parsing,
 * backoff timers, and the watchdog no longer contend with the virtual-scroll kernel or the Tiptap
 * editor; the realtime layer is fully decoupled from rendering.
 *
 * Auth handshake (the one genuinely tricky part — a naive port reconnects with a stale token in a
 * tight 401 loop): the worker never touches `AuthService` (it can't — it's a worker, no Angular DI,
 * no `localStorage`). Instead it asks the main thread:
 *  - `need-token`  — "give me the current access token" (cheap; used for the first open).
 *  - `renew-token` — "that token 401'd; renew and give me a fresh one" (expensive; main calls
 *    `AuthService.renewAccessToken()`).
 * Both are correlated by `reqId`. The worker caches the most recent token (`currentToken`) and
 * reuses it across reconnects; it only asks again after a 401 clears the cache. A stale `{token, reqId}`
 * reply (from a prior request) is dropped because its `reqId` won't match `tokenReqId`.
 *
 * The stream is read with a bare `fetch` + `getReader()` loop, NOT `@microsoft/fetch-event-source`.
 * That library is main-thread-only — it resolves `window.fetch` / `window.setTimeout` and calls
 * `document.removeEventListener('visibilitychange', …)` inside its `dispose()`, all undefined on a
 * `DedicatedWorkerGlobalScope`, so it throws `ReferenceError: window is not defined` the instant it
 * runs here (every `openOnce` blew up → the `run` loop flipped to `reconnecting` forever → a permanent
 * "Connection lost" banner even though the server was healthy). A worker already has `fetch`,
 * `TextDecoder`, and `ReadableStream`, so we parse the SSE byte stream ourselves (see `readFrames` /
 * `parseFrame`). There is no auto-reconnect inside the reader — a read error or clean close simply
 * returns and the outer `run` loop owns every reconnect so backoff + auth stay coherent, exactly as on
 * the main thread before.
 *
 * `sw` is the typed worker global — cast through `unknown` because the app's tsconfig includes both
 * the `dom` and (via the reference above) `webworker` libs, which would otherwise make the bare
 * global `self` / `addEventListener` ambiguous.
 */
import {
  SSE_EVENT_FORCE_LOGOUT,
  SSE_EVENT_PING,
  type ToMain,
  type ToWorker,
} from './sse-worker-protocol';

const sw = self as unknown as DedicatedWorkerGlobalScope;

/** No frame within STALE_MS while `open` → the stream has silently stalled (half-open TCP / a network
 *  drop with no RST). A native fetch stream neither errors nor closes on a stall, so without this the
 *  worker would believe it is connected forever. ~2× the 25s server heartbeat + jitter margin. */
const STALE_MS = 60_000;
const WATCHDOG_CHECK_MS = 5_000;

/** Thrown when onopen sees a 401 → the loop renews the token and reopens immediately (no backoff). */
class AuthNeededError extends Error {
  constructor() {
    super('auth-needed');
    this.name = 'AuthNeededError';
  }
}

// --- connection state ---------------------------------------------------------

/** The SSE endpoint URL, supplied by main in the `start` message (kept out of the worker so it does
 *  not import the main-thread `constants.ts`). */
let url = '';
/** True while inside the run reconnect loop. Makes `start` idempotent. */
let running = false;
/** Set by `stop` so the loop exits without reconnecting. */
let manualClose = false;
/** Backoff step (increments on failure, resets to 0 once a stream opens). */
let attempt = 0;
/** Whether a stream has ever opened — only a non-first open emits the `reconnect` backfill pulse. */
let openedOnce = false;
let aborter: AbortController | undefined;
/** Timestamp (ms) of the last received SSE frame (event or ping). Refreshed on every dispatch. */
let lastFrameAt = 0;
/** True once a server `ping` event has been observed — the watchdog only arms after this, so an old
 *  backend still emitting comment pings (invisible to the reader) never false-triggers in a quiet chat. */
let pingObserved = false;
/** The most recently obtained access token; reused across reconnects, cleared on a 401. */
let currentToken: string | undefined;
let watchdog: ReturnType<typeof setInterval> | undefined;
/** Resolver for the current `sleep`, so an `online` event can wake the backoff loop to retry at once. */
let sleepResolver: (() => void) | undefined;

// --- token request handshake (single outstanding request, correlated by reqId) ---------

let tokenSeq = 0;
let tokenReqId: string | undefined;
let tokenResolve: ((token: string | null) => void) | undefined;

/** Post a message to the main thread. */
function post(msg: ToMain): void {
  sw.postMessage(msg);
}

/** Ask the main thread for a token (`need-token` = current, `renew-token` = fresh) and await the
 *  matching `{token, reqId}` / `{token-failed, reqId}` reply. Resolves null on failure / stop. */
function requestToken(kind: 'need-token' | 'renew-token'): Promise<string | null> {
  // The `run` loop is serial, so at most one token request is ever outstanding — no need to queue.
  const reqId = String(++tokenSeq);
  return new Promise<string | null>((resolve) => {
    tokenReqId = reqId;
    tokenResolve = resolve;
    post({ type: kind, reqId });
  });
}

// --- reconnect loop -----------------------------------------------------------

async function run(): Promise<void> {
  while (!manualClose) {
    try {
      await openOnce();
      if (manualClose) break;
      // Stream closed cleanly (e.g. a server restart) → back off and reconnect.
      post({ type: 'state', state: 'reconnecting' });
      attempt++;
      await sleep(backoff());
    } catch (err) {
      if (manualClose) break;
      if (err instanceof AuthNeededError) {
        // 401: renew for a fresh token; on success reopen immediately (reset backoff), on failure stop
        // (redoLoginAuth already ran on main, which replied `token-failed`).
        post({ type: 'state', state: 'reconnecting' });
        const fresh = await requestToken('renew-token');
        if (!fresh || manualClose) break;
        currentToken = fresh;
        attempt = 0;
        continue;
      }
      // Network / other error: back off and retry.
      post({ type: 'state', state: 'reconnecting' });
      attempt++;
      await sleep(backoff());
    }
  }
  running = false;
  post({ type: 'state', state: 'closed' });
}

/** Open one SSE stream. Obtains a token (cached, or via `need-token` on the very first open), opens
 *  the stream, and blocks until it closes. A 401 clears the cached token and throws AuthNeededError. */
async function openOnce(): Promise<void> {
  let token = currentToken;
  if (!token) {
    token = await requestToken('need-token');
    if (!token || manualClose) return;
    currentToken = token;
  }

  aborter = new AbortController();
  const res = await fetch(url, {
    signal: aborter.signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    // Defeat any intermediate caching of the event stream (correctness, not performance).
    cache: 'no-store',
  });
  if (res.status === 401) {
    currentToken = undefined; // force a renew on the next loop iteration
    throw new AuthNeededError();
  }
  if (!res.ok || !res.body) {
    throw new Error(`SSE open failed: ${res.status}`);
  }

  // Headers received → the stream is open. Mirror the old onopen side-effects: reset backoff, emit the
  // reconnect backfill pulse on every open after the first, arm liveness, tell main we're up. No
  // `openWhenHidden` is needed — a worker has no visibility concept and is not throttled on tab hide,
  // so the native reader is inherently always-open-when-hidden.
  attempt = 0;
  if (openedOnce) post({ type: 'reconnect' });
  openedOnce = true;
  lastFrameAt = Date.now();
  post({ type: 'state', state: 'open' });

  // Blocks until the server ends the stream or `aborter` fires (watchdog / offline / stop). A read or
  // abort error propagates to `run`, which backs off and reconnects.
  await readFrames(res.body);
}

/** Consume the SSE byte stream, dispatching one frame per blank-line-terminated chunk. A network chunk
 *  can split a frame (or carry several), so we buffer and cut on the `\n\n` separator; `\r\n` is
 *  normalized to `\n` for spec robustness (the server emits bare `\n`). Resolves on a clean stream end
 *  and rejects on a read/abort error. */
async function readFrames(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = parseFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (frame) dispatch(frame.event, frame.data);
    }
  }
  // Flush the decoder's trailing surrogate; any un-terminated frame left in the buffer is incomplete
  // (the server closed mid-frame) and is dropped.
  decoder.decode();
}

/** Parse one SSE frame (the text between blank lines) into `{ event, data }`. Implements the relevant
 *  slice of the SSE wire spec: a line starting with `:` is a comment (ignored), a single leading space
 *  after the field colon is stripped, and multiple `data:` lines join with `\n`. `id` / `retry` are
 *  unused (the app drives its own backoff and resumption cursor) so they're dropped. The server names
 *  every real frame (`event: …`); a frame with no event field (the leading `: connected` comment)
 *  yields `event: ''` and is skipped, so it never reaches `dispatch`. */
function parseFrame(raw: string): { event: string; data?: string } | undefined {
  let event = '';
  let data = '';
  let hasData = false;
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data = hasData ? `${data}\n${value}` : value;
      hasData = true;
    }
  }
  if (!event) return undefined;
  return { event, data: hasData ? data : undefined };
}

/** Dispatch by the event field. Refreshes liveness, then either absorbs the heartbeat, kicks the user
 *  out on FORCE_LOGOUT, or forwards the frame to main. */
function dispatch(event: string, rawData: string | undefined): void {
  // Any frame (including the periodic ping) proves the stream is alive — refresh before dispatch.
  lastFrameAt = Date.now();
  const data = rawData ? JSON.parse(rawData) : undefined;
  if (event === SSE_EVENT_PING) {
    pingObserved = true;
    return;
  }
  if (event === SSE_EVENT_FORCE_LOGOUT) {
    // Server-initiated kick (all-device logout / password change). Tell main to clear state + re-login,
    // then stop our own loop so we don't reconnect against the invalidated session.
    manualClose = true;
    aborter?.abort();
    post({ type: 'force-logout' });
    return;
  }
  post({ type: 'event', payload: { event, status: 0, message: 'new message', data } });
}

/** Exponential backoff + full jitter: delay = random(0, min(1000·2^attempt, 30000)). Base 1s, cap 30s. */
function backoff(): number {
  const ceil = Math.min(1000 * 2 ** attempt, 30000);
  return Math.random() * ceil;
}

function sleep(ms: number): Promise<void> {
  sleepResolver = undefined;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Stored so an `online` event can resolve the current backoff sleep early and retry at once.
    sleepResolver = (): void => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// --- liveness watchdog --------------------------------------------------------

function startWatchdog(): void {
  stopWatchdog();
  watchdog = setInterval(() => {
    // Only enforce once we've seen the server's named ping — otherwise an old comment-ping backend
    // would make a quiet chat look stalled → spurious reconnects every STALE_MS.
    if (!pingObserved) return;
    if (lastFrameAt === 0) return;
    if (Date.now() - lastFrameAt > STALE_MS) {
      console.warn('[sse] liveness watchdog: no frame in %sms — aborting stalled stream', STALE_MS);
      aborter?.abort();
    }
  }, WATCHDOG_CHECK_MS);
}

function stopWatchdog(): void {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = undefined;
  }
}

// --- browser online/offline (fast path) --------------------------------------

// DedicatedWorkerGlobalScope inherits `online`/`offline` from WorkerGlobalScope, so the worker detects
// network changes directly — no need to relay from the main thread. These fire instantly on OS network
// changes, far faster than the heartbeat watchdog (which is the backstop for silent half-open stalls
// where navigator.onLine is still true).
sw.addEventListener('offline', () => {
  if (manualClose) return;
  post({ type: 'state', state: 'reconnecting' });
  aborter?.abort();
});
sw.addEventListener('online', () => {
  if (manualClose) return;
  attempt = 0;
  sleepResolver?.();
});

// --- main-thread messages -----------------------------------------------------

sw.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as ToWorker;
  switch (m.type) {
    case 'start':
      if (running) return;
      url = m.url;
      running = true;
      manualClose = false;
      attempt = 0;
      post({ type: 'state', state: 'connecting' });
      startWatchdog();
      void run();
      break;
    case 'stop':
      manualClose = true;
      running = false;
      aborter?.abort();
      stopWatchdog();
      // Resolve any in-flight token wait so its Promise doesn't leak; the reply is dropped by main
      // anyway after terminate().
      if (tokenResolve) {
        tokenResolve(null);
        tokenResolve = undefined;
        tokenReqId = undefined;
      }
      post({ type: 'state', state: 'closed' });
      break;
    case 'retry-now':
      // User-initiated retry: reset the backoff attempt counter (so a fresh failure starts from 1s, not
      // wherever the loop had climbed to) and resolve the current backoff sleep so the loop reconnects
      // at once. Mirrors the browser `online` fast-path. No-op when not in backoff (sleepResolver
      // undefined) — e.g. mid-handshake or already open — which is the correct harmless behavior.
      if (manualClose) return;
      attempt = 0;
      sleepResolver?.();
      break;
    case 'token':
      // Only honor the reply whose reqId matches the outstanding request; a stale reply from a prior
      // request is dropped (it would otherwise satisfy a newer wait with an older token).
      if (m.reqId === tokenReqId && tokenResolve) {
        const r = tokenResolve;
        tokenResolve = undefined;
        tokenReqId = undefined;
        r(m.token);
      }
      break;
    case 'token-failed':
      if (m.reqId === tokenReqId && tokenResolve) {
        const r = tokenResolve;
        tokenResolve = undefined;
        tokenReqId = undefined;
        r(null);
      }
      break;
  }
});
