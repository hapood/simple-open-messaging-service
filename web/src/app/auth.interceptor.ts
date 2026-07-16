import { Injectable } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent,
  HttpErrorResponse,
} from '@angular/common/http';
import { Observable, EMPTY, throwError, catchError } from 'rxjs';
import { AuthService } from './services/auth.service';

/**
 * Public endpoints (no token required): auth-related + user registration (at /user/register, usable
 * before login) + health check (GET /health, used by the server-config connection probe). Declared as a
 * URL-path whitelist (unambiguous) — the former `Authorization: 'public'` header marker is obsolete.
 */
const PUBLIC_PATH = /\/(auth\/(login|renew-access|renew-refresh|logout)|user\/register|health)$/;

/**
 * Attaches the session credential to every non-public request. Native (Tauri): the raw token is held in
 * JS and sent as `Authorization: Bearer`. Browser (pure httpOnly): `sessionToken` is null — no header is
 * set, and the httpOnly session cookie auto-attaches same-origin. A 401 means the session is
 * revoked/expired → {@link AuthService.redoLoginAuth} (re-login); the failed request is dropped (the
 * page navigates to login).
 */
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private authService: AuthService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<Object>> {
    if (PUBLIC_PATH.test(req.url)) {
      return next.handle(req);
    }
    const token = this.authService.sessionToken;
    const authed = token ? this.addTokenHeader(req, token) : req;
    return next.handle(authed).pipe(catchError((error) => this.on401(error)));
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

  private addTokenHeader(request: HttpRequest<any>, token: string) {
    return request.clone({
      setHeaders: {
        Authorization: 'Bearer ' + token,
      },
    });
  }
}
