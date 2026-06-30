import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse, } from '@angular/common/http';
import { Observable, EMPTY, catchError, switchMap, filter, take, } from 'rxjs';
import { AuthService } from './services/auth.service';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {

  constructor(private authService: AuthService) { }

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<Object>> {
    if (req.headers.get('Authorization') === 'public') {
      // 公开请求（login/register/renew/logout）不带 token
      return next.handle(req)
    }
    // 等拿到当前 access token 再发；renewAccessToken 期间 acTkSub 会 next(undefined) 暂停所有受保护请求
    return this.authService.acTkSub.pipe(
      filter(data => data !== undefined),
      take(1),
      switchMap(({ nextToken }) => {
        const authReq = this.addTokenHeader(req, nextToken)
        return next.handle(authReq).pipe(
          catchError((error) => {
            if (error instanceof HttpErrorResponse && error.status === 401) {
              return this.handle401Error(req, next)
            }
            throw error
          }),
        )
      }),
    )
  }

  /**
   * 401 处理：await renewAccessToken（内部单飞，并发 401 共享同一刷新请求），
   * 成功后用新 token 重试一次；失败(reuse/invalid) 时 renewAccessToken 已触发 redoLoginAuth，
   * 此处 EMPTY 放弃原请求（页面已跳登录）。
   * 不再用旧 token 重试（原 fire-and-forget bug），不再对 stale token throw（改为正常重试）。
   */
  private handle401Error(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<Object>> {
    return this.authService.renewAccessToken().pipe(
      switchMap((res) =>
        res.code === 0
          ? this.authService.acTkSub.pipe(filter(d => d !== undefined), take(1))
          : EMPTY,
      ),
      switchMap(({ nextToken }) => next.handle(this.addTokenHeader(req, nextToken))),
    )
  }

  private addTokenHeader(request: HttpRequest<any>, token: string) {
    return request.clone({
      setHeaders: {
        Authorization: 'Bearer ' + token
      }
    });
  }
}
