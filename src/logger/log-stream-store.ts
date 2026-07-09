import { Writable } from 'node:stream';
import { optionalIntEnv } from '../common/env.js';

/**
 * A single structured log record, as the parsed pino JSON line. pino serializes the level as its
 * string label (see formatters.level in pino-factory), so `level` is one of
 * 'trace'|'debug'|'info'|'warn'|'error'|'fatal'. All other pino fields (time, msg, context, req, res,
 * responseTime, err, redacted-sensitive) are present verbatim.
 */
export interface LogRecord {
  level: string;
  time: string | number;
  msg: string;
  context?: string;
  req?: Record<string, unknown>;
  res?: Record<string, unknown>;
  responseTime?: number;
  err?: unknown;
  [key: string]: unknown;
}

export type LogSubscriber = (record: LogRecord) => void;

/**
 * In-process hub for live log observation: a bounded ring buffer of the most recent records (for SSE
 * replay-on-connect) plus a subscriber set fanned out to on every new record.
 *
 * MUST be a module-level singleton, NOT a Nest provider injected into the pino factory: the pino
 * instance is built in a nestjs-pino useFactory that runs during DI init, and it references this
 * object directly. The same instance is then re-registered as a provider
 * (`{ provide: LogStreamStore, useValue: logStreamStore }`) so LogViewerService can inject it.
 *
 * The ring buffer + fan-out run on the main thread (not a pino worker transport) precisely because
 * fan-out must call res.write() on held SSE connections — a worker_thread cannot reach back into
 * main-thread JS objects. Hence the whole pino pipeline is a multistream (see pino-factory).
 */
export class LogStreamStore {
  private readonly buffer: LogRecord[] = [];
  private readonly subscribers = new Set<LogSubscriber>();

  constructor(private readonly cap: number) {}

  /** Append one record (evicting the oldest past the cap), then fan it out to live subscribers. */
  push(record: LogRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > this.cap) {
      this.buffer.splice(0, this.buffer.length - this.cap);
    }
    for (const fn of this.subscribers) {
      try {
        fn(record);
      } catch {
        // A throwing subscriber must not abort the write loop or starve other subscribers.
      }
    }
  }

  /** Copy of the buffer, optionally filtered to records at or above `minLevel`. Newest-last (the
   *  chronological order the viewer renders in). */
  snapshot(minLevel?: string): LogRecord[] {
    if (!minLevel) return [...this.buffer];
    return this.buffer.filter((r) => atOrAbove(r.level, minLevel));
  }

  /** Subscribe to live records; returns an unsubscribe function. */
  subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Current buffer fill (for the admin health/stats view). */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * A Node Writable that pino's multistream writes JSON lines into. Each write is one complete
   * newline-delimited JSON object (pino buffers and emits whole lines), so a per-write JSON.parse is
   * correct. A parse failure (should never happen) is swallowed so logging can never throw on the hot
   * path — the file/stdout legs still carry the line; only the live viewer would miss it.
   */
  asWritable(): Writable {
    return new Writable({
      write: (chunk: Buffer | string, _enc, callback) => {
        try {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          const trimmed = text.trim();
          if (trimmed) this.push(JSON.parse(trimmed) as LogRecord);
        } catch {
          /* never let logging throw */
        }
        callback();
      },
    });
  }
}

/** Numeric rank for inclusive level filtering (a selected level shows itself + every more-severe one). */
const LEVEL_RANK: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** True when `level` is at least as severe as `min` (unknown levels rank 0, i.e. always shown). */
export function atOrAbove(level: string, min: string): boolean {
  return (LEVEL_RANK[level] ?? 0) >= (LEVEL_RANK[min] ?? 0);
}

const RING_SIZE = optionalIntEnv('LOG_RING_BUFFER_SIZE', 2000);

/** The single process-wide store, referenced by both the pino factory and the Nest provider. */
export const logStreamStore = new LogStreamStore(RING_SIZE);
