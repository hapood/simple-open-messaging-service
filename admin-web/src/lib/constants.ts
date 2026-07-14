// Backend base: same-origin relative path (dev via vite proxy /api → :3000; prod same-origin path-prefix).
export const API_BASE = '/api/v1'

// Business codes (align with backend src/common/business-code.ts)
export const CODE = {
  OK: 0,
  VALIDATION_FAILED: 10000,
  UNAUTHENTICATED: 10003,
  INVALID_CREDENTIALS: 10009,
  FORBIDDEN: 10004,
  RATE_LIMITED: 10005,
  REFRESH_REUSE_DETECTED: 10006,
  VAPID_INVALID: 60001,
} as const

// Admin refresh-token persistence key (physically isolated from the C-end 'refresh_token' to avoid same-origin key collision)
export const ADMIN_RT_KEY = 'admin_refresh_token'

// Password reset regex (aligns with backend src/admin/admin.dto.ts AdminResetPasswordDto)
export const PASSWORD_REGEX = /^([a-zA-Z0-9.@!#$%^&*()]){6,20}$/
