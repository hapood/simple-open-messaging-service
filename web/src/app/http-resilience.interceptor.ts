import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { InjectionToken, inject } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  retry,
  tap,
  throwError,
  timer,
} from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { ToastService } from './services/toast.service';
import { BusinessCode } from './services/biz-code';
import { SUPPRESS_HTTP_ERROR_TOAST } from './request-context';
import { SessionLifecycleService } from './services/session-lifecycle.service';

/**
 * Retry + surface policy for transient/server HTTP failures. `retryDelay` is a function (not a number) so
 * the spec can emit synchronously (`of(0)`) instead of waiting a real timer — the app is zoneless with no
 * `fakeAsync`/`tick`, which would otherwise make the retry path impractical to test.
 */
export interface HttpRetryConfig {
  maxRetries: number;
  retryDelay: (retryCount: number) => Observable<unknown>;
}

const RATE_LIMIT_BASE_MS = 1000;
const RATE_LIMIT_CAP_MS = 8000;

/**
 * Production policy: full-jitter exponential backoff mirroring admin-web's `rateLimitConfig` and the SSE
 * log-tail (`use-log-stream.ts`) — base 1s, cap 8s, 4 retries (~8s avg budget).
 */
export const DEFAULT_HTTP_RETRY_CONFIG: HttpRetryConfig = {
  maxRetries: 4,
  retryDelay: (retryCount) =>
    timer(
      Math.random() *
        Math.min(RATE_LIMIT_BASE_MS * 2 ** (retryCount - 1), RATE_LIMIT_CAP_MS),
    ),
};

export const HTTP_RETRY_CONFIG = new InjectionToken<HttpRetryConfig>(
  'HTTP_RETRY_CONFIG',
);

/** The ThrottleGuard burst rate-limit: a Nest GUARD, runs BEFORE the handler, so a 429 here means the
 *  request never reached the route → zero side effects → safe to retry even for a non-idempotent POST.
 *  Scoped to code 10005 so the federation day-quota 429 (50011, NOT transient) is not retried. */
function isBurstRateLimit(err: unknown): boolean {
  return (
    err instanceof HttpErrorResponse &&
    err.status === 429 &&
    err.error?.code === BusinessCode.RATE_LIMITED
  );
}

/** Surface 5xx / a final 429 / a network drop (status 0) — the cases that were silently swallowed because
 *  most component subscribers have no `catchError` (GlobalErrorHandler only `console.error`s). 401 is NOT
 *  surfaced here — AuthInterceptor (outer) owns re-login. */
function isSurfaceable(err: unknown): boolean {
  if (!(err instanceof HttpErrorResponse)) return false;
  return err.status === 0 || err.status >= 500 || err.status === 429;
}

function localizeHttpError(
  err: HttpErrorResponse,
  t: TranslocoService,
): string {
  if (err.status === 0) return t.translate('errors.networkError');
  if (
    err.status === 429 &&
    err.error?.code === BusinessCode.FEDERATION_QUOTA_EXCEEDED
  ) {
    return t.translate('errors.biz.federationQuotaExceeded');
  }
  if (err.status === 429) return t.translate('errors.biz.rateLimited');
  return t.translate('errors.serverError'); // 5xx
}

/**
 * Functional interceptor — registered INNERMOST (after httpTrace in `app.config.ts`). It validates
 * login ownership before backend admission, retry decisions, result delivery and user-facing errors.
 * This prevents obsolete work from retrying or surfacing errors before the outer auth guard sees it.
 *
 *  - Retry the burst rate-limit (429 / code 10005) with backoff. Safe — see {@link isBurstRateLimit}.
 *  - After retries are exhausted OR on a non-retryable failure, surface 5xx / final-429 / network via a
 *    `ToastService.warn`, then rethrow so component subscribers still receive it. Only the SILENT case
 *    changes (4xx business errors stay with per-component handling to avoid double-surfacing).
 *  - 5xx is NOT retried: side-effect status is unknown and the codebase is almost all POST with no way to
 *    tell read-POSTs from mutation-POSTs.
 *  - 401 passes through untouched (AuthInterceptor, registered outer/DI, owns re-login + drops the request).
 */
export const httpResilienceInterceptor: HttpInterceptorFn = (req, next) => {
  const config = inject(HTTP_RETRY_CONFIG);
  const toast = inject(ToastService);
  const transloco = inject(TranslocoService);
  const lifecycle = inject(SessionLifecycleService);
  const owner = lifecycle.capture();
  return defer(() => {
    // Recheck on every retry, including after a backoff timer has elapsed.
    lifecycle.assertCurrent(owner);
    return next(req);
  }).pipe(
    tap(() => lifecycle.assertCurrent(owner)),
    // Non-retryable errors throw from `delay`, which stops retry and falls through to catchError.
    retry({
      count: config.maxRetries,
      delay: (err, retryCount) => {
        lifecycle.assertCurrent(owner);
        return isBurstRateLimit(err)
          ? config.retryDelay(retryCount)
          : throwError(() => err);
      },
    }),
    catchError((err) => {
      lifecycle.assertCurrent(owner);
      if (isSurfaceable(err) && !req.context.get(SUPPRESS_HTTP_ERROR_TOAST)) {
        toast.warn(localizeHttpError(err as HttpErrorResponse, transloco));
      }
      return throwError(() => err);
    }),
  );
};
