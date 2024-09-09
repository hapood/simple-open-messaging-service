import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse, } from '@angular/common/http';
import { Observable, catchError, switchMap, filter, take, } from 'rxjs';
import { AuthService } from './services/auth.service';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {

  constructor(private authService: AuthService) { }

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<Object>> {
    let authReq = req;
    console.log(req)
    if (req.headers.get('Authorization') !== 'public') {
      return this.authService.acTkSub.pipe(filter(data => data !== undefined),
        take(1),
        switchMap(({ lastToken, nextToken }) => {
          const oldAuth = req.headers.get('Authorization')
          if (oldAuth !== null && oldAuth !== 'Bearer ' + lastToken) {
            throw new Error('obsolete http request')
          }
          authReq = this.addTokenHeader(req, nextToken);
          return next.handle(authReq).pipe(catchError(error => {
            if (error instanceof HttpErrorResponse && error.status === 401) {
              return this.handle401Error(authReq, next);
            } else {
              throw error;
            }
          }));
        }))
    } else {
      //with out auth
      return next.handle(req)
    }
  }

  private handle401Error(request: HttpRequest<any>, next: HttpHandler) {
    this.authService.renewAccessToken()
    return next.handle(request)
  }

  private addTokenHeader(request: HttpRequest<any>, token: string) {
    return request.clone({
      setHeaders: {
        Authorization: 'Bearer ' + token
      }
    });
  }
}