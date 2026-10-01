/// <reference lib="webworker" />
/**
 * SSE downlink worker (browser-only). Owns a native `fetch` + `ReadableStream` SSE connection, the
 * reconnect/backoff loop and the browser online/offline fast-path — everything
 * that used to live on the main thread inside `WebsocketService`. Moving it off the main thread means SSE
 * parsing and backoff timers no longer contend with the virtual-scroll kernel or the Tiptap
 * editor; the realtime layer is fully decoupled from rendering.
 *
 * Auth: the worker is browser-only (the facade selects `RustChannelSseTransport` under Tauri desktop +
 * `NativeEventTransport` under Android), so the stream is SAME-ORIGIN and authenticates via the httpOnly
 * session cookie — fetch's default `credentials: same-origin` attaches it. NO session token is held in the
 * worker. A 401 means the session is revoked/expired → the worker posts `force-logout` (main re-logs in)
 * and stops; it does NOT retry (that would just 401-loop).
 *
 * The stream is read with a bare `fetch` + `getReader()` loop, NOT `@microsoft/fetch-event-source`.
 * That library is main-thread-only — it resolves `window.fetch` / `window.setTimeout` and calls
 * `document.removeEventListener('visibilitychange', …)` inside its `dispose()`, all undefined on a
 * `DedicatedWorkerGlobalScope`, so it throws `ReferenceError: window is not defined` the instant it
 * runs here (every `openOnce` blew up → the `run` loop flipped to `reconnecting` forever → a permanent
 * "Connection lost" banner even though the server was healthy). A worker already has `fetch`,
 * `TextDecoder`, and `ReadableStream`, so we parse the SSE byte stream ourselves (see `readFrames` /
 * `parseFrame`). There is no auto-reconnect inside the reader — a read error or clean close simply
 * returns and the outer `run` loop owns every reconnect so backoff stays coherent, exactly as on the
 * main thread before.
 *
 * `sw` is the typed worker global — cast through `unknown` because the app's tsconfig includes both
 * the `dom` and (via the reference above) `webworker` libs, which would otherwise make the bare
 * global `self` / `addEventListener` ambiguous.
 */
import { SseReceiptCoalescer } from './sse-receipt-coalescer';
import {
  SSE_EVENT_FORCE_LOGOUT,
  type ToMain,
  type ToWorker,
} from './sse-worker-protocol';

const sw = self as unknown as DedicatedWorkerGlobalScope;

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
let receipts: SseReceiptCoalescer | undefined;
/** Resolver for the current `sleep`, so an `online` event can wake the backoff loop to retry at once. */
let sleepResolver: (() => void) | undefined;
let threadFeedPort: MessagePort | undefined;
let threadFeedUserId: number | undefined;
let helloUserId: number | undefined;
let threadFeedTarget = 0;
let stateFeedTarget = 0;

/** Post a message to the main thread. */
function post(msg: ToMain): void {
  sw.postMessage(msg);
}

// --- reconnect loop -----------------------------------------------------------

async function run(): Promise<void> {
  while (!manualClose) {
    try {
      await openOnce();
      if (manualClose) break;
      // Stream closed cleanly (e.g. a server restart) → back off and reconnect.
      await reconnectAfter();
    } catch (err) {
      if (manualClose) break;
      if (err instanceof AuthNeededError) {
        // 401: the session cookie is revoked/expired. There is no renew — tell main to re-login
        // (force-logout → redoLoginAuth) and stop, so we don't 401-loop. (A server-pushed FORCE_LOGOUT
        // frame takes the same path in `dispatch`.)
        manualClose = true;
        post({ type: 'force-logout' });
        break;
      }
      // Network / other error: back off and retry.
      await reconnectAfter();
    }
  }
  running = false;
  post({ type: 'state', state: 'closed' });
}

/** Flip to `reconnecting`, advance the backoff step, announce the scheduled delay (so main can render a
 *  live countdown), then sleep for it. An `online` event or `retry-now` resolves the sleep early (see
 *  `sleep`/`sleepResolver`); the loop then reopens at once and, on the next failure, calls this again —
 *  re-announcing a fresh deadline. No explicit clear: the next state transition (open/closed) lets main
 *  drop the countdown. */
async function reconnectAfter(): Promise<void> {
  post({ type: 'state', state: 'reconnecting' });
  attempt++;
  const ms = backoff();
  post({ type: 'reconnect-in', ms });
  await sleep(ms);
}

/** Open one SSE stream. Same-origin cookie auth: no token — fetch's default `credentials: same-origin`
 *  attaches the httpOnly session cookie. A 401 throws AuthNeededError. */
