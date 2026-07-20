import { HttpRequest, HttpHandler, HttpErrorResponse, HttpEvent } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { AuthInterceptor } from './auth.interceptor';
import { AuthService } from './services/auth.service';

/**
 * AuthInterceptor — the session-auth ERROR handler (401 → re-login).
 *
 * The session credential is NO LONGER attached here: under the Tauri shell the Rust `api_request`
 * transport injects `Authorization: Bearer` from its held `ProxyState.token` (JS never touches the token),
 * and in the browser the httpOnly session cookie auto-attaches same-origin. So this interceptor is now a
 * pure pass-through whose only side-effect is reacting to a 401 (revoked/expired session) by re-logging in
 * and DROPPING the failed request.
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
      redoLoginAuth: jasmine.createSpy('redoLoginAuth'),
    } as unknown as AuthService;
    return { ic: new AuthInterceptor(auth), auth };
  }

  /** Run the interceptor against `req` and capture the request handed to the handler. */
  function captureHandled(ic: AuthInterceptor, req: HttpRequest<unknown>): HttpRequest<unknown> {
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

  it('passes a request through UNCHANGED (auth is the transport layer\'s job, not this interceptor\'s)', () => {
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
    let nexted = false, errored = false, completed = false;
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
