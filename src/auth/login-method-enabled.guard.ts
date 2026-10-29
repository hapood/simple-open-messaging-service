import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  isLoginMethodEnabled,
  LoginMethod,
} from '../config/public-config.js';

/**
 * Builds a guard that rejects a login route BEFORE its credential work runs, whenever the given method is
 * disabled in `PUBLIC_CONFIG` (advertised via GET /config). Server-side counterpart of the grayed-out
 * login tab: UI disablement is a hint, this is the wall — a disabled method must be unusable even by a
 * raw HTTP client.
 *
 * Failing fast also avoids the expensive credential verification (argon2 / code lookup) on a method
 * nobody can succeed at, and leaks no signal — every request gets `LOGIN_METHOD_DISABLED` regardless of
 * the supplied credentials. Order it BEFORE any credential guard in `@UseGuards(...)`.
 *
 * Mixin factory (per-method class) because `@UseGuards(Class)` instantiates without constructor args.
 * Has no dependencies, so Nest instantiates it without provider registration (like the other guards used
 * via `@UseGuards(...)`).
 */
export function loginMethodEnabledGuard(method: LoginMethod) {
  @Injectable()
  class LoginMethodEnabledGuard implements CanActivate {
    canActivate(_context: ExecutionContext): boolean {
      void _context;
      if (!isLoginMethodEnabled(method)) {
        throw new BusinessException(
          BusinessCode.LOGIN_METHOD_DISABLED,
          `${method} login is disabled`,
        );
      }
      return true;
    }
  }
  return LoginMethodEnabledGuard;
}
