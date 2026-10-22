import type { Mock } from 'vitest';
import {
  HttpErrorResponse,
  HttpEvent,
  HttpHandlerFn,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { httpTraceInterceptor } from './http-trace.interceptor';

/**
 * httpTraceInterceptor — HTTP failure visibility (logs-only, never handles).
 *
 * Pure unit (interceptor + a stub `HttpHandlerFn`, no TestBed). Asserts the severity mapping is correct
 * and that the interceptor LOGS ONLY — it rethrows every error so downstream (AuthInterceptor + the
 * caller) still see it. The cancel/abort trace is dev-build-only (`isDevMode()`), so those specs run under
 * Karma (dev) and would be folded away in a prod AOT build.
 */
describe('httpTraceInterceptor (HTTP failure visibility)', () => {
  let errorSpy: Mock;
  let warnSpy: Mock;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockReturnValue(undefined);
    warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  /** A functional next-handler that yields the given observable for any request. */
  function nextReturning(obs: Observable<HttpEvent<unknown>>): HttpHandlerFn {
    return () => obs;
  }

  const req = (): HttpRequest<unknown> =>
    new HttpRequest('GET', '/api/v1/messages', {});

  it('logs a 5xx failure to console.error and rethrows (does not swallow)', () => {
    const err = new HttpErrorResponse({ status: 503, url: '/api/v1/messages' });
    let errored = false;
    httpTraceInterceptor(req(), nextReturning(throwError(() => err))).subscribe(
      {
        error: () => (errored = true),
      },
    );
    expect(errored).toBe(true); // rethrown — the caller still sees it
    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(vi.mocked(errorSpy).mock.lastCall![0]).toContain('503');
  });

  it('logs a status-0 network failure to console.error', () => {
    const err = new HttpErrorResponse({ status: 0, url: '/api/v1/messages' });
    httpTraceInterceptor(req(), nextReturning(throwError(() => err))).subscribe(
      { error: () => {} },
    );
    expect(errorSpy).toHaveBeenCalled();
    expect(vi.mocked(errorSpy).mock.lastCall![0]).toContain('network');
  });

  it('logs a 4xx failure to console.warn (NOT error — business traffic)', () => {
    const err = new HttpErrorResponse({ status: 404, url: '/api/v1/messages' });
    httpTraceInterceptor(req(), nextReturning(throwError(() => err))).subscribe(
      { error: () => {} },
    );
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(vi.mocked(warnSpy).mock.lastCall![0]).toContain('404');
  });

  it('does NOT log a successful (2xx) request', () => {
    httpTraceInterceptor(
      req(),
      nextReturning(of(new HttpResponse({ status: 200 }))),
    ).subscribe();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('appends the X-Request-Id to the failure log when the request carries one', () => {
    // correlationIdInterceptor runs outer to this one and stamps the header; here we set it directly
    // to test the trace side in isolation.
    const idReq = new HttpRequest('GET', '/api/v1/messages', {}).clone({
      setHeaders: { 'X-Request-Id': 'abc-123' },
    });
    const err = new HttpErrorResponse({ status: 500, url: '/api/v1/messages' });
    httpTraceInterceptor(idReq, nextReturning(throwError(() => err))).subscribe(
      { error: () => {} },
    );
    expect(vi.mocked(errorSpy).mock.lastCall![0]).toContain('req=abc-123');
  });

  // --- dev-only trace (active under Karma's dev build; DCE'd in prod AOT) ---

  it('(dev) logs an AbortError as [http] aborted', () => {
    const cause = new DOMException('The user aborted a request.', 'AbortError');
    const err = new HttpErrorResponse({
      error: cause,
      url: '/api/v1/messages',
    });
    httpTraceInterceptor(req(), nextReturning(throwError(() => err))).subscribe(
      { error: () => {} },
    );
    expect(warnSpy).toHaveBeenCalled();
    expect(vi.mocked(warnSpy).mock.lastCall![0]).toContain('aborted');
  });

  it('(dev) logs a torn-down (unsubscribed-before-settle) request as [http] cancelled', () => {
    // A never-emitting source; unsubscribe before any settle → finalize with settled=false.
    const sub = httpTraceInterceptor(
      req(),
      nextReturning(new Observable<never>()),
    ).subscribe();
    sub.unsubscribe();
    expect(warnSpy).toHaveBeenCalled();
    expect(vi.mocked(warnSpy).mock.lastCall![0]).toContain('cancelled');
  });
});
