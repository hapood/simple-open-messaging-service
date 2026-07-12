import { HttpException, HttpStatus } from '@nestjs/common';
import { BusinessCode } from './business-code.js';

/**
 * A business-logic failure carrying a domain BusinessCode.
 *
 * The global AllExceptionsFilter renders it as `{ code, message, data: null }` with the
 * httpStatus given (default 200 — business outcomes return HTTP 200 + business code by
 * convention; only the protocol/system layer 401/404/409/500 retains its HTTP status).
 *
 * This lets guards and services *throw* domain codes (e.g. THREAD_NOT_FOUND) the same way
 * controllers *return* them, so authorization can move from inline controller checks into
 * declarative guards without breaking the HTTP-200-plus-code envelope the frontend relies on.
 *
 * Prefer returning an ApiResult from a controller when the outcome is part of the normal
 * request flow; throw a BusinessException when a guard/interceptor/service has to abort.
 */
export class BusinessException extends HttpException {
  constructor(
    /** Domain business code (see BusinessCode). Carried on the instance for logging/tests. */
    public readonly bizCode: number,
    message: string,
    httpStatus: HttpStatus = HttpStatus.OK,
    /** Optional structured payload surfaced on the response envelope's `data` field (the filter
     *  passes it through verbatim; absent → `data: null` as usual). Use for error context the client
     *  can act on — e.g. a quota hit's `{category, limit, retryAfter}` or a rate-limit's `retryAfter`. */
    public readonly data?: unknown,
  ) {
    // Stash the domain code + data inside the response object so the filter can read them without a
    // circular import on BusinessCode (it already imports BusinessCode itself).
    super({ code: bizCode, message, data: data ?? null }, httpStatus);
  }
}
