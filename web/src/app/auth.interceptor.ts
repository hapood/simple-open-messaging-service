import { Injectable } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent,
  HttpErrorResponse,
} from '@angular/common/http';
import { Observable, EMPTY, throwError, catchError, defer, tap } from 'rxjs';
import { AuthService } from './services/auth.service';
import { SessionLifecycleService } from './services/session-lifecycle.service';
import { AUTHENTICATION_REQUEST } from './request-context';

/**
 * Session-auth error handling for the HTTP pipeline. The session credential itself is NO LONGER attached
 * here: under the Tauri shell the Rust `api_request` transport injects `Authorization: Bearer` from its
 * held `ProxyState.token` (JS never touches the token), and in the browser the httpOnly session cookie
 * auto-attaches same-origin. A 401 means the session is revoked/expired → {@link AuthService.redoLoginAuth}
 * (re-login); the failed request is dropped (the page navigates to login).
 */
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(
    private authService: AuthService,
    private readonly lifecycle: SessionLifecycleService,
  ) {}

  intercept(
    req: HttpRequest<any>,
    next: HttpHandler,
  ): Observable<HttpEvent<Object>> {
    return defer(() => {
      const owner = this.lifecycle.accountEpoch;
      return next.handle(req).pipe(
        tap(() => this.lifecycle.assertCurrent(owner)),
        catchError((error) => {
          // Check before handling 401: an old request must not log out its successor.
          this.lifecycle.assertCurrent(owner);
          return req.context.get(AUTHENTICATION_REQUEST)
            ? throwError(() => error)
            : this.on401(error);
        }),
      );
    });
  }

  /** A 401 = the session is revoked/expired (there is no renew). Re-login + drop the request so the
   *  caller's subscriber sees nothing (the page has navigated to login). Non-401 errors propagate. */
  private on401(error: unknown): Observable<HttpEvent<Object>> {
    if (error instanceof HttpErrorResponse && error.status === 401) {
      this.authService.redoLoginAuth();
      return EMPTY;
    }
    return throwError(() => error);
  }
}
