import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../common/public.decorator.js';
import { BearerAuthService } from './bearer-auth.service.js';

/** Extract the token from an `Authorization: Bearer <token>` header, case-insensitive. */
function extractBearer(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(header);
  return match ? match[1] : undefined;
}

/**
 * Global authentication guard, registered as `APP_GUARD` in `AuthModule`. Every route is authenticated
 * by default; a handler/controller opts out with `@Public()` (read via Reflector.getAllAndOverride over
 * `[handler, class]`, so a class-level `@Public()` covers every method on it). Secure-by-default: a route
 * added without any decorator is authenticated, never silently public — closing the "forgot @UseGuards"
 * structural risk.
 *
 * Accepts EITHER credential via {@link BearerAuthService.resolve}: a stateless access JWT (legacy, still
 * issued during the transition) OR a long-lived opaque session token (native app + web). Public routes
 * that carry another auth mechanism (admin JWT / s2s signature / notification token) are marked
 * `@Public()` so this guard skips them and their own route-scoped guard runs instead.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
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
      ip?: string;
      user?: { userId: number; sessionId: number | null };
    }>();
    const raw = extractBearer(req.headers['authorization']);
    // Thread the request IP so a validated session token refreshes its lastSeenIp/lastSeenAt (the
    // device-list "last active" + location) on the throttled activity write.
    const principal = await this.bearerAuth.resolve(raw, { ip: req.ip });
    if (!principal) {
      throw new UnauthorizedException('unauthenticated');
    }
    req.user = { userId: principal.userId, sessionId: principal.sessionId };
    return true;
  }
}