async function openOnce(): Promise<void> {
  aborter = new AbortController();
  const res = await fetch(url, {
    signal: aborter.signal,
    headers: { Accept: 'text/event-stream' },
    // Defeat any intermediate caching of the event stream (correctness, not performance). Default
    // `credentials: same-origin` attaches the httpOnly session cookie (the browser path authenticates
    // entirely via the cookie — no token is held in the worker).
    cache: 'no-store',
  });
  if (res.status === 401) {
    throw new AuthNeededError(); // session dead — the run loop posts force-logout + stops
  }
  if (!res.ok || !res.body) {
    throw new Error(`SSE open failed: ${res.status}`);
  }

  // Headers received → the stream is open. Mirror the old onopen side-effects: reset backoff, emit the
  // reconnect backfill pulse on every open after the first and tell main we're up. No
  // `openWhenHidden` is needed — a worker has no visibility concept and is not throttled on tab hide,
  // so the native reader is inherently always-open-when-hidden.
  attempt = 0;
  if (openedOnce) post({ type: 'reconnect' });
  openedOnce = true;
  post({ type: 'state', state: 'open' });

  // Blocks until the server ends the stream or `aborter` fires (offline / stop). A read or
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

/** Dispatch by the event field: FORCE_LOGOUT ends the session; other frames go to main. */
function dispatch(event: string, rawData: string | undefined): void {
  const data = rawData ? JSON.parse(rawData) : undefined;
  if (
    event === 'THREAD_FEED_UPDATED' &&
    typeof data?.sseUuid === 'string' &&
    Number.isInteger(data.threadFeedEndId)
  ) {
    receipts?.queue({
      sseUuid: data.sseUuid,
      threadFeedEndId: data.threadFeedEndId,
    });
  }
  if (event === SSE_EVENT_FORCE_LOGOUT) {
    // Server-initiated kick (all-device logout / password change). Tell main to clear state + re-login,
    // then stop our own loop so we don't reconnect against the invalidated session.
    manualClose = true;
    aborter?.abort();
    post({ type: 'force-logout' });
    return;
  }
  if (event === 'SSE_REPLACED') {
    manualClose = true;
    receipts?.stop();
    aborter?.abort();
    post({ type: 'replaced' });
    return;
  }
  if (
    (event === 'PROFILE_AVAILABLE' || event === 'PROFILE_UNAVAILABLE') &&
    threadFeedPort &&
    threadFeedUserId === helloUserId
  ) {
    threadFeedPort.postMessage({ event, data });
    return;
  }
  if (event === 'HELLO') {
    const userId = (data as { userId?: number } | undefined)?.userId;
    if (helloUserId !== userId) {
      stateFeedTarget = 0;
      threadFeedTarget = 0;
    }
    helloUserId = userId;
  }
  if (event === 'HELLO' || event === 'STATE_FEED_UPDATED') {
    const target = event === 'HELLO' ? data?.stateFeedEndId : data?.feedId;
    if (Number.isSafeInteger(target) && target >= 0) {
      stateFeedTarget = Math.max(stateFeedTarget, target);
      if (threadFeedPort && threadFeedUserId === helloUserId) {
        threadFeedPort.postMessage({ stateTarget: stateFeedTarget });
        if (event === 'STATE_FEED_UPDATED') return;
      }
    }
  }
  if (event === 'HELLO' || event === 'THREAD_FEED_UPDATED') {
    const head = data as
      | { userId?: number; threadFeedEndId?: number }
      | undefined;
    if (
      Number.isInteger(head?.threadFeedEndId) &&
      Number(head?.threadFeedEndId) >= 0 &&
      Number(head?.threadFeedEndId) <= 2147483647
    ) {
      threadFeedTarget = Math.max(
        threadFeedTarget,
        Number(head!.threadFeedEndId),
      );
      if (threadFeedPort && threadFeedUserId === helloUserId) {
        threadFeedPort.postMessage({ target: threadFeedTarget });
        if (event === 'THREAD_FEED_UPDATED') return;
      }
    }
  }
  post({
    type: 'event',
    payload: { event, status: 0, message: 'new message', data },
  });
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

// --- browser online/offline (fast path) --------------------------------------

// DedicatedWorkerGlobalScope may receive `online`/`offline` directly, but browsers and WebViews do not
// guarantee that behavior. WorkerSseTransport therefore forwards the main-thread events through the
// protocol as a fallback. Both paths below are idempotent and share the same reconnect behavior.
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
    case 'thread-feed-port': {
      threadFeedPort?.close();
      const port = m.port;
      threadFeedPort = port;
      threadFeedUserId = m.userId;
      // The port is now unidirectional: SSE → DB worker wakes only. The DB
      // worker reports drain completions directly to the main thread via
      // postMessage (thread-feed-committed / state-feed-committed), no longer
      // echoing back through this port.
      if (!manualClose && threadFeedUserId === helloUserId) {
        port.postMessage({ stateTarget: stateFeedTarget });
        port.postMessage({ target: threadFeedTarget });
      }
      break;
    }
    case 'start':
      if (running) return;
      url = m.url;
      receipts = new SseReceiptCoalescer(async (receipt, signal) => {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        const timer = setTimeout(() => controller.abort(), 2_000);
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          const response = await fetch(`${url}/receipt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(receipt),
            signal: controller.signal,
            credentials: 'same-origin',
          });
          if (!response.ok) throw new Error('SSE receipt unavailable');
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        }
      });
      running = true;
      manualClose = false;
      attempt = 0;
      post({ type: 'state', state: 'connecting' });
      void run();
      break;
    case 'stop':
      threadFeedPort?.close();
      threadFeedPort = undefined;
      threadFeedUserId = undefined;
      helloUserId = undefined;
      threadFeedTarget = 0;
      stateFeedTarget = 0;
      manualClose = true;
      running = false;
      aborter?.abort();
      receipts?.stop();
      receipts = undefined;
      post({ type: 'state', state: 'closed' });
      break;
    case 'retry-now':
      // User-initiated retry: reset the backoff attempt counter (so a fresh failure starts from 1s, not
      // wherever the loop had climbed to) and resolve the current backoff sleep so the loop reconnects
      // at once. Mirrors the browser `online` fast-path. No-op when not in backoff (sleepResolver
      // undefined) — e.g. already open — which is the correct harmless behavior.
      if (manualClose) return;
      attempt = 0;
      sleepResolver?.();
      break;
    case 'network-offline':
      if (manualClose) return;
      post({ type: 'state', state: 'reconnecting' });
      aborter?.abort();
      break;
    case 'network-online':
      if (manualClose) return;
      attempt = 0;
      sleepResolver?.();
      break;
  }
});
