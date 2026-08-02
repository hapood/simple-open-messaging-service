import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  isPasswordLoginEnabled,
  PUBLIC_CONFIG,
} from '../config/public-config.js';

/**
 * Rejects password login BEFORE `LocalAuthGuard` runs the expensive argon2 verify + brute-force
 * bookkeeping, whenever password login is disabled under the current `loginMode` (APP_OTP_AND_QR).
 *
 * Failing fast avoids doing argon2 work on a method nobody can succeed at, and avoids leaking any
 * credential signal — every request gets `LOGIN_METHOD_DISABLED` regardless of the supplied credentials.
 * Order this guard BEFORE `LocalAuthGuard` in `@UseGuards(...)`.
 *
 * Has no dependencies, so Nest instantiates it without provider registration (like the other guards used
 * via `@UseGuards(Class)`).
 */
@Injectable()
export class PasswordLoginEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!isPasswordLoginEnabled(PUBLIC_CONFIG.loginMode)) {
      throw new BusinessException(
        BusinessCode.LOGIN_METHOD_DISABLED,
        'password login is disabled',
      );
    }
    return true;
  }
}
