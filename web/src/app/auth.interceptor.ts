import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse, } from '@angular/common/http';
import { BehaviorSubject, Observable, catchError, switchMap, filter, take } from 'rxjs';
import { AuthService } from './services/auth.service';
import { PopupService, PopupType } from './services/popup.service';
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private isRefreshing = false;
  private refreshTokenSubject: BehaviorSubject<any> = new BehaviorSubject<any>(null);

  constructor(private authService: AuthService, private popupService: PopupService) { }

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<Object>> {
    let authReq = req;
    const token = this.authService.getToken();
    if (token != null) {
      authReq = this.addTokenHeader(req, token);
    }

    return next.handle(authReq).pipe(catchError(error => {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        return this.handle401Error(authReq, next);
      }

      throw error;
    }));
  }

  private handle401Error(request: HttpRequest<any>, next: HttpHandler) {
    if (!this.isRefreshing) {
      this.isRefreshing = true;
      this.refreshTokenSubject.next(null);

      const token = this.authService.getRefreshToken();

      if (token)
        return this.authService.refreshToken(token).pipe(
          switchMap((newToken: any) => {
            this.isRefreshing = false;

            this.authService.saveToken(newToken.accessToken);
            this.refreshTokenSubject.next(newToken.accessToken);

            return next.handle(this.addTokenHeader(request, newToken.accessToken));
          }),
          catchError((err) => {
            this.isRefreshing = false;
            this.authService.logOut();
            throw err;
          })
        );
    }

    return this.refreshTokenSubject.pipe(
      filter(token => token !== null),
      take(1),
      switchMap((token) => next.handle(this.addTokenHeader(request, token)))
    );
  }

  private addTokenHeader(request: HttpRequest<any>, token: string) {
    return request.clone({
      setHeaders: {
        Authorization: 'Bearer ' + token
      }
    });
  }
}