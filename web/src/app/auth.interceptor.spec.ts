import { HttpRequest, HttpHandler, HttpErrorResponse, HttpContext, HttpEvent } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { AuthInterceptor } from './auth.interceptor';
import { AuthService, USE_SESSION_TOKEN } from './services/auth.service';

/**
 * AuthInterceptor USE_SESSION_TOKEN branch — the device-management auth path.
 *
 * Locked down here (pure unit: AuthInterceptor instantiated with a stub AuthService, no TestBed):
 *  - a request flagged USE_SESSION_TOKEN + a held session token → that session token is attached;
 *  - the same flag with NO session token held → falls through to the access-JWT path (isCurrent=false);
 *  - an ordinary request (no flag) → the access-JWT path, unaffected;
 *  - a device-management 401 propagates (no session-token renew-retry, unlike the access-JWT path).
 */
describe('AuthInterceptor (USE_SESSION_TOKEN branch)', () => {
  /** Build an interceptor around a stub AuthService with the given token state. */
  function makeInterceptor(sessionToken: string | null, accessToken = 'access-jwt') {
    const auth = {
      sessionToken,
      accessToken,
      // The access-JWT path's renew fallback; tests that take that path always have accessToken set, so
      // this should never actually run — keep it as a failing spy to surface any drift.
      renewAccessToken: jasmine.createSpy('renewAccessToken'),
    } as unknown as AuthService;
    return new AuthInterceptor(auth);
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

  it('attaches the session token when USE_SESSION_TOKEN is set and one is held', () => {
    const ic = makeInterceptor('sess-123');
    const req = new HttpRequest('POST', '/api/v1/auth/sessions', {}, {
      context: new HttpContext().set(USE_SESSION_TOKEN, true),
    });
    expect(captureHandled(ic, req).headers.get('Authorization')).toBe('Bearer sess-123');
  });

  it('falls back to the access JWT when USE_SESSION_TOKEN is set but no session token is held', () => {
    const ic = makeInterceptor(null, 'access-jwt');
    const req = new HttpRequest('POST', '/api/v1/auth/sessions', {}, {
      context: new HttpContext().set(USE_SESSION_TOKEN, true),
    });
    expect(captureHandled(ic, req).headers.get('Authorization')).toBe('Bearer access-jwt');
  });

  it('uses the access jwt for an ordinary request (no USE_SESSION_TOKEN context)', () => {
    const ic = makeInterceptor('sess-123', 'access-jwt');
    const req = new HttpRequest('GET', '/api/v1/messages', {});
    expect(captureHandled(ic, req).headers.get('Authorization')).toBe('Bearer access-jwt');
  });

  it('propagates a 401 on a device-management call (no session-token renew-retry)', () => {
    const ic = makeInterceptor('sess-123');
    const req = new HttpRequest('POST', '/api/v1/auth/sessions', {}, {
      context: new HttpContext().set(USE_SESSION_TOKEN, true),
    });
    let errored = false;
    const next: HttpHandler = {
      handle: () => throwError(() => new HttpErrorResponse({ status: 401 })),
    };
    ic.intercept(req, next).subscribe({ error: () => (errored = true) });
    expect(errored).toBe(true);
  });
});
