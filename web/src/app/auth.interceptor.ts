import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse, } from '@angular/common/http';
import { Subject, Observable, catchError, switchMap, filter, take } from 'rxjs';
import { AuthService } from './services/auth.service';
import { PopupService, PopupType } from './services/popup.service';
import { LoginEvent } from './components/login/login.component';
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  private isRefreshing = false;
  private newTokenSubject: Subject<any> = new Subject<string>();

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

      const token = this.authService.getRefreshToken();

      if (token)
        return this.authService.renewAccessToken().pipe(
          switchMap((newToken: any) => {
            this.isRefreshing = false;
            this.newTokenSubject.next(newToken)
            return next.handle(this.addTokenHeader(request, newToken));
          }),
          catchError((err) => {
            this.isRefreshing = false;
            this.authService.clearToken();
            let subject = new Subject<{ event: LoginEvent }>();
            subject.subscribe(() => {
              const newToken = this.authService.getToken() as string
              this.newTokenSubject.next(newToken)
              return next.handle(this.addTokenHeader(request, newToken));
            })
            this.popupService.subject.next({
              isShow: true,
              popupType: PopupType.LOGIN,
              subject
            })
            throw err;
          })
        );
    }

    return this.newTokenSubject.pipe(
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