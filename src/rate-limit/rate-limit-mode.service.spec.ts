import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RateLimitModeService,
  resolvePositiveNumber,
  resolveRateLimitMode,
} from './rate-limit-mode.service.js';

afterEach(() => vi.unstubAllEnvs());

describe('resolveRateLimitMode', () => {
  it.each([
    [undefined, 'enforce'],
    ['', 'enforce'],
    ['shadow', 'shadow'],
    [' ENFORCE ', 'enforce'],
    ['disabled', 'disabled'],
  ] as const)('maps %s to %s', (raw, expected) => {
    expect(resolveRateLimitMode(raw, 'TEST_MODE')).toBe(expected);
  });

  it('rejects an invalid value instead of silently changing behavior', () => {
    expect(() => resolveRateLimitMode('on', 'TEST_MODE')).toThrow(
      'TEST_MODE must be one of disabled, shadow, or enforce',
    );
  });
});

describe('rate-limit numeric configuration', () => {
  it('uses the default for an unset value and accepts a positive override', () => {
    expect(resolvePositiveNumber(undefined, 'TEST_RATE', 2)).toBe(2);
    expect(resolvePositiveNumber(' 0.25 ', 'TEST_RATE', 2)).toBe(0.25);
  });

  it.each(['0', '-1', 'NaN', 'Infinity'])('rejects %s', (raw) => {
    expect(() => resolvePositiveNumber(raw, 'TEST_RATE', 2)).toThrow(
      'TEST_RATE must be a finite number greater than zero',
    );
  });

  it('rejects a burst smaller than its configured rate', () => {
    vi.stubEnv('RATE_LIMIT_AUTH_QR_POLL_IP_RATE_PER_SECOND', '10');
    vi.stubEnv('RATE_LIMIT_AUTH_QR_POLL_IP_BURST', '5');
    expect(() => new RateLimitModeService()).toThrow(
      'RATE_LIMIT_AUTH_QR_POLL_IP_BURST must be greater than or equal to',
    );
  });

  it('resolves defaults and explicit overrides for every policy at startup', () => {
    vi.stubEnv('RATE_LIMIT_AUTH_PASSWORD_LOGIN_IP_RATE_PER_SECOND', '2');
    vi.stubEnv('RATE_LIMIT_AUTH_PASSWORD_LOGIN_IP_BURST', '12');
    const service = new RateLimitModeService();
    expect(service.forPolicy('auth.password.login')).toMatchObject({
      mode: 'enforce',
      exactIp: { ratePerSecond: 2, burst: 12, enforce: true },
      account: { ratePerSecond: 0.2, burst: 5, enforce: false },
    });
    expect(() => service.forPolicy('auth.unknown')).toThrow(
      'unknown authentication rate-limit policy',
    );
  });

  it('enforces all authentication policies by default', () => {
    const service = new RateLimitModeService();
    expect(service.monitoringConfig()).toHaveLength(6);
    expect(service.monitoringConfig().map(({ mode }) => mode)).toEqual(
      Array(6).fill('enforce'),
    );
  });

  it('allows a policy to be rolled back to shadow independently', () => {
    vi.stubEnv('RATE_LIMIT_AUTH_PASSWORD_LOGIN_MODE', 'shadow');
    const service = new RateLimitModeService();
    expect(service.forPolicy('auth.password.login').mode).toBe('shadow');
    expect(service.forPolicy('auth.otp.login').mode).toBe('enforce');
  });
});
