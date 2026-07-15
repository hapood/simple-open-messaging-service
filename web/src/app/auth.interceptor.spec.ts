import { HttpRequest, HttpHandler, HttpErrorResponse, HttpEvent } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { AuthInterceptor } from './auth.interceptor';
import { AuthService } from './services/auth.service';

/**
 * AuthInterceptor — the single session-token auth path.
 *
 * Pure unit (AuthInterceptor + a stub AuthService, no TestBed):
 *  - a protected request with a held session token → that token is attached as Bearer;
 *  - a public path (login/logout/register/health) → no token attached;
 *  - no session token held → the request goes out unauthenticated (the server 401s → re-login);
 *  - a 401 on a protected request → redoLoginAuth fires and the request is DROPPED (EMPTY), not retried;
 *  - a non-401 error propagates unchanged.
 */
describe('AuthInterceptor (session token)', () => {
  /** Build an interceptor around a stub AuthService with the given token state. */
  function makeInterceptor(sessionToken: string | null) {
    const auth = {
      sessionToken,
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

  it('attaches the held session token to a protected request', () => {
    const { ic } = makeInterceptor('sess-123');
    const req = new HttpRequest('GET', '/api/v1/messages', {});
    expect(captureHandled(ic, req).headers.get('Authorization')).toBe('Bearer sess-123');
  });

  it('does NOT attach a token to a public path (login)', () => {
    const { ic } = makeInterceptor('sess-123');
    const req = new HttpRequest('POST', '/api/v1/auth/login', {});
    expect(captureHandled(ic, req).headers.has('Authorization')).toBe(false);
  });

  it('sends an unauthenticated request when no session token is held', () => {
    const { ic } = makeInterceptor(null);
    const req = new HttpRequest('GET', '/api/v1/messages', {});
    expect(captureHandled(ic, req).headers.has('Authorization')).toBe(false);
  });

  it('a 401 fires redoLoginAuth and DROPS the request (no renew-retry)', () => {
    const { ic, auth } = makeInterceptor('sess-123');
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
    const { ic, auth } = makeInterceptor('sess-123');
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
