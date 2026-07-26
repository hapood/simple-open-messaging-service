import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC, IS_MUST_CHANGE_PASSWORD_ESCAPE_HATCH } from '../common/public.decorator.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { BearerAuthService } from './bearer-auth.service.js';
import { extractBearer } from './bearer.js';
import { MEDIA_TOKEN_COOKIE } from './media-token.js';

/**
 * Global authentication guard, registered as `APP_GUARD` in `AuthModule`. Every route is authenticated
 * by default; a handler/controller opts out with `@Public()` (read via Reflector.getAllAndOverride over
 * `[handler, class]`, so a class-level `@Public()` covers every method on it). Secure-by-default: a route
 * added without any decorator is authenticated, never silently public — closing the "forgot @UseGuards"
 * structural risk.
 *
 * Resolves the opaque session token via {@link BearerAuthService.resolve}, reading it **cookie-first**:
 * the httpOnly `media_token` cookie (auto-attached same-origin on the browser), falling back to an
 * `Authorization: Bearer` header (native clients + the desktop SSE worker, which can't use a cookie).
 * This mirrors the `/uploads/*` validator in `bootstrap.ts`, so every route honors the same credential.
 * Public routes that carry another auth mechanism (admin JWT / s2s signature) are marked `@Public()` so
 * this guard skips them and their own route-scoped guard runs.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly bearerAuth: BearerAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
      cookies?: Record<string, string | undefined>;
      ip?: string;
      user?: { userId: number; sessionId: number | null; mustChangePassword: boolean };
    }>();
    // Cookie-first (httpOnly media_token), Bearer fallback — same resolution as the /uploads/* validator.
    const fromCookie = req.cookies?.[MEDIA_TOKEN_COOKIE];
    const raw = fromCookie ?? extractBearer(req.headers['authorization']);
    // Thread the request IP so a validated session token refreshes its lastSeenIp/lastSeenAt (the
    // device-list "last active" + location) on the throttled activity write.
    const principal = await this.bearerAuth.resolve(raw, { ip: req.ip });
    if (!principal) {
      throw new UnauthorizedException('unauthenticated');
    }
    req.user = {
      userId: principal.userId,
      sessionId: principal.sessionId,
      mustChangePassword: principal.mustChangePassword,
    };
    // Forced-password-change gate: a user whose password is still the admin-generated INITIAL value
    // (mustChangePassword) may NOT use the app until they set their own — every authenticated route is
    // rejected with MUST_CHANGE_PASSWORD except the escape hatch (auth/set-password + logout-all; logout
    // is already @Public). This is the SERVER enforcement of "can't keep using the initial password": the
    // frontend set-password screen is only the UX, this gate is the security boundary, and it is
    // login-method-agnostic (password/OTP/QR sessions all hit it). The flag rides the session-token
    // validation entry; setPassword deletes that entry so the cleared flag is re-read from the database
    // on the next request.
    if (principal.mustChangePassword) {
      const isEscapeHatch = this.reflector.getAllAndOverride<boolean>(
        IS_MUST_CHANGE_PASSWORD_ESCAPE_HATCH,
        [context.getHandler(), context.getClass()],
      );
      if (!isEscapeHatch) {
        throw new BusinessException(
          BusinessCode.MUST_CHANGE_PASSWORD,
          'password must be changed before continuing',
        );
      }
    }
    // Stash the cookie for SessionCookieInterceptor to re-issue (keeps this guard a pure auth decision:
    // it returns/throws; the interceptor mutates the response). Only PERSISTENT web/desktop sessions that
    // slid this call; session cookies live for the browser session already, native/Bearer carry no cookie,
    // app tokens never slide.
    if (principal.slid && principal.persistent && fromCookie) {
      (req as { sessionSlideToken?: string }).sessionSlideToken = fromCookie;
    }
    return true;
  }
}
