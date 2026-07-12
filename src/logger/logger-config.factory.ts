import { RequestMethod } from '@nestjs/common';
import type { Params } from 'nestjs-pino';
import { buildPino } from './pino-factory.js';
import { logStreamStore } from './log-stream-store.js';

/** Minimal structural view of a request for the access-log serializer — FastifyRequest fields
 *  (id, method, url, ip) plus the principal guards set on req.user. */
type ReqLike = {
  id?: string | number;
  method?: string;
  url?: string;
  ip?: string;
  user?: { userId?: number; adminId?: number };
};

/**
 * Build the nestjs-pino Params. A single pre-built multistream pino instance is passed via
 * `pinoHttp.logger` (nestjs-pino's "PassedLogger" shape): nestjs-pino uses it for out-of-request app
 * logs (`new Logger('Ctx')`) AND hands the same object to pino-http, which applies the access-log
 * config as children of that instance — so access logs flow to stdout + file + the live ring buffer.
 *
 * The request correlation id is NOT generated here: Fastify owns `request.id` (honoring an inbound
 * X-Request-Id header, else a UUID — see the adapter's requestIdHeader/genReqId in main.ts). pino-http
 * reuses that existing request.id (its default genReqId returns req.id when already set), so every
 * access + app log for one request shares the id; bootstrap's onSend hook echoes it on the response.
 */
export function buildLoggerParams(): Params {
  return {
    // nestjs-pino's default mounts the pino-http middleware on `forRoutes({ path: '*', method: ALL })`.
    // Under our global prefix `api/v1`, Nest expands that bare `*` into `/api/v1/*`, which the Fastify
    // adapter then hands to path-to-regexp — and v8 (Fastify 5 / find-my-way 9) rejects the unnamed
    // wildcard. Nest's LegacyRouteConverter catches it, auto-converts `*` → `{*path}`, and logs a WARN
    // per middleware at startup (twice — pino-http applies two middlewares to this one route). Supplying
    // the v8 named-wildcard form directly is the same path Nest would convert `*` into, so matching is
    // identical (still every /api/v1 request; /uploads, /.well-known, and the SPA already bypass Nest's
    // middleware chain via raw Fastify hooks) — it just skips the warning. This is what upstream
    // nestjs-pino ought to ship as its default; remove this override if it ever does.
    forRoutes: [{ path: '/*path', method: RequestMethod.ALL }],
    pinoHttp: {
      logger: buildPino(logStreamStore),
      // Severity by outcome: a thrown error or 5xx → error; 4xx → warn; otherwise info.
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customSuccessMessage: (req, res, responseTime) =>
        `${req.method} ${req.url} → ${res.statusCode} ${responseTime}ms`,
      customErrorMessage: (req, res, err) =>
        `${req.method} ${req.url} → ${res.statusCode} ${err.message}`,
      // Trim each access record to the correlation-relevant fields. `req` is the FastifyRequest
      // wrapper (has .id/.method/.url/.ip), so these read directly. Bodies are deliberately NOT
      // serialized (passwords / PII never enter the access log). userId/adminId come from req.user,
      // which JwtAuthGuard/AdminAuthGuard set before the response-time access line is written.
      serializers: {
        req: (req) => {
          const r = req as unknown as ReqLike;
          return {
            id: r.id,
            method: r.method,
            url: r.url,
            remoteAddress: r.ip,
            userId: r.user?.userId,
            adminId: r.user?.adminId,
          };
        },
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
  };
}
