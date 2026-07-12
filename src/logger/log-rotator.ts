import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { SonicBoom } from 'sonic-boom';
import { optionalIntEnv } from '../common/env.js';

/**
 * Rotating file destination for pino, built on SonicBoom (pino.destination). Rotates the stable
 * `soms.log` to a date-stamped archive on (a) a day boundary and (b) when it exceeds
 * LOG_FILE_MAX_SIZE, then reopens the stable file via SonicBoom.reopen() (which re-opens the same
 * path fresh). Archives older than LOG_FILE_RETENTION days are pruned.
 *
 * Why not pino-roll: pino-roll is a pino *transport* (runs in a worker_thread). Our pipeline is a
 * pino multistream on the main thread so the in-process LogStreamStore can fan out to live SSE
 * connections — a worker cannot reach main-thread JS objects. A transport cannot share that
 * multistream, so rotation is done here, in-process, on the same SonicBoom the multistream writes to.
 *
 * SonicBoom writes are async (non-blocking libuv I/O) so the main thread is never blocked on
 * write(2). A process 'exit' hook flushes synchronously so no buffered lines are lost on hard exit
 * (this app does not call enableShutdownHooks, so onModuleDestroy is NOT guaranteed on signal — the
 * exit hook is the reliable flush point).
 */

// Conventional fixed location (NOT operator-facing config): <cwd>/data/logs. In the Docker image
// (cwd=/app) this is /app/data/logs — inside the unified persistent app-data volume (alongside the
// S2S/JWT keys and Caddy state), so logs survive container restart/recreate. In dev (cwd=repo) it is
// ./data/logs. The LOG_DIR env override is kept ONLY as an internal/test escape hatch (test/setup-env
// redirects forks to a tmpdir) — operators never need to set it.
const LOG_DIR = process.env.LOG_DIR ?? join(process.cwd(), 'data', 'logs');
const MAX_SIZE = optionalIntEnv('LOG_FILE_MAX_SIZE', 50 * 1024 * 1024); // 50 MB
const RETENTION_DAYS = optionalIntEnv('LOG_FILE_RETENTION', 7);
const CHECK_INTERVAL_MS = 30_000;
const ARCHIVE_PREFIX = 'soms-';
const ARCHIVE_SUFFIX = '.log';

/** The stable current-day log path; the multistream always writes here, rotation renames it away. */
export const CURRENT_LOG_FILE = join(LOG_DIR, 'soms.log');

/** Tracked across checks so a day rollover is detected by string comparison, not just by file mtime. */
let currentDay = new Date().toISOString().slice(0, 10);

/**
 * Build the archive filename for a rotation: soms-YYYY-MM-DD.log, with a `.N` suffix when the same-day
 * name already exists (multiple size-based rotations within one day). Uses the process start day as the
 * stamp baseline; the actual day string is whatever `currentDay` was set to before rotation.
 */
function archiveName(): string {
  const base = join(LOG_DIR, `${ARCHIVE_PREFIX}${currentDay}${ARCHIVE_SUFFIX}`);
  if (!existsSync(base)) return base;
  let n = 1;
  for (;;) {
    const candidate = join(LOG_DIR, `${ARCHIVE_PREFIX}${currentDay}.${n}${ARCHIVE_SUFFIX}`);
    if (!existsSync(candidate)) return candidate;
    n++;
  }
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
    if (!name.startsWith(ARCHIVE_PREFIX) || !name.endsWith(ARCHIVE_SUFFIX)) continue;
    const abs = join(LOG_DIR, name);
    try {
      if (statSync(abs).mtimeMs < cutoff) unlinkSync(abs);
    } catch {
      /* best-effort */
    }
  }
}

/** Rotate the current file: flush, rename to a dated archive, reopen the stable path, prune. No-op on
 *  the rename if the current file is absent (e.g. a fresh boot with no logs yet). */
function rotate(dest: SonicBoom): void {
  try {
    dest.flushSync();
  } catch {
    /* ignore */
  }
  if (existsSync(CURRENT_LOG_FILE)) {
    try {
      renameSync(CURRENT_LOG_FILE, archiveName());
    } catch {
      // If rename fails (e.g. cross-device), keep writing the current file rather than losing logs.
      return;
    }
  }
  try {
    dest.reopen();
  } catch {
    /* ignore */
  }
  pruneOld();
}

/**
 * Open the rotating SonicBoom destination and start the rotation timer. The returned SonicBoom is
 * handed to pino's multistream as one of its streams. mkdirSync guarantees the dir exists regardless
 * of the SonicBoom `mkdir` option (belt and suspenders across pino versions).
 */
export function openRotatingDestination(): SonicBoom {
  mkdirSync(LOG_DIR, { recursive: true });

  const dest = pino.destination({
    dest: CURRENT_LOG_FILE,
    mkdir: true,
    sync: false,
    append: true, // a hard restart must not truncate the current day's log
  }) as SonicBoom;

  // Periodic rotation check: day boundary OR size overrun.
  const timer = setInterval(() => {
    const today = new Date().toISOString().slice(0, 10);
    const dayRolled = today !== currentDay;
    let sizeOver = false;
    try {
      sizeOver = existsSync(CURRENT_LOG_FILE) && statSync(CURRENT_LOG_FILE).size >= MAX_SIZE;
    } catch {
      /* ignore */
    }
    if (dayRolled || sizeOver) {
      currentDay = today;
      rotate(dest);
    }
  }, CHECK_INTERVAL_MS);
  timer.unref();

  // Flush on process exit so async-buffered lines are not lost (no enableShutdownHooks in this app).
  process.on('exit', () => {
    try {
      dest.flushSync();
    } catch {
      /* ignore */
    }
  });

  pruneOld();
  return dest;
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
