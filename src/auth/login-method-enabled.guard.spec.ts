import { describe, expect, it } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { loginMethodEnabledGuard } from './login-method-enabled.guard.js';

/** The guard is the server-side wall behind every grayed-out login tab: enabled methods pass, disabled
 *  methods are rejected with LOGIN_METHOD_DISABLED before any credential work — regardless of payload. */
describe('loginMethodEnabledGuard', () => {
  const context = {} as ExecutionContext;

  it('activates for enabled methods', () => {
    for (const method of ['qr', 'otp'] as const) {
      const guard = new (loginMethodEnabledGuard(method))();
      expect(guard.canActivate(context)).toBe(true);
    }
  });

  it('rejects disabled methods with LOGIN_METHOD_DISABLED', () => {
    const guard = new (loginMethodEnabledGuard('password'))();
    expect(() => guard.canActivate(context)).toThrow(BusinessException);
    try {
      guard.canActivate(context);
      expect.unreachable('guard must throw');
    } catch (e) {
      expect((e as BusinessException).bizCode).toBe(
        BusinessCode.LOGIN_METHOD_DISABLED,
      );
    }
  });
});
