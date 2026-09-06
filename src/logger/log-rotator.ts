import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createStream, type RotatingFileStream } from 'rotating-file-stream';
import { optionalIntEnv } from '../common/env.js';
import { dataDirectory } from '../common/data-directory.js';

/**
 * Rotating file destination for pino, built on `rotating-file-stream` (rfs — a self-described "logrotate
 * alternative"). rfs is a plain main-thread `stream.Writable` (NOT a worker transport), so it composes
 * with the in-process pino multistream exactly like the old SonicBoom destination did — the multistream
 * still fans out to stdout, this file, and the live SSE LogStreamStore on the main thread.
 *
 * Why rfs and not pino-roll: pino-roll is a pino *transport* (runs in a worker_thread). Our pipeline is a
 * pino multistream on the main thread so the in-process LogStreamStore can fan out to live SSE
 * connections — a worker cannot reach main-thread JS objects. rfs, being a plain Writable, plugs into that
 * multistream and lets a vetted library own the hard part of rotation (atomic rename/reopen, filename
 * uniqueness, size+interval triggers) instead of hand-rolling it.
 *
 * Naming (see {@link fileName}): the current file is always the stable {@link CURRENT_LOG_FILE}
 * (`soms.log`); each rotation renames it to a UTC-dated archive `soms-YYYY-MM-DD.log`, with a `.N` suffix
 * for same-day size-based rotations. This preserves the exact on-disk layout the history viewer
 * enumerates, so {@link listLogFiles} is unchanged.
 *
 * Retention is still time-based (prune archives older than {@link RETENTION_DAYS} by mtime) — rfs only
 * offers count/size retention, not age. {@link pruneOld} runs once at boot and on each rfs `rotated`
 * event, so no polling timer is needed.
 *
 * Durability note: SonicBoom exposed a synchronous `flushSync` we once called on `process('exit')`; rfs is
 * a normal async Writable with no sync flush, so on a hard exit a sub-second of buffered lines may not
 * reach this file. That is an acceptable trade — the multistream also writes stdout, which Docker captures
 * (the durable record), and adopting rfs removes a large surface of bespoke rotation logic.
 * Signal-driven graceful shutdown cannot protect buffered output from a forced SIGKILL.
 */

// Conventional fixed location (NOT operator-facing config): <cwd>/data/logs. In the Docker image
// (cwd=/app) this is /app/data/logs — inside the unified persistent app-data volume (alongside the
// S2S/JWT keys and Caddy state), so logs survive container restart/recreate. In dev (cwd=repo) it is
// ./data/logs. The LOG_DIR env override is kept ONLY as an internal/test escape hatch (test/setup-env
// redirects forks to a tmpdir) — operators never need to set it.
const LOG_DIR = process.env.LOG_DIR ?? dataDirectory('logs');
const MAX_SIZE = optionalIntEnv('LOG_FILE_MAX_SIZE', 50 * 1024 * 1024); // 50 MB (bytes; rfs wants a unit string)
const RETENTION_DAYS = optionalIntEnv('LOG_FILE_RETENTION', 7);
const ARCHIVE_PREFIX = 'soms-';
const ARCHIVE_SUFFIX = '.log';
const CURRENT_BASENAME = 'soms.log';

/** The stable current-day log path; rfs always writes here, rotation renames it away to a dated archive. */
export const CURRENT_LOG_FILE = join(LOG_DIR, CURRENT_BASENAME);

const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/**
 * rfs file-name generator. rfs invokes it with a falsy `time` to obtain the *not-rotated* (current) file
 * name — we keep that stable as {@link CURRENT_BASENAME} so the live writer and the history viewer agree
 * on the current path. On rotation it passes the period boundary (a `Date`, because
 * `intervalBoundary`+`intervalUTC` are set) plus an `index` for within-period size rotations, which we fold
 * into a `.N` suffix to guarantee uniqueness without colliding with the day's first archive.
 */
function fileName(time: number | Date, index = 0): string {
  if (!time) return CURRENT_BASENAME;
  const d = time instanceof Date ? time : new Date(time);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return index > 0
    ? `${ARCHIVE_PREFIX}${ymd}.${index}${ARCHIVE_SUFFIX}`
    : `${ARCHIVE_PREFIX}${ymd}${ARCHIVE_SUFFIX}`;
}

/** Format a byte count as the unit-string rfs expects (`size` option), picking the largest whole unit. */
function rfsSize(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const KB = 1024;
  if (bytes >= GB) return `${Math.floor(bytes / GB)}G`;
  if (bytes >= MB) return `${Math.floor(bytes / MB)}M`;
  if (bytes >= KB) return `${Math.floor(bytes / KB)}K`;
  return `${bytes}B`;
}

/** Delete archives whose mtime is older than RETENTION_DAYS. Never touches the current soms.log. */
function pruneOld(): void {
  let entries: string[];
  try {
    entries = readdirSync(LOG_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (!name.startsWith(ARCHIVE_PREFIX) || !name.endsWith(ARCHIVE_SUFFIX))
      continue;
    const abs = join(LOG_DIR, name);
    try {
      if (statSync(abs).mtimeMs < cutoff) unlinkSync(abs);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Open the rotating rfs destination and hand it to pino's multistream as one of its streams. mkdirSync
 * guarantees the dir exists regardless of rfs's own path handling (belt and suspenders). Retention is
 * pruned once here and on each `rotated` event — no polling timer.
 */
export function openRotatingDestination(): RotatingFileStream {
  mkdirSync(LOG_DIR, { recursive: true });

  const stream = createStream(fileName, {
    size: rfsSize(MAX_SIZE), // rotate when the current file exceeds MAX_SIZE
    interval: '1d', // …and on each UTC day boundary
    intervalBoundary: true, // generator `time` = period lower boundary (deterministic day), not rotation moment
    intervalUTC: true, // boundaries in UTC (matches the old toISOString day stamp)
    initialRotation: true, // if the current file is already oversized at boot, rotate it now
    path: LOG_DIR,
  });

  // A logger must never crash its own sink: rfs 'warning' is non-blocking (rename race, history hiccup),
  // 'error' is fatal — both go to stderr and are swallowed.
  stream.on('warning', (e: Error) =>
    process.stderr.write(`[log-rotator] rotation warning: ${e.message}\n`),
  );
  stream.on('error', (e: Error) =>
    process.stderr.write(`[log-rotator] rotation error: ${e.message}\n`),
  );
  stream.on('rotated', () => pruneOld());

  pruneOld();
  return stream;
}

/** Enumerate log files for the history viewer: the current file first, then archives newest-first by
 *  mtime. Returns absolute paths; empty array if the dir is unreadable. */
export function listLogFiles(): string[] {
  try {
    const entries = readdirSync(LOG_DIR);
    const archives = entries
      .filter((n) => n.startsWith(ARCHIVE_PREFIX) && n.endsWith(ARCHIVE_SUFFIX))
      .map((n) => ({ name: n, abs: join(LOG_DIR, n) }))
      .sort((a, b) => {
        try {
          return statSync(b.abs).mtimeMs - statSync(a.abs).mtimeMs;
        } catch {
          return a.name < b.name ? 1 : -1;
        }
      })
      .map((e) => e.abs);
    return [CURRENT_LOG_FILE, ...archives];
  } catch {
    return [];
  }
}

/** The configured log directory (read by the history viewer to label files). */
export function getLogDir(): string {
  return LOG_DIR;
}
