import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { buildPino } from './pino-factory.js';
import { logStreamStore } from './log-stream-store.js';

/** Minimal structural view of a request for the serializer — the fields the access log needs, which
 *  pino-http/Fastify add at runtime but the statically-inferred IncomingMessage type lacks. */
type ReqLike = {
  id?: string;
  method?: string;
  url?: string;
  ip?: string;
  user?: { userId?: number; adminId?: number };
};

/**
 * Build the nestjs-pino Params. A single pre-built multistream pino instance is passed via
 * `pinoHttp.logger` (nestjs-pino's "PassedLogger" shape): nestjs-pino uses it for out-of-request app
 * logs (`new Logger('Ctx')`) AND hands the same object to pino-http, which applies genReqId /
 * serializers / access logging as children of that instance — so access logs flow to stdout + file +
 * the live ring buffer too (one consistent pipeline).
 */
export function buildLoggerParams(): Params {
  return {
    pinoHttp: {
      logger: buildPino(logStreamStore),
      // Correlation ID: honor an inbound X-Request-Id (reverse-proxy / upstream), else mint a UUID.
      // Stamp it on the raw response so a client/support can grep the full request trail across logs.
      // pino-http hands genReqId the raw ServerResponse, so setHeader (not Fastify's reply.header).
      genReqId: (req, res) => {
        const incoming = req.headers?.['x-request-id'];
        const id =
          typeof incoming === 'string' && incoming ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
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
      // Trim each access record to the correlation-relevant fields. Bodies are deliberately NOT
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
            // DIAGNOSTIC (temporary): is `req` the raw IncomingMessage or the FastifyRequest wrapper?
            __diag: {
              hasRaw: !!(req as unknown as { raw?: unknown }).raw,
              hasSocket: !!(req as unknown as { socket?: unknown }).socket,
              ctor: (req as unknown as { constructor?: { name?: string } }).constructor?.name,
            },
          };
        },
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
  };
}
