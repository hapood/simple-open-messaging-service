import { HttpErrorResponse } from '@angular/common/http';

/**
 * Map an HTTP error to a user-facing message.
 *
 * The backend reports business errors as HTTP 200 + `{ code: non-zero, message }`; callers wrap
 * those as plain `Error` (carrying the server's `message`). Transport-level failures surface as an
 * Angular `HttpErrorResponse` whose own `.message` is a leaky/internal string
 * ("Http failure response for ...: 500 Server Error") — never suitable to show users.
 *
 * So: pass plain `Error`s through (they already carry a meaningful message), and collapse any
 * `HttpErrorResponse` (status 0 / >= 400 — network down, server error, timeout) into the fallback.
 */
export function toFriendlyHttpError(
  err: unknown,
  fallback = 'Network error, please retry',
): string {
  // HttpErrorResponse extends Error, so check it first: transport failures collapse to the fallback.
  if (err instanceof HttpErrorResponse) return fallback;
  // Plain Error (e.g. business errors wrapped by callers carrying the server's message) passes through.
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}
