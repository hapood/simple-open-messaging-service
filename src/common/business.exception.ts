import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A business-logic failure carrying a domain BusinessCode.
 *
 * The global AllExceptionsFilter renders it as `{ code, message, data: null }` (or `data` when a
 * structured payload is passed) at the given httpStatus — **default 200**. Business outcomes return
 * HTTP 200 + business code by convention, including not-found and authorization denials (FORBIDDEN):
 * a missing resource or a "not friends" refusal is a business answer, not a protocol error, so it
 * must NOT degrade a federated peer. Federation v1 reserves non-200 JSON statuses for protocol shape
 * (`400`), authentication/binding (`401`), fatal peer-relationship conflict (`409`), and temporary
 * service unavailability (`503`). Its transports change lifecycle only for `503`, or for `409` paired
 * with a registered fatal code; an HTTP 200 business refusal never changes peer lifecycle.
 *
 * Guards/services/controllers throw this to abort with a domain code (e.g. THREAD_NOT_FOUND); success
 * handlers return raw data and the global SerializeInterceptor wraps the `{ code, message, data }`
 * envelope. Same envelope shape either way → the frontend branches on `code` uniformly.
 */
export class BusinessException extends HttpException {
  constructor(
    /** Domain business code (see BusinessCode). Carried on the instance for logging/tests. */
    public readonly bizCode: number,
    message: string,
    httpStatus: HttpStatus = HttpStatus.OK,
    /** Optional structured payload surfaced on the response envelope's `data` field (the filter
     *  passes it through verbatim; absent → `data: null` as usual). Use for error context the client
     *  can act on — e.g. a quota or rate-limit result's `{retryAfter}`. */
    public readonly data?: unknown,
  ) {
    // Stash the domain code + data inside the response object so the filter can read them without a
    // circular import on BusinessCode (it already imports BusinessCode itself).
    super({ code: bizCode, message, data: data ?? null }, httpStatus);
  }
}
