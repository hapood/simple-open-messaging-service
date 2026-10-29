import { describe, expect, it } from 'vitest';
import {
  LOGIN_METHODS,
  PUBLIC_CONFIG,
  isLoginMethodEnabled,
} from './public-config.js';

/**
 * PUBLIC_CONFIG is a compile-time const, so its contract invariants are pinned here once instead of being
 * re-validated per request: every method appears exactly once, at least one is enabled, and the default
 * is a present, enabled entry. When the config moves to runtime storage these tests become the migration
 * guard against writing a policy the clients' documented fallback has to paper over.
 */
describe('PUBLIC_CONFIG invariants', () => {
  it('advertises every login method exactly once', () => {
    const keys = PUBLIC_CONFIG.loginMethods.map((item) => item.key);
    expect([...keys].sort()).toEqual([...LOGIN_METHODS].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('enables at least one login method', () => {
    expect(PUBLIC_CONFIG.loginMethods.some((item) => !item.disabled)).toBe(
      true,
    );
  });

  it('defaults to a present, enabled login method', () => {
    const fallback = PUBLIC_CONFIG.loginMethods.find(
      (item) => !item.disabled,
    );
    expect(PUBLIC_CONFIG.defaultLoginMethod).toBe(fallback?.key);
  });

  it('isLoginMethodEnabled matches the advertised entries', () => {
    for (const item of PUBLIC_CONFIG.loginMethods) {
      expect(isLoginMethodEnabled(item.key)).toBe(!item.disabled);
    }
    expect(isLoginMethodEnabled('password')).toBe(false); // current policy pin
  });
});
