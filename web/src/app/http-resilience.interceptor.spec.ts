import type { Mock } from 'vitest';
import {
  HttpErrorResponse,
  HttpContext,
  HttpEvent,
  HttpHandlerFn,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Observable, Subject, defer, of, throwError } from 'rxjs';
import {
  httpResilienceInterceptor,
  HTTP_RETRY_CONFIG,
} from './http-resilience.interceptor';
import { ToastService } from './services/toast.service';
import { BusinessCode } from './services/biz-code';
import { TranslocoService } from '@jsverse/transloco';
import {
  SUPPRESS_HTTP_ERROR_TOAST,
  REQUEST_SCOPE,
  RequestScope,
} from './request-context';
import { SessionLifecycleService } from './services/session-lifecycle.service';
import { SessionSupersededError } from './services/session/session-identity';

/**
 * httpResilienceInterceptor — 429 burst rate-limit backoff-retry + 5xx/network degraded-notice.
 *
 * Retry safety: a 429 from ThrottleGuard (code 10005) is a pre-handler rejection (the guard runs before
 * the route), so no side effect occurred and retrying even a non-idempotent POST is safe. The config's
 * `retryDelay` is a function; the test provides a SYNCHRONOUS emitter (`of(0)`) so the retry chain runs to
 * completion within the synchronous subscribe — no fakeAsync/tick (the app is zoneless). Pure unit via
 * TestBed.runInInjectionContext (the interceptor injects ToastService + TranslocoService + the config).
 */
