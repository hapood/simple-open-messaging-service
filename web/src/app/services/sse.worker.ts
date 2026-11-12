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
 * The shared, framework-independent SSE reader owns decoding, opening and receive-idle deadlines,
 * and attempt-scoped cancellation. This worker owns authentication, domain events and reconnects.
 *
 * `sw` is the typed worker global — cast through `unknown` because the app's tsconfig includes both
 * the `dom` and (via the reference above) `webworker` libs, which would otherwise make the bare
 * global `self` / `addEventListener` ambiguous.
 */
import { consumeSse } from '../../../../shared/sse-client';
import { SseReceiptCoalescer } from './sse-receipt-coalescer';
import {
  SSE_EVENT_FORCE_LOGOUT,
  type ToMain,
  type ToWorker,
} from './sse-worker-protocol';

const sw = self as unknown as DedicatedWorkerGlobalScope;

/** A revoked session stops reconnects and asks the main thread to log out. */
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
  await consumeSse(url, {
    signal: aborter.signal,
    onResponse: (response) => {
      if (response.status === 401) throw new AuthNeededError();
    },
    onOpen: () => {
      attempt = 0;
      if (openedOnce) post({ type: 'reconnect' });
      openedOnce = true;
      post({ type: 'state', state: 'open' });
    },
    onFrame: ({ event, data }) => dispatch(event, data),
  });
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
