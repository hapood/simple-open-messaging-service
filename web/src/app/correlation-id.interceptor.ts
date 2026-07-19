import { HttpInterceptorFn } from '@angular/common/http';
import { uuid } from './lib/uuid';

/**
 * Stamp every outgoing request with an `X-Request-Id` correlation id so a failure observed on the
 * client can be matched to the server's pino logs for the SAME request. The backend already honors an
 * inbound `x-request-id` as Fastify's `request.id` (`src/main.ts` `requestIdHeader`/`genReqId`), logs
 * it via the pino `req.id` serializer (`src/logger/logger-config.factory.ts`), and echoes it on the
 * response (`src/bootstrap.ts` `onRequest` hook) — this interceptor is what makes the webview actually
 * send one.
 *
 * The id is minted CLIENT-SIDE (not read back from the response) so correlation starts the moment the
 * call is made. That matters for the cases most worth diagnosing — a status-0 network failure that
 * never reached the server, or never came back — where there is no response echo to read, yet there is
 * still an id to grep server logs by (if the request did land) or to confirm it never landed.
 *
 * Generated only when ABSENT: a caller that already set one (e.g. an explicit retry keyed to a known
 * id) is respected, never clobbered. Runs OUTER to `httpTraceInterceptor` (registered before it in the
 * `withInterceptors` array in `app.config.ts`), so the trace interceptor's `req` already carries the
 * header and it appends ` req=<id>` to every `[http]` failure line. Runs inner to the DI
 * `AuthInterceptor`, which is irrelevant — the two touch disjoint headers. Uses `lib/uuid` rather than
 * `crypto.randomUUID` so the PWA's plain-HTTP origin still gets a spec-compliant UUID.
 */
export const correlationIdInterceptor: HttpInterceptorFn = (req, next) => {
  // HttpHeaders.has is case-insensitive, so this also short-circuits a pre-set `x-request-id`.
  if (req.headers.has('X-Request-Id')) return next(req);
  return next(req.clone({ setHeaders: { 'X-Request-Id': uuid() } }));
};
