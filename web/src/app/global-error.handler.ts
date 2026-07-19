import { ErrorHandler, Injectable } from '@angular/core';

/**
 * Global sink for errors Angular itself couldn't route to a local handler — uncaught exceptions thrown
 * inside Angular-managed callbacks (event bindings, template expressions, lifecycle hooks, change
 * detection). The DEFAULT `ErrorHandler` already `console.error`s these; this subclass only adds a
 * greppable `[angular]` prefix so they read as one consistent, attributable family alongside HTTP
 * failures (`[http]`, logged by `httpTraceInterceptor`) and raw promise/script errors (`[unhandled]`,
 * the window listeners installed in `main.ts`).
 *
 * The three surfaces are DISJOINT — no double-logging:
 *  - HTTP request failures never reach here (the interceptor logs + rethrows; a 401 is consumed by
 *    `AuthInterceptor` as `EMPTY` before it can become an Angular error).
 *  - Angular-consumed errors do NOT re-fire `window.onerror` (Angular calls `handleError` INSTEAD of
 *    letting them propagate), so the `main.ts` `error` listener won't re-log what this logs.
 *
 * Logs ONLY — never swallows, never rethrows. Registered via `{ provide: ErrorHandler, useClass: ... }`
 * in `app.config.ts`. The default also prints an "ORIGINAL ERROR" cause chain; modern consoles render
 * `error.cause` equivalently, so the prefix swap loses nothing.
 */
@Injectable()
export class GlobalErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    console.error('[angular] unhandled error:', error);
  }
}
