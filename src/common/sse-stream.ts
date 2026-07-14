import type { ServerResponse } from 'node:http';

/**
 * Shared SSE (Server-Sent Events) connect-plumbing — the single source of truth for the wire format
 * the consumer `sse.worker.ts` parses. Used by both the chat push service (SseService) and the admin
 * log viewer (LogViewerService) so the two producers can never drift on headers, the heartbeat, or the
 * frame shape.
 *
 * Frame format: `event: <name>\n[id: <cursor>]\ndata: <JSON>\n\n`. The heartbeat is a NAMED `ping`
 * event (not a `:` comment) so a client's dispatcher observes it and can run a liveness watchdog — a
 * comment frame is invisible to a fetch-event-source reader, so a silently half-open connection would
 * otherwise go undetected.
 */

/** Heartbeat interval (< Nginx's default 60s proxy_read_timeout). Bound for half-open detection. */
export const SSE_HEARTBEAT_MS = 25000;

/**
 * Initialize one SSE response: write the streaming headers (h2-aware — HTTP/2 forbids the Connection
 * header), flush a `: connected` comment so the client's onopen fires immediately, and start the 25s
 * named-ping heartbeat. Returns the heartbeat handle for the caller to clearInterval on res close.
 *
 * `res` is the reply.raw handed over after Fastify reply.hijack(): ServerResponse under h1.1,
 * Http2ServerResponse under HTTP/2 (both share writeHead/write/end/on('close')). h2 is detected by the
 * presence of res.stream (Http2ServerResponse only). A failed heartbeat write (broken socket) → end
 * now; the caller's res.on('close') finishes the registry/subscriber cleanup.
 *
 * `origin` is the inbound request's `Origin` header. Because reply.hijack() takes over the raw
 * response, this stream never re-enters Fastify's lifecycle — @fastify/cors (origin:true, see
 * bootstrap.ts) never gets to stamp `Access-Control-Allow-Origin` on it the way it does for ordinary
 * responses. Without that header a CROSS-ORIGIN client (Tauri desktop/Android, admin-web on :5180)
 * cannot read the stream: the browser blocks the headerless response, the consumer's `fetch()` rejects,
 * and the SSE reconnect loop spins forever ("stuck reconnecting"). Same-origin browser requests carry
 * no Origin header → `origin` is undefined → nothing is emitted (CORS does not apply). Reflecting the
 * exact Origin (never a wildcard, never `Access-Control-Allow-Credentials`) mirrors the global
 * `origin:true` posture: Bearer-header auth, no credentialed cross-origin surface.
 */
export function initSseResponse(res: ServerResponse, origin?: string): NodeJS.Timeout {
  const isH2 = (res as unknown as { stream?: unknown }).stream !== undefined;
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  };
  if (!isH2) headers['Connection'] = 'keep-alive';
  // Hijack bypasses @fastify/cors, so the reflected origin must be written here on the raw response.
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(200, headers);
  res.write(': connected\n\n');

  return setInterval(() => {
    try {
      if (!res.write('event: ping\ndata: {}\n\n')) res.end();
    } catch {
      /* socket already gone; res.on('close') owns teardown */
    }
  }, SSE_HEARTBEAT_MS);
}

/** Format one SSE frame. `id` is the optional Last-Event-ID resume cursor (message events only). */
export function formatSseFrame(
  event: string,
  data: unknown,
  id?: string | number,
): string {
  return (
    `event: ${event}\n` +
    (id !== undefined && id !== null ? `id: ${id}\n` : '') +
    `data: ${JSON.stringify(data)}\n\n`
  );
}
