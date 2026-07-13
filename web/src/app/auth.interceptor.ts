import { Injectable } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent,
  HttpErrorResponse,
} from '@angular/common/http';
import { Observable, of, EMPTY, throwError, catchError, switchMap } from 'rxjs';
import { AuthService } from './services/auth.service';

/**
 * Public endpoints (no token required, excluded from 401 retry): auth-related + user registration
 * (at /user/register, usable before login) + health check (GET /health, used by the server-config
 * connection probe and potentially by a future main-screen connection banner).
 * The former `Authorization: 'public'` header marker is obsolete — replaced by a URL-path whitelist
 * (declarative, unambiguous).
 */
const PUBLIC_PATH = /\/(auth\/(login|renew-access|renew-refresh|logout)|user\/register|health)$/;

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private authService: AuthService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<Object>> {
    if (PUBLIC_PATH.test(req.url)) {
      return next.handle(req)
    }
    return this.withToken().pipe(
      switchMap((token) =>
        next.handle(this.addTokenHeader(req, token)).pipe(
          catchError((error) =>
            error instanceof HttpErrorResponse && error.status === 401
              ? this.retryOnce(req, next)
              : throwError(() => error),
          ),
        ),
      ),
    )
  }

  /**
   * Obtain the current access token:
   * - present → use it directly;
   * - absent (startup / renew in progress) → proactively drive renewAccessToken (internally single-flight;
   *   concurrent requests share the same refresh), yielding a fresh token on success; on failure (reuse/invalid)
   *   renew already triggered redoLoginAuth → return EMPTY here to drop the request (the page has navigated to login).
   * Key: never "wait for acTkSub to emit a non-empty value" — renewAccessToken has a definite endpoint, so it cannot hang forever.
   */
  private withToken(): Observable<string> {
    const cur = this.authService.accessToken
    if (cur) {
      return of(cur)
    }
    return this.authService.renewAccessToken().pipe(
      switchMap((res) => (res.code === 0 ? of(res.data!.access_token) : EMPTY)),
    )
  }

  /**
   * 401 retry: renew once, then re-send the original request with the new token (capped at 1 attempt, no recursion → no infinite loop).
   * Renew failure → EMPTY to drop the request (renew already triggered redoLoginAuth).
   */
  private retryOnce(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<Object>> {
    return this.authService.renewAccessToken().pipe(
      switchMap((res) => (res.code === 0 ? of(res.data!.access_token) : EMPTY)),
      switchMap((token) => next.handle(this.addTokenHeader(req, token))),
    )
  }

  private addTokenHeader(request: HttpRequest<any>, token: string) {
    return request.clone({
      setHeaders: {
        Authorization: 'Bearer ' + token,
      },
    });
  }
}
