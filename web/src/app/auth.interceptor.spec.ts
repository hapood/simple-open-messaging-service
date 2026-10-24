import {
  HttpRequest,
  HttpContext,
  HttpHandler,
  HttpErrorResponse,
  HttpEvent,
} from '@angular/common/http';
import { Observable, Subject, of, throwError } from 'rxjs';
import { AuthInterceptor } from './auth.interceptor';
import { AuthService } from './services/auth.service';
import { SessionLifecycleService } from './services/session-lifecycle.service';
import { SessionSupersededError } from './services/session/session-identity';
import { REQUEST_SCOPE, RequestScope } from './request-context';

/**
 * AuthInterceptor — the session-auth ERROR handler (401 → re-login).
 *
 * The session credential is NO LONGER attached here: under the Tauri shell the Rust `api_request`
 * transport injects `Authorization: Bearer` from its held `ProxyState.token` (JS never touches the token),
 * and in the browser the httpOnly session cookie auto-attaches same-origin. Responses are bound to
 * their originating login lifetime. Only a current 401 can trigger re-login; obsolete responses
 * produce a typed session-superseded error.
 *
 * Pure unit (AuthInterceptor + a stub AuthService, no TestBed):
 *  - a protected request passes through UNCHANGED (no header added by the interceptor — auth is the
 *    transport's job, not this layer's);
 *  - a 401 fires redoLoginAuth and DROPS the request (EMPTY), not retried;
 *  - a non-401 error propagates unchanged.
 */
