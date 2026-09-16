import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { initSseResponse, formatSseFrame } from './sse-stream.js';
import { serializeBody } from './serialize.interceptor.js';

/** Extract the JSON payload from one frame — the text between the `data: ` marker and the terminating `\n\n`. */
function payloadOf(frame: string): unknown {
  const marker = 'data: ';
  const start = frame.indexOf(marker) + marker.length;
  const end = frame.length - 2; // strip the terminating \n\n
  return JSON.parse(frame.slice(start, end));
}

/**
 * Regression guard for the CORS-on-hijacked-SSE fix.
 *
 * Every SSE endpoint (GET /events, /admin/logs/stream) calls reply.hijack() and
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
  function mockRes(): {
    res: ServerResponse;
    writeHead: ReturnType<typeof vi.fn>;
    writes: string[];
  } {
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
      const [, headers] = writeHead.mock.calls[0] as [
        number,
        Record<string, string>,
      ];
      expect(headers['Access-Control-Allow-Origin']).toBe(
        'https://tauri.localhost',
      );
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
      const [, headers] = writeHead.mock.calls[0] as [
        number,
        Record<string, string>,
      ];
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
  // No `id:` (Last-Event-ID) line is ever emitted — replay is unused (the missed-summary pull + HELLO
  // handshake reconcile gaps), so formatSseFrame carries no resume cursor.
  it('emits the event/data fields and the blank-line terminator (no id line)', () => {
    expect(formatSseFrame('EXAMPLE_EVENT', { hello: 'world' })).toBe(
      'event: EXAMPLE_EVENT\ndata: {"hello":"world"}\n\n',
    );
  });

  it('Date → epoch-ms number on the wire (NOT an ISO string)', () => {
    // The whole point of routing frames through serializeBody: a Date must leave as a number so the SSE
    // bus matches the HTTP SerializeInterceptor's contract. Without it, Date.prototype.toJSON would emit
    // an ISO string and the client's `ts: number` cast would silently lie.
    const parsed = payloadOf(
      formatSseFrame('HELLO', { ts: new Date(1_700_000_000_000) }),
    ) as {
      ts: unknown;
    };
    expect(parsed.ts).toBe(1_700_000_000_000);
    expect(typeof parsed.ts).toBe('number');
  });

  it('BigInt → string and does NOT throw (raw JSON.stringify would throw "Do not know how to serialize a BigInt")', () => {
    // A stray BigInt reaching a raw JSON.stringify throws and kills the SSE writer; the chokepoint exists
    // so a caller forgetting to pre-convert can never cause that.
    expect(() => JSON.stringify({ id: 9_007_199_254_740_993n })).toThrow();
    const parsed = payloadOf(
      formatSseFrame('NOTIFY', { id: 9_007_199_254_740_993n }),
    ) as {
      id: string;
    };
    expect(parsed.id).toBe('9007199254740993');
  });

  it('nested Date / BigInt inside objects and arrays are recursively converted; null is preserved', () => {
    expect(
      payloadOf(
        formatSseFrame('STATE_FEED_UPDATED', {
          pinnedAt: new Date(0),
          nullable: null,
          rows: [{ id: 1n, at: new Date(1_700_000_000_000) }],
        }),
      ),
    ).toEqual({
      pinnedAt: 0,
      nullable: null,
      rows: [{ id: '1', at: 1_700_000_000_000 }],
    });
  });

  it('primitive payloads pass through unchanged (no spurious conversion)', () => {
    expect(payloadOf(formatSseFrame('ping', {}))).toEqual({});
    expect(
      payloadOf(formatSseFrame('x', { n: 1, s: 'a', b: true, nil: null })),
    ).toEqual({
      n: 1,
      s: 'a',
      b: true,
      nil: null,
    });
  });

  it('produces the same Date→number as the HTTP SerializeInterceptor (shared serializeBody engine)', () => {
    // SSE and HTTP share serializeBody, so a Date yields the IDENTICAL epoch-ms on both buses.
    const d = new Date('2026-06-24T00:00:00Z');
    const fromFrame = payloadOf(formatSseFrame('x', { t: d })) as { t: number };
    expect(fromFrame.t).toBe(
      (serializeBody({ t: d }) as unknown as { t: number }).t,
    );
  });
});
