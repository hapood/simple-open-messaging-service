import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { AuthController } from '../controller/auth.controller.js';
import { AuthOtpController } from '../controller/auth-otp.controller.js';
import { AuthQrController } from '../controller/auth-qr.controller.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { LocalAuthGuard } from '../auth/local-auth.guard.js';
import {
  AUTH_RATE_LIMIT_POLICIES,
  type AuthRateLimitPolicyName,
} from './auth-policy.registry.js';
import { RATE_LIMIT_POLICY_METADATA } from './rate-limit.decorator.js';
import { THROTTLE_KEY } from '../auth/throttle.guard.js';

function guards(target: object, method: string): unknown[] {
  const descriptor = Object.getOwnPropertyDescriptor(target, method);
  return (
    Reflect.getMetadata(GUARDS_METADATA, descriptor?.value as object) ?? []
  );
}

function policy(target: object, method: string): AuthRateLimitPolicyName {
  const descriptor = Object.getOwnPropertyDescriptor(target, method);
  return Reflect.getMetadata(
    RATE_LIMIT_POLICY_METADATA,
    descriptor?.value as object,
  ) as AuthRateLimitPolicyName;
}

function legacyThrottle(target: object, method: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, method);
  return Reflect.getMetadata(THROTTLE_KEY, descriptor?.value as object);
}

describe('authentication policy wiring', () => {
  it('runs the rate-limit guard before password verification', () => {
    const loginGuards = guards(AuthController.prototype, 'login');
    expect(loginGuards.indexOf(RateLimitGuard)).toBeGreaterThanOrEqual(0);
    expect(loginGuards.indexOf(RateLimitGuard)).toBeLessThan(
      loginGuards.indexOf(LocalAuthGuard),
    );
  });

  it.each([
    [AuthController.prototype, 'login', AUTH_RATE_LIMIT_POLICIES.passwordLogin],
    [
      AuthOtpController.prototype,
      'otpLogin',
      AUTH_RATE_LIMIT_POLICIES.otpLogin,
    ],
    [AuthQrController.prototype, 'create', AUTH_RATE_LIMIT_POLICIES.qrCreate],
    [AuthQrController.prototype, 'poll', AUTH_RATE_LIMIT_POLICIES.qrPoll],
    [AuthQrController.prototype, 'scan', AUTH_RATE_LIMIT_POLICIES.qrScan],
    [AuthQrController.prototype, 'confirm', AUTH_RATE_LIMIT_POLICIES.qrConfirm],
  ] as const)(
    'wires RateLimitGuard and the expected policy on %s.%s',
    (prototype, method, expectedPolicy) => {
      expect(guards(prototype, method)).toContain(RateLimitGuard);
      expect(policy(prototype, method)).toBe(expectedPolicy);
      expect(legacyThrottle(prototype, method)).toBeUndefined();
    },
  );

  it('retains legacy throttling on authentication routes not yet migrated', () => {
    expect(legacyThrottle(AuthController.prototype, 'logout')).toEqual({
      limit: 30,
      ttlSec: 60,
    });
  });
});
