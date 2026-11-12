// Backend base: same-origin relative path (dev via vite proxy /api → :3000; prod same-origin path-prefix).
export const API_BASE = '/api/v1';

// Business codes (align with backend src/common/business-code.ts)
export const CODE = {
  OK: 0,
  VALIDATION_FAILED: 10000,
  NOT_FOUND: 10001,
  ALREADY_EXISTS: 10002,
  UNAUTHENTICATED: 10003,
  FORBIDDEN: 10004,
  RATE_LIMITED: 10005,
  REFRESH_REUSE_DETECTED: 10006,
  SESSION_REVOKED: 10007,
  INVALID_CREDENTIALS: 10009,
  LOGIN_METHOD_DISABLED: 10011,
  OTP_INVALID: 10012,
  OTP_EXPIRED: 10013,
  OTP_CONSUMED: 10014,
  PASSWORD_NOT_SET: 10017,
  MUST_CHANGE_PASSWORD: 10018,
  TWO_FACTOR_INVALID: 10019,
  TWO_FACTOR_CHALLENGE_EXPIRED: 10020,
  TWO_FACTOR_NOT_ENABLED: 10021,
  TWO_FACTOR_ALREADY_ENABLED: 10022,
  WEBAUTHN_NOT_AVAILABLE: 10023,
  WEBAUTHN_CHALLENGE_EXPIRED: 10024,
  WEBAUTHN_VERIFICATION_FAILED: 10025,
  INTERNAL: 10999,
} as const;

// Password grammar (6-20 chars of [a-zA-Z0-9.@!#$%^&*()]); the same rule the backend enforces on every password input.
export const PASSWORD_REGEX = /^([a-zA-Z0-9.@!#$%^&*()]){6,20}$/;

// Login-method policy advertised by the backend GET /config (mirrors src/config/public-config.ts).
// The backend sends a plain item list; the consumer web uses the same shape for its BusinessCode.
export type LoginMethod = 'password' | 'otp' | 'qr';

/** One advertised login method; array order is the clients' presentation order. */
export interface LoginMethodOption {
  key: LoginMethod;
  disabled: boolean;
}

/** Password login is enabled iff the `password` entry is advertised and not disabled. */
export function isPasswordLoginEnabled(
  methods: LoginMethodOption[],
): boolean {
  const item = methods.find((m) => m.key === 'password');
  return item !== undefined && !item.disabled;
}

/** Public site config (GET /config) — drives client-side gating (e.g. the create-user password field). */
export interface PublicConfig {
  registrationOpen: boolean;
  loginMethods: LoginMethodOption[];
  defaultLoginMethod: LoginMethod;
}