describe('AuthInterceptor (401 → re-login)', () => {
  /** Build an interceptor around a stub AuthService (only redoLoginAuth is exercised). */
  function makeInterceptor() {
    const auth = {
      redoLoginAuth: vi.fn().mockName('redoLoginAuth'),
    } as unknown as AuthService;
    const lifecycle = new SessionLifecycleService();
    return { ic: new AuthInterceptor(auth, lifecycle), auth, lifecycle };
  }

  /** Run the interceptor against `req` and capture the request handed to the handler. */
  function captureHandled(
    ic: AuthInterceptor,
    req: HttpRequest<unknown>,
  ): HttpRequest<unknown> {
    let captured: HttpRequest<unknown> | null = null;
    const next: HttpHandler = {
      handle: (r: HttpRequest<unknown>): Observable<HttpEvent<unknown>> => {
        captured = r;
        return of({} as HttpEvent<unknown>);
      },
    };
    ic.intercept(req, next).subscribe();
    return captured!;
  }

  it("passes a request through UNCHANGED (auth is the transport layer's job, not this interceptor's)", () => {
    const { ic } = makeInterceptor();
    const req = new HttpRequest('GET', '/api/v1/messages', {});
    const handled = captureHandled(ic, req);
    // No Authorization header is added here — under Tauri the Rust `api_request` IPC injects the Bearer;
    // in the browser the httpOnly cookie auto-attaches. The interceptor must not duplicate that.
    expect(handled.headers.has('Authorization')).toBe(false);
    expect(handled.url).toBe('/api/v1/messages');
  });

  it('a 401 fires redoLoginAuth and DROPS the request (no renew-retry)', () => {
    const { ic, auth } = makeInterceptor();
    const req = new HttpRequest('GET', '/api/v1/messages', {});
    const next: HttpHandler = {
      handle: () => throwError(() => new HttpErrorResponse({ status: 401 })),
    };
    let nexted = false,
      errored = false,
      completed = false;
    ic.intercept(req, next).subscribe({
      next: () => (nexted = true),
      error: () => (errored = true),
      complete: () => (completed = true),
    });
    expect(auth.redoLoginAuth).toHaveBeenCalledTimes(1);
    expect(nexted).toBe(false);
    expect(errored).toBe(false); // EMPTY → complete, not propagated
    expect(completed).toBe(true);
  });

  it.each([401, 500])(
    'rejects an old %i without logging out the successor',
    (status) => {
      const { ic, auth, lifecycle } = makeInterceptor();
      const response = new Subject<HttpEvent<unknown>>();
      const error = vi.fn();
      ic.intercept(new HttpRequest('GET', '/api/v1/messages'), {
        handle: () => response,
      }).subscribe({ error });
      lifecycle.invalidateSession();
      response.error(new HttpErrorResponse({ status }));
      expect(error).toHaveBeenCalledWith(expect.any(SessionSupersededError));
      expect(auth.redoLoginAuth).not.toHaveBeenCalled();
    },
  );

  it('rejects old successful responses before delivering them downstream', () => {
    const { ic, lifecycle } = makeInterceptor();
    const response = new Subject<HttpEvent<unknown>>();
    const next = vi.fn();
    const error = vi.fn();
    ic.intercept(new HttpRequest('GET', '/api/v1/messages'), {
      handle: () => response,
    }).subscribe({ next, error });
    lifecycle.invalidateSession();
    response.next({} as HttpEvent<unknown>);
    expect(next).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.any(SessionSupersededError));
  });

  it('binds the lifetime at subscription rather than observable construction', () => {
    const { ic, lifecycle } = makeInterceptor();
    const handled = vi.fn(() => of({} as HttpEvent<unknown>));
    const request = ic.intercept(new HttpRequest('GET', '/api/v1/messages'), {
      handle: handled,
    });
    lifecycle.invalidateSession();
    const next = vi.fn();
    request.subscribe(next);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lets authentication own a current 401 without global re-login', () => {
    const { ic, auth } = makeInterceptor();
    const failure = new HttpErrorResponse({ status: 401 });
    const error = vi.fn();
    const context = new HttpContext().set(
      REQUEST_SCOPE,
      RequestScope.Authentication,
    );
    ic.intercept(
      new HttpRequest('POST', '/api/v1/auth/login', {}, { context }),
      {
        handle: () => throwError(() => failure),
      },
    ).subscribe({ error });
    expect(error).toHaveBeenCalledWith(failure);
    expect(auth.redoLoginAuth).not.toHaveBeenCalled();
  });

  it('still rejects obsolete authentication responses', () => {
    const { ic, auth, lifecycle } = makeInterceptor();
    const response = new Subject<HttpEvent<unknown>>();
    const error = vi.fn();
    const context = new HttpContext().set(
      REQUEST_SCOPE,
      RequestScope.Authentication,
    );
    ic.intercept(
      new HttpRequest('POST', '/api/v1/auth/login', {}, { context }),
      {
        handle: () => response,
      },
    ).subscribe({ error });
    lifecycle.invalidateSession();
    response.error(new HttpErrorResponse({ status: 401 }));
    expect(error).toHaveBeenCalledWith(expect.any(SessionSupersededError));
    expect(auth.redoLoginAuth).not.toHaveBeenCalled();
  });

  it.each([200, 401, 500])(
    'delivers an independent response (%i) across session transitions without re-login',
    (status) => {
      const { ic, auth, lifecycle } = makeInterceptor();
      const response = new Subject<HttpEvent<unknown>>();
      const next = vi.fn();
      const error = vi.fn();
      const context = new HttpContext().set(REQUEST_SCOPE, RequestScope.Server);
      ic.intercept(new HttpRequest('GET', '/api/v1/config', { context }), {
        handle: () => response,
      }).subscribe({ next, error });
      lifecycle.invalidateSession();
      if (status === 200) {
        const event = {} as HttpEvent<unknown>;
        response.next(event);
        expect(next).toHaveBeenCalledWith(event);
        expect(error).not.toHaveBeenCalled();
      } else {
        const failure = new HttpErrorResponse({ status });
        response.error(failure);
        expect(error).toHaveBeenCalledWith(failure);
      }
      expect(auth.redoLoginAuth).not.toHaveBeenCalled();
    },
  );

  it('a non-401 error propagates unchanged (no re-login)', () => {
    const { ic, auth } = makeInterceptor();
    const req = new HttpRequest('GET', '/api/v1/messages', {});
    const next: HttpHandler = {
      handle: () => throwError(() => new HttpErrorResponse({ status: 500 })),
    };
    let errored = false;
    ic.intercept(req, next).subscribe({ error: () => (errored = true) });
    expect(auth.redoLoginAuth).not.toHaveBeenCalled();
    expect(errored).toBe(true);
  });
});
