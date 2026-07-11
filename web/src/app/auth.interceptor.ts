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
 * 公开端点（无需 token、不参与 401 重试）：auth 相关 + 用户注册（注册在 /user/register，登录前可用）+
 * 健康检查（GET /health，server-config 连接检测 + 将来主界面的连接状态条都可能用到）。
 * 原 `Authorization: 'public'` header 标记已废——改用 URL 路径白名单（声明式、无歧义）。
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
   * 取得当前 access token：
   * - 有 → 直接用；
   * - 无（启动期/renew 进行中）→ 主动驱动 renewAccessToken（内部单飞，并发请求共享同一刷新），
   *   成功取新 token；失败(reuse/invalid)→renew 内已 redoLoginAuth→此处 EMPTY 放弃该请求（页面已跳登录）。
   * 关键：不「等 acTkSub 推非空」——renewAccessToken 有确定终点，故不会永挂。
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
   * 401 重试：renew 一次，用新 token 把原请求重发一次（上限 1 次，不递归→不死循环）。
   * renew 失败→EMPTY 放弃（renew 内已 redoLoginAuth）。
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
