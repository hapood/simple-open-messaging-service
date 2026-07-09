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
  account: string
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

// System-wide active session overview entry (POST /admin/sessions; joins user for the account)
export interface SessionListItem {
  userId: number
  jti: string
  device: string | null
  userAgent: string | null
  ip: string | null
  createdAt: number
  expiresAt: number
  user: { id: number; account: string } | null
}

export interface SessionListResult {
  list: SessionListItem[]
  total: number
}

// Admin active session entry (POST /admin/admin-sessions; joins Admin for the account; no device field)
export interface AdminSessionListItem {
  adminId: number
  jti: string
  userAgent: string | null
  ip: string | null
  createdAt: number
  expiresAt: number
  admin: { id: number; account: string } | null
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
  account: string | null
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
  user: { id: number; account: string } | null
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

// Federated-peer trust lifecycle (POST /admin/federation/peers). The trust state machine:
// pending → trusted → demoted (a signed op failed; re-handshakes on next contact) → trusted…, plus
// `blocked` (admin intent; federation refused). Date fields are ms-epoch numbers.
export type FederationTrustLevel = 'pending' | 'trusted' | 'demoted' | 'blocked'

export interface FederatedPeer {
  domain: string
  trustLevel: FederationTrustLevel
  addedBy: string | null
  createdAt: number
  trustedAt: number | null // start of the current trust epoch
  lastSuccessAt: number | null // last successful signed S2S op (liveness watermark, ±60s)
  demotedAt: number | null // last trusted→demoted transition
  demoteReason: string | null // latest failure message
  demotionCount: number // how many times demoted — flakiness signal
  blockedAt: number | null // admin block time
}

export interface FederatedPeerListResult {
  list: FederatedPeer[]
  total: number
}

// One trust-lifecycle transition (POST /admin/federation/peers/:domain/events) — the admin timeline
// that shows the trust → connection-loss process.
export type FederationPeerEventType = 'discovered' | 'trusted' | 'demoted' | 'blocked' | 'unblocked'

export interface FederatedPeerEvent {
  id: number
  domain: string
  type: FederationPeerEventType
  reason: string | null // demoted: the failure message; blocked: optional admin note
  createdAt: number
}
