import { HttpException, HttpStatus } from '@nestjs/common';
import { BusinessCode } from './business-code.js';

/**
 * A business-logic failure carrying a domain BusinessCode.
 *
 * The global AllExceptionsFilter renders it as `{ code, message, data: null }` (or `data` when a
 * structured payload is passed) at the given httpStatus — **default 200**. Business outcomes return
 * HTTP 200 + business code by convention, including not-found and authorization denials (FORBIDDEN):
 * a missing resource or a "not friends" refusal is a business answer, not a protocol error, so it
 * must NOT demote a federated peer. An explicit non-200 status is reserved for deliberate
 * protocol/policy signals — 410 GONE (the federation group-author-left leave signal, which the pulling
 * side detects via `S2sResponseError.status === 410`), 403 for an admin-enforced peer block, 400 for
 * malformed-input refusals. The federation transports (`getSigned`/`postSigned`) demote a peer only on
 * 401/403/5xx — never on a 200 business refusal.
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
     *  can act on — e.g. a quota hit's `{category, limit, retryAfter}` or a rate-limit's `retryAfter`. */
    public readonly data?: unknown,
  ) {
    // Stash the domain code + data inside the response object so the filter can read them without a
    // circular import on BusinessCode (it already imports BusinessCode itself).
    super({ code: bizCode, message, data: data ?? null }, httpStatus);
  }
}
