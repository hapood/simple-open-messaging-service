import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, finalize, tap } from 'rxjs';

/** Dev-build-only compile gate (mirrors Angular's own per-file declaration): truthy under `ng serve`,
 *  folded to a constant and dead-code-eliminated in prod AOT. Gates the chatty cancel/abort trace below
 *  so production logs carry only REAL failures, not normal RxJS teardown. See {@link httpTraceInterceptor}. */
declare const ngDevMode: boolean | null | undefined;

/**
 * Always-on HTTP visibility interceptor: logs every FAILED request to the webview console so
 * network-call failures are attributable. Without it, a request whose error a caller `.catch`es into a
 * toast (or that `AuthInterceptor` swallows as `EMPTY` on a 401) is completely silent in the console —
 * the gap that hid, e.g., a 502 from the Rust `api://` proxy or a transient network drop. Registered
 * unconditionally in `app.config.ts`; severity by failure class:
 *
 *  - status 0 (offline / DNS / CORS / connection refused) → `console.error` — the "JS network error"
 *    surface, the case most worth seeing.
 *  - 5xx (server / gateway)                            → `console.error` — response body in dev only
 *    (prod keeps bodies — which may carry PII, e.g. a failed-login error envelope — out of the console).
 *  - 4xx (client, incl. an expired-session 401)        → `console.warn`    — business traffic: visible,
 *    not loud. A 401 also drives `AuthInterceptor`'s re-login; logging it here is complementary, not
 *    duplicative (that interceptor HANDLES auth; this one only adds VISIBILITY).
 *  - non-`HttpErrorResponse` propagation               → `console.error` — dev only (Angular's fetch
 *    backend should not produce these; if one surfaces, it's worth a dev-only flag).
 *
 * The cancel/abort trace — an in-flight request torn down by an unsubscribe (route navigation, component
 * destroy, HMR reload) — is DEV-ONLY: cancellation is normal RxJS teardown, not a failure, so logging it
 * in prod would flood the console on every navigation. Its purpose is attributing the opaque
 * `Uncaught (in promise) AbortError` Chrome logs at `<page>:1` (no stack frame; source maps can't help)
 * during `ng serve` — the exact problem this file was originally written to diagnose.
 *
 * Logs ONLY — never handles. `AuthInterceptor` owns the 401 re-login side-effect; this interceptor runs
 * INNER to it (request order: Auth → trace → fetch), so on the way back it logs first, then rethrows, and
 * `AuthInterceptor.on401` still fires for the 401. The Angular error-handling guidance splits concerns
 * across three DISJOINT surfaces — HttpInterceptor (request failures), ErrorHandler (Angular-managed
 * throws → `GlobalErrorHandler`), `unhandledrejection` (raw promises → the `main.ts` listeners) — and
 * this owns the first. No surface double-logs.
 */
export const httpTraceInterceptor: HttpInterceptorFn = (req, next) => {
  // Flips to true on the FIRST emission (next), a normal completion, or a propagated error; if `finalize`
  // runs without it, the subscription was torn down before the request produced ANY output → that is the
  // cancellation that aborts the underlying fetch and (when it leaks) surfaces as the uncaught AbortError.
  // MUST flip on `next`, not just `complete`: most callers consume HttpClient via `firstValueFrom` (e.g.
  // ConfigService.ensureLoaded), which unsubscribes immediately after the first value — before the source's
  // `complete` propagates — so a `complete`-only flag would false-positive "cancelled" on every request that
  // actually loaded fine. Dev-only below.
  // Correlation id stamped by the outer correlationIdInterceptor (or a caller). Appended to every
  // [http] line so a console failure matches the server's pino req.id for the same request. Absent
  // (e.g. unit tests without the outer interceptor, or a request that bypassed it) → omitted gracefully.
  const rid = req.headers.get('x-request-id');
  const ridSuffix = rid ? ` req=${rid}` : '';
  let settled = false;
  return next(req).pipe(
    tap({ next: () => { settled = true; }, complete: () => { settled = true; } }),
    catchError((err) => {
      settled = true;
      if (err instanceof HttpErrorResponse) {
        // The underlying cause sits under HttpErrorResponse.error (a DOMException for a fetch abort;
        // null/ProgressEvent for a status-0 network failure; the parsed body for an HTTP status failure).
        const cause = err.error;
        if (cause?.name === 'AbortError') {
          if (ngDevMode) console.warn(`[http] aborted ${req.method} ${req.url}${ridSuffix}`);
        } else if (err.status === 0) {
          console.error(`[http] network ${req.method} ${req.url}${ridSuffix}`, err.message || '');
        } else if (err.status >= 500) {
          console.error(`[http] ${err.status} ${req.method} ${req.url}${ridSuffix}`, ...(ngDevMode ? [cause] : []));
        } else {
          console.warn(`[http] ${err.status} ${req.method} ${req.url}${ridSuffix}`);
        }
      } else if (ngDevMode) {
        console.error(`[http] error ${req.method} ${req.url}${ridSuffix}`, err);
      }
      throw err;
    }),
    finalize(() => {
      if (ngDevMode && !settled) {
        console.warn(`[http] cancelled ${req.method} ${req.url}${ridSuffix}`);
      }
    }),
  );
};
