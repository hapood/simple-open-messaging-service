// 后端基址：dev 走 Vite proxy（/api → :3000），生产构建时改为同源相对或实际域名
export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1'

// 业务码（对齐后端 src/common/business-code.ts）
export const CODE = {
  OK: 0,
  VALIDATION_FAILED: 10000,
  UNAUTHENTICATED: 10003,
  FORBIDDEN: 10004,
  RATE_LIMITED: 10005,
  REFRESH_REUSE_DETECTED: 10006,
} as const

// admin refresh token 持久化 key（与 C 端 'refresh_token' 物理隔离，避免同源撞 key）
export const ADMIN_RT_KEY = 'admin_refresh_token'

// 重置密码正则（对齐后端 src/admin/admin.dto.ts AdminResetPasswordDto）
export const PASSWORD_REGEX = /^([a-zA-Z0-9.@!#$%^&*()]){6,20}$/
