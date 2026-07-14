import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { initSseResponse, formatSseFrame } from './sse-stream.js';

/**
 * Regression guard for the CORS-on-hijacked-SSE fix.
 *
 * Every SSE endpoint (GET /events, /notifications/stream, /admin/logs/stream) calls reply.hijack() and
 * hands reply.raw to initSseResponse(). Hijacking detaches the response from Fastify's lifecycle, so
 * @fastify/cors (origin:true in bootstrap.ts) never stamps Access-Control-Allow-Origin on it. A
 * cross-origin client (Tauri desktop/Android, admin-web) then cannot read the stream — its fetch()
 * rejects and the consumer SSE worker spins in "reconnecting" forever. The fix: initSseResponse writes
 * the reflected origin on the raw response when the caller passes one. These tests pin that the header
 * is present when an Origin is supplied and ABSENT otherwise (same-origin requests carry no Origin, and
 * emitting a stray ACAO there would be wrong). Pure unit test on the wire-format writer — no Nest DI,
 * no HTTP server.
 */
describe('initSseResponse — CORS on the hijacked raw stream', () => {
  /** Minimal ServerResponse double: capture writeHead's headers + every write. */
  function mockRes(): { res: ServerResponse; writeHead: ReturnType<typeof vi.fn>; writes: string[] } {
    const writes: string[] = [];
    const writeHead = vi.fn();
    const res = {
      writeHead,
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true; // never signals backpressure — keeps the heartbeat write alive
      }),
      end: vi.fn(),
      on: vi.fn(),
    } as unknown as ServerResponse;
    return { res, writeHead, writes };
  }

  it('writes the reflected Access-Control-Allow-Origin + Vary: Origin when an Origin is passed', () => {
    const { res, writeHead } = mockRes();
    const handle = initSseResponse(res, 'https://tauri.localhost');
    try {
      expect(writeHead).toHaveBeenCalledTimes(1);
      const [, headers] = writeHead.mock.calls[0] as [number, Record<string, string>];
      expect(headers['Access-Control-Allow-Origin']).toBe('https://tauri.localhost');
      expect(headers['Vary']).toBe('Origin');
      // The streaming essentials are still emitted alongside the CORS header.
      expect(headers['Content-Type']).toBe('text/event-stream');
    } finally {
      clearInterval(handle);
    }
  });

  it('emits NO Access-Control-Allow-Origin when no Origin is passed (same-origin)', () => {
    // A same-origin browser request carries no Origin header → origin is undefined → CORS does not
    // apply. Emitting a stray ACAO here would be incorrect, so it must be absent.
    const { res, writeHead } = mockRes();
    const handle = initSseResponse(res);
    try {
      const [, headers] = writeHead.mock.calls[0] as [number, Record<string, string>];
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(headers['Vary']).toBeUndefined();
    } finally {
      clearInterval(handle);
    }
  });

  it('flushes the `: connected` comment so the client onopen fires immediately', () => {
    const { res, writes } = mockRes();
    const handle = initSseResponse(res);
    try {
      expect(writes).toContain(': connected\n\n');
    } finally {
      clearInterval(handle);
    }
  });

  it('writes a NAMED ping heartbeat (not a `:` comment) so a reader can observe liveness', () => {
    vi.useFakeTimers();
    try {
      const { res, writes } = mockRes();
      const handle = initSseResponse(res);
      try {
        vi.advanceTimersByTime(25_000);
        // A comment frame is invisible to a fetch-event-source reader; the named ping is what arms the
        // consumer worker's liveness watchdog.
        expect(writes.some((w) => w.startsWith('event: ping\n'))).toBe(true);
      } finally {
        clearInterval(handle);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatSseFrame', () => {
  it('emits the event/id/data fields and the blank-line terminator', () => {
    expect(formatSseFrame('NEW_MESSAGE', { hello: 'world' }, 42)).toBe(
      'event: NEW_MESSAGE\nid: 42\ndata: {"hello":"world"}\n\n',
    );
  });

  it('omits the id line when no cursor is supplied', () => {
    expect(formatSseFrame('NOTIFY', { a: 1 })).toBe('event: NOTIFY\ndata: {"a":1}\n\n');
  });
});