describe('httpResilienceInterceptor (429 retry + 5xx/network surface)', () => {
  let warnSpy: Mock;
  let nextCalls: number;

  beforeEach(() => {
    warnSpy = vi.fn().mockName('warn');
    nextCalls = 0;
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        // Synchronous retryDelay → the retry loop completes within the subscribe() call.
        {
          provide: HTTP_RETRY_CONFIG,
          useValue: { maxRetries: 4, retryDelay: () => of(0) },
        },
        { provide: ToastService, useValue: { warn: warnSpy } },
        {
          provide: TranslocoService,
          useValue: { translate: (k: string) => k },
        },
      ],
    });
  });

  /** Model a cold backend observable; each attempt advances the response queue. */
  function nextQueue(obs: Observable<HttpEvent<unknown>>[]): HttpHandlerFn {
    let i = 0;
    return () =>
      defer(() => {
        nextCalls++;
        return obs[Math.min(i++, obs.length - 1)];
      });
  }

  const req = (context?: HttpContext): HttpRequest<unknown> =>
    new HttpRequest('POST', '/api/v1/send-message', {}, { context });

  const err = (status: number, errorBody?: unknown): HttpErrorResponse =>
    new HttpErrorResponse({
      status,
      url: '/api/v1/send-message',
      error: errorBody,
    });

  /** Run the interceptor and capture the synchronous result/error (retryDelay is synchronous). */
  function run(
    nextFn: HttpHandlerFn,
    request = req(),
  ): {
    result?: HttpEvent<unknown>;
    err?: HttpErrorResponse;
  } {
    const state: {
      result?: HttpEvent<unknown>;
      err?: HttpErrorResponse;
    } = {};
    TestBed.runInInjectionContext(() =>
      httpResilienceInterceptor(request, nextFn),
    ).subscribe({
      next: (v) => (state.result = v),
      error: (e) => (state.err = e),
    });
    return state;
  }

  it('delivers server results after a session transition', () => {
    const response = new Subject<HttpEvent<unknown>>();
    const context = new HttpContext().set(REQUEST_SCOPE, RequestScope.Server);
    const next = vi.fn();
    const error = vi.fn();
    TestBed.runInInjectionContext(() =>
      httpResilienceInterceptor(req(context), () => response),
    ).subscribe({ next, error });
    TestBed.inject(SessionLifecycleService).invalidateSession();
    const result = new HttpResponse({ body: { ok: true } });
    response.next(result);
    expect(next).toHaveBeenCalledWith(result);
    expect(error).not.toHaveBeenCalled();
  });

  it('allows an independent retry after a session transition during backoff', () => {
    const backoff = new Subject<void>();
    TestBed.overrideProvider(HTTP_RETRY_CONFIG, {
      useValue: { maxRetries: 1, retryDelay: () => backoff },
    });
    const context = new HttpContext().set(REQUEST_SCOPE, RequestScope.Server);
    const next = vi.fn();
    TestBed.runInInjectionContext(() =>
      httpResilienceInterceptor(
        req(context),
        nextQueue([
          throwError(() => err(429, { code: BusinessCode.RATE_LIMITED })),
          of(new HttpResponse({ body: { ok: true } })),
        ]),
      ),
    ).subscribe(next);
    TestBed.inject(SessionLifecycleService).invalidateSession();
    backoff.next();
    expect(nextCalls).toBe(2);
    expect(next).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('surfaces independent server failures after a session transition', () => {
    const response = new Subject<HttpEvent<unknown>>();
    const context = new HttpContext().set(REQUEST_SCOPE, RequestScope.Server);
    const error = vi.fn();
    TestBed.runInInjectionContext(() =>
      httpResilienceInterceptor(req(context), () => response),
    ).subscribe({ error });
    TestBed.inject(SessionLifecycleService).invalidateSession();
    const failure = err(500);
    response.error(failure);
    expect(error).toHaveBeenCalledWith(failure);
    expect(warnSpy).toHaveBeenCalledWith('errors.serverError');
  });

  it('passes a success through with no toast (single attempt)', () => {
    const s = run(
      nextQueue([of(new HttpResponse({ status: 200, body: { ok: true } }))]),
    );
    expect(s.result).toBeDefined();
    expect(s.err).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(nextCalls).toBe(1);
  });

  it('retries a burst rate-limit (429 / code 10005) with backoff and succeeds', () => {
    const e429 = err(429, {
      code: BusinessCode.RATE_LIMITED,
      message: 'too many requests',
    });
    const s = run(
      nextQueue([
        throwError(() => e429),
        throwError(() => e429),
        of(new HttpResponse({ status: 200, body: { ok: true } })),
      ]),
    );
    expect(s.result).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled(); // intermediate 429s during retry are NOT surfaced
    expect(nextCalls).toBe(3);
  });

  it('gives up after max retries and surfaces the final 429 as a degraded toast', () => {
    const e429 = err(429, {
      code: BusinessCode.RATE_LIMITED,
      message: 'too many requests',
    });
    const s = run(nextQueue([throwError(() => e429)]));
    expect(s.err).toBe(e429);
    expect(nextCalls).toBe(5); // 1 initial + 4 retries
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('errors.biz.rateLimited');
  });

  it('does NOT retry a 5xx (side-effect unknown) — surfaces immediately, single attempt', () => {
    const e500 = err(500, { code: BusinessCode.INTERNAL });
    const s = run(nextQueue([throwError(() => e500)]));
    expect(s.err).toBe(e500);
    expect(nextCalls).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith('errors.serverError');
  });

  it('does NOT surface a 401 (AuthInterceptor owns re-login) — passes through, single attempt', () => {
    const e401 = err(401, { code: BusinessCode.UNAUTHENTICATED });
    const s = run(nextQueue([throwError(() => e401)]));
    expect(s.err).toBe(e401);
    expect(nextCalls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('surfaces a network drop (status 0) as the network-error toast', () => {
    const e0 = err(0);
    const s = run(nextQueue([throwError(() => e0)]));
    expect(s.err).toBe(e0);
    expect(warnSpy).toHaveBeenCalledWith('errors.networkError');
  });

  it('does not toast when a persistent caller owns the network error UI', () => {
    const e0 = err(0);
    const request = req(new HttpContext().set(SUPPRESS_HTTP_ERROR_TOAST, true));
    const s = run(nextQueue([throwError(() => e0)]), request);
    expect(s.err).toBe(e0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([0, 429, 500])(
    'does not toast or retry an obsolete %i response',
    (status) => {
      const response = new Subject<HttpEvent<unknown>>();
      const state = run(nextQueue([response]));
      TestBed.inject(SessionLifecycleService).invalidateSession();
      response.error(err(status, { code: BusinessCode.RATE_LIMITED }));
      expect(state.err).toBeInstanceOf(SessionSupersededError);
      expect(nextCalls).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  it('does not dispatch a retry when its owner expires during backoff', () => {
    const delay = new Subject<number>();
    TestBed.overrideProvider(HTTP_RETRY_CONFIG, {
      useValue: { maxRetries: 4, retryDelay: () => delay },
    });
    const state = run(
      nextQueue([
        throwError(() => err(429, { code: BusinessCode.RATE_LIMITED })),
        of(new HttpResponse({ status: 200 })),
      ]),
    );
    expect(nextCalls).toBe(1);
    TestBed.inject(SessionLifecycleService).invalidateSession();
    delay.next(0);
    expect(nextCalls).toBe(1);
    expect(state.err).toBeInstanceOf(SessionSupersededError);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT retry a 429 that is NOT the burst rate-limit (e.g. federation quota 50011)', () => {
    // 50011 is a day-level quota (not transient) carried as HTTP 429; it must surface, not retry.
    const e429 = err(429, {
      code: BusinessCode.FEDERATION_QUOTA_EXCEEDED,
      message: 'federation quota',
    });
    const s = run(nextQueue([throwError(() => e429)]));
    expect(s.err).toBe(e429);
    expect(nextCalls).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith('errors.biz.federationQuotaExceeded');
  });
});
