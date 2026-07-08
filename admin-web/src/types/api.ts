// Unified response envelope (aligns with backend src/common/api-result.ts)
export interface ApiResult<T = unknown> {
  code: number
  message: string
  data?: T
  hasMore?: boolean
}

export interface TokenPair {
  access_token: string
  refresh_token: string
}

// User row (backend no longer exposes hashPwd; Date fields are serialized to ms-epoch numbers by the global interceptor)
export interface User {
  id: number
  uniqName: string
  isForeigner: boolean
  domain: string | null
  createdAt: number
  updatedAt: number
  isDeleted: boolean
  tokenVersion: number
  userExtraId: number
  userNotiBoxId: number
}

export interface UserListResult {
  list: User[]
  total: number
}

// Active sessions of a user (POST /admin/users/:id/sessions)
export interface Session {
  jti: string
  device: string | null
  userAgent: string | null
  ip: string | null
  createdAt: number
  expiresAt: number
}

// System-wide active session overview entry (POST /admin/sessions; joins user for the username)
export interface SessionListItem {
  userId: number
  jti: string
  device: string | null
  userAgent: string | null
  ip: string | null
  createdAt: number
  expiresAt: number
  user: { id: number; uniqName: string } | null
}

export interface SessionListResult {
  list: SessionListItem[]
  total: number
}

// Admin active session entry (POST /admin/admin-sessions; joins Admin for the username; no device field)
export interface AdminSessionListItem {
  adminId: number
  jti: string
  userAgent: string | null
  ip: string | null
  createdAt: number
  expiresAt: number
  admin: { id: number; username: string } | null
}

export interface AdminSessionListResult {
  list: AdminSessionListItem[]
  total: number
}

// Active login ban entry (POST /admin/bans; type distinguishes IP/account)
export interface Ban {
  key: string
  type: 'ip' | 'user'
  value: string
  until: number
  remainingMs: number
}

// Refresh token reuse alert (POST /admin/reuse-alerts)
export interface ReuseAlert {
  userId: number
  familyId: string
  jti: string
  ip: string | null
  userAgent: string | null
  revokedAt: number
}

// Online SSE connection (POST /admin/connections, aggregated by user; since = that user's earliest connect time in ms)
export interface ConnectionClient {
  userId: number
  uniqName: string | null
  connections: number
  since: number
}
export interface ConnectionSnapshot {
  total: number
  uniqueUsers: number
  clients: ConnectionClient[]
}

// Push device token (POST /admin/push/tokens). platform: ANDROID/IOS use FCM, WEB uses Web Push
export interface PushToken {
  id: number
  userId: number
  platform: 'ANDROID' | 'WEB' | 'IOS'
  token: string
  deviceId: string | null
  createdAt: number
  lastSeenAt: number
  user: { id: number; uniqName: string } | null
}

export interface PushTokenListResult {
  list: PushToken[]
  total: number
  fcmConfigured: boolean
  webPushConfigured: boolean
}

// Test push result (POST /admin/push/test; when ok=false, error gives the reason, e.g. token invalid / transport not configured)
export interface PushTestResult {
  ok: boolean
  error?: string
}
