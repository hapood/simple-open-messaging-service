/**
 * Message protocol between {@link WebsocketService} (main thread) and `sse.worker.ts` (the dedicated
 * Web Worker that owns the SSE downlink). Pure type module — no Angular/DOM imports — so both sides
 * can import it without dragging framework or browser globals into the worker bundle.
 *
 * Lifecycle:
 *  - main posts `start` once the worker is spawned (the worker idles until then).
 *  - the worker asks for the long-lived session token via `need-token` (once; reused across reconnects).
 *    Correlated by `reqId` so a stale reply from a prior request can never satisfy the current one (see
 *    the handshake notes in `sse.worker.ts`). There is no `renew-token` — a 401 means the session token is
 *    revoked/expired, handled by `force-logout` (re-login), not a renew.
 *  - the worker streams `state` changes, `event` frames, and the `reconnect` backfill pulse up; main
 *    re-emits these onto the existing `state` signal / `eventSubject` / `reconnect$` unchanged.
 */

export type WorkerState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Shape posted up for each business event; structurally identical to the main-thread
 *  `StandardMessage` (kept loose here so the protocol module stays Angular-agnostic — the bridge
 *  casts onto the typed `Subject`). */
export interface SseEventPayload {
  event: string;
  status: number;
  message: string;
  data?: unknown;
}

/** Main → Worker. */
export type ToWorker =
  | { type: 'start'; url: string }
  | { type: 'stop' }
  | { type: 'retry-now' } // user tapped the disconnected chip: skip the current backoff sleep and retry at once
  | { type: 'token'; reqId: string; token: string }
  | { type: 'token-failed'; reqId: string };

/** Worker → Main. */
export type ToMain =
  | { type: 'state'; state: WorkerState }
  | { type: 'event'; payload: SseEventPayload }
  | { type: 'reconnect' }
  | { type: 'need-token'; reqId: string }
  | { type: 'force-logout' }
  | { type: 'reconnect-in'; ms: number }; // backoff sleep scheduled — the live countdown is owned by main

/** Server-side named SSE events the worker must special-case (mirrors `src/gateway/sse.service.ts`).
 *  Inlined here so the worker does not import `constants.ts` (which is main-thread-oriented). */
export const SSE_EVENT_PING = 'ping';
export const SSE_EVENT_FORCE_LOGOUT = 'FORCE_LOGOUT';
