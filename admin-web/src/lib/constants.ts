// Backend base: same-origin relative path (dev via vite proxy /api → :3000; prod same-origin path-prefix).
export const API_BASE = '/api/v1'

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
  INTERNAL: 10999,
  VAPID_INVALID: 60001,
} as const

// Admin refresh-token persistence key (physically isolated from the C-end 'refresh_token' to avoid same-origin key collision)
export const ADMIN_RT_KEY = 'admin_refresh_token'

// Password grammar (6-20 chars of [a-zA-Z0-9.@!#$%^&*()]); the same rule the backend enforces on every password input.
export const PASSWORD_REGEX = /^([a-zA-Z0-9.@!#$%^&*()]){6,20}$/

// Login-method policy advertised by the backend GET /config (mirrors src/config/public-config.ts).
// A `const` object + derived type (not an enum): cleaner runtime output than an enum's IIFE, and the
// consumer web uses the same shape for its BusinessCode.
export const LoginMode = {
  ALL: 1, // password everywhere; OTP on Android; QR on desktop/web
  APP_OTP_AND_QR: 2, // password disabled; Android logs in via OTP; desktop/web via QR
  PASSWORD_ONLY: 3, // password only on every client
} as const
export type LoginMode = (typeof LoginMode)[keyof typeof LoginMode]

/** Password login is available under ALL and PASSWORD_ONLY; disabled under APP_OTP_AND_QR. */
export function isPasswordLoginEnabled(mode: number): boolean {
  return mode === LoginMode.ALL || mode === LoginMode.PASSWORD_ONLY
}

/** Public site config (GET /config) — drives client-side gating (e.g. the create-user password field). */
export interface PublicConfig {
  registrationOpen: boolean
  loginMode: number
}
