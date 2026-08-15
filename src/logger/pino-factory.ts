import pino from 'pino';
import pretty from 'pino-pretty';
import { LogStreamStore } from './log-stream-store.js';
import { openRotatingDestination } from './log-rotator.js';

/**
 * Translate a Nest-style LOG_LEVEL into a pino level. Nest's 'log' has no pino equivalent (nestjs-pino
 * maps the *method* name log→info), so the pino instance's own `level` must be a real pino level:
 * 'log'→'info', 'verbose'→'trace'. Default 'log' → 'info' keeps routine output while suppressing
 * debug/trace. Unknown values fall back to 'info'.
 */
function resolvePinoLevel(raw: string | undefined): pino.LevelWithSilent {
  const v = (raw ?? 'log').toLowerCase();
  if (v === 'log') return 'info';
  if (v === 'verbose') return 'trace';
  if (
    ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(v)
  ) {
    return v as pino.LevelWithSilent;
  }
  return 'info';
}

/**
 * Secret fields to redact from every log record (censor → '[REDACTED]'). Covers request headers
 * (Authorization / cookie / the media_token), DTO body fields (password variants), and credential-
 * shaped fields anywhere they might appear. pino's fast-redact `*` is a single-level wildcard (no
 * `**`), so each credential is listed BOTH at the root (a service logging a domain object directly,
 * e.g. a User carrying `hashPwd`) and one level deep (`*.x`, e.g. inside a child object). Request
 * bodies are never serialized by the access logger anyway (see logger-config.factory), so this is
 * defense-in-depth for application logs that happen to pass such objects to the logger.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["media_token"]',
  'req.body.password',
  'req.body.oldPassword',
  'req.body.newPassword',
  'password',
  '*.password',
  'oldPassword',
  '*.oldPassword',
  'newPassword',
  '*.newPassword',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'hashPwd',
  '*.hashPwd',
];

/**
 * Build the single process-wide pino logger: a multistream fanning out to
 *  - stdout (pino-pretty colorized in dev, raw newline-delimited JSON in prod)
 *  - a rotating file (data/logs/soms.log + dated archives; see log-rotator) — the persisted record
 *  - the in-process LogStreamStore (ring buffer + live SSE fan-out)
 * The multistream is in-process (NOT a worker transport) so the store can reach live SSE sockets.
 * pino serializes each record once (applying formatters + redact) and writes the identical line to
 * every stream, so the file, stdout, and the live viewer all carry the same structured record.
 *
 * The file is ALWAYS on — SOMS keeps its own log (own rotation + retention), not Docker's stdout
 * capture. In the Docker image it lives under the persistent /app/data volume (data/logs/soms.log), so
 * it survives container restart/recreate. stdout stays on too as a live mirror for `docker compose logs`
 * and boot/crash diagnostics.
 */
export function buildPino(store: LogStreamStore): pino.Logger {
  const level = resolvePinoLevel(process.env.LOG_LEVEL);
  const isDev = process.env.NODE_ENV !== 'production';

  const baseOpts: pino.LoggerOptions = {
    level,
    // ISO-8601 timestamps — human-readable, sortable, and timezone-aware for grep.
    timestamp: pino.stdTimeFunctions.isoTime,
    // pino's `base` REPLACES the default {pid, hostname}: pass pid + a service tag so records carry
    // the instance identity WITHOUT the noisy default hostname.
    base: { service: 'soms', pid: process.pid },
    formatters: {
      // Emit the level as its string label ('info') rather than the numeric value (30) — easier to
      // grep and to filter on in the admin viewer / ring buffer.
      level: (label: string) => ({ level: label }),
    },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };

  const stdoutStream = isDev
    ? pretty({
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname,service',
      })
    : process.stdout;

  return pino(
    baseOpts,
    pino.multistream([
      { level, stream: stdoutStream },
      { level, stream: openRotatingDestination() },
      { level, stream: store.asWritable() },
    ]),
  );
}
