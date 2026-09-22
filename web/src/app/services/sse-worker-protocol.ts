/**
 * Message protocol between {@link WebsocketService} (main thread) and `sse.worker.ts` (the dedicated
 * Web Worker that owns the SSE downlink). Pure type module — no Angular/DOM imports — so both sides
 * can import it without dragging framework or browser globals into the worker bundle.
 *
 * Lifecycle:
 *  - main posts `start` once the worker is spawned (the worker idles until then).
 *  - the worker streams `state` changes, `event` frames, and the `reconnect` backfill pulse up; main
 *    re-emits these onto the existing `state` signal / `eventSubject` / `reconnect$` unchanged.
 *  - the stream is same-origin + cookie-auth (the worker is browser-only), so there is NO token handshake:
 *    fetch's default `credentials: same-origin` attaches the httpOnly session cookie. A 401 means the
 *    session is revoked/expired → the worker posts `force-logout` (re-login), not a token renewal.
 */

type WorkerState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Shape posted up for each business event; structurally identical to the main-thread
 *  `StandardMessage` (kept loose here so the protocol module stays Angular-agnostic — the bridge
 *  casts onto the typed `Subject`). */
interface SseEventPayload {
  event: string;
  status: number;
  message: string;
  data?: unknown;
}

/** Main → Worker. */
export type ToWorker =
  | { type: 'start'; url: string }
  | { type: 'thread-feed-port'; port: MessagePort; userId: number }
  | { type: 'stop' }
  | { type: 'retry-now' } // user tapped the disconnected chip: skip the current backoff sleep and retry at once
  | { type: 'network-offline' }
  | { type: 'network-online' };

/** Worker → Main. */
export type ToMain =
  | { type: 'state'; state: WorkerState }
  | { type: 'event'; payload: SseEventPayload }
  | { type: 'reconnect' }
  | { type: 'force-logout' }
  | { type: 'reconnect-in'; ms: number }; // backoff sleep scheduled — the live countdown is owned by main

/** Server-side named SSE events the worker must special-case (mirrors `src/gateway/sse.service.ts`).
 *  Inlined here so the worker does not import `constants.ts` (which is main-thread-oriented). */
export const SSE_EVENT_PING = 'ping';
export const SSE_EVENT_FORCE_LOGOUT = 'FORCE_LOGOUT';
