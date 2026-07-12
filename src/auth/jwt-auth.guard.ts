import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../common/public.decorator.js';

/**
 * Global authentication guard, registered as `APP_GUARD` in `AuthModule`. Every route is authenticated
 * by default; a handler/controller opts out with `@Public()` (read via Reflector.getAllAndOverride over
 * `[handler, class]`, so a class-level `@Public()` covers every method on it). Secure-by-default: a route
 * added without any decorator is authenticated, never silently public — closing the "forgot @UseGuards"
 * structural risk flagged in docs/backend-review-followups.md.
 *
 * Public routes that carry another auth mechanism (admin JWT / s2s signature / notification token) are
 * marked `@Public()` so this guard skips them and their own route-scoped guard runs instead.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
