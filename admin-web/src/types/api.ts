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

// ─── S2S handshake self-check (POST /admin/federation/self-check) ───
// Probes THIS server's federation prerequisites from the external viewpoint. Each network check
// (tls-public / well-known) carries an `ips[]` evidence array — one independent probe per resolved IP,
// because an SRV target can point at a DDNS host or the apex can have many A/AAAA records, and each
// IP may present a different cert or be differently reachable.
export type SelfCheckStatus = 'ok' | 'warn' | 'fail' | 'skip'
export type SelfCheckGroup = 'config' | 'dns' | 'tls' | 'well-known' | 'crypto' | 'clock'

export interface SelfCheckSummary {
  ok: number
  warn: number
  fail: number
  skip: number
}

export interface SelfCheckCertInfo {
  subject: string
  issuer: string
  subjectCN: string | null
  issuerCN: string | null
  subjectAltName: string | null
  serialNumber: string
  validFrom: string
  validTo: string
  daysToExpiry: number
  signatureAlgorithm: string | null
  publicKey: { algorithm: string | null; bits: number | null; curve: string | null }
  fingerprintSha1: string
  fingerprintSha256: string
  ca: boolean
  keyUsage: string[] | null
  alpn: string | null
  sanMatched: boolean
}

export interface SelfCheckChainNode {
  subject: string
  issuer: string
  subjectCN: string | null
  validTo: string | null
  selfSigned: boolean
  isCA: boolean
}

export interface SelfCheckIpTlsProbe {
  ip: string
  family: 4 | 6
  reachable: boolean
  status: SelfCheckStatus
  detail: string
  cert?: SelfCheckCertInfo
  chain?: SelfCheckChainNode[]
  chainComplete?: boolean
  errorClass?: 'reachability' | 'cert' | 'timeout'
  code?: string
}

export interface SelfCheckIpWellKnownProbe {
  ip: string
  family: 4 | 6
  reachable: boolean
  status: SelfCheckStatus
  detail: string
  httpStatus?: number
  contentType?: string
  software?: string | null
  keyCount?: number
  keysValid?: boolean
  errorClass?: 'reachability' | 'cert' | 'timeout' | 'http' | 'parse'
  code?: string
}

export interface SelfCheckCheck {
  key: string
  group: SelfCheckGroup
  title: string
  status: SelfCheckStatus
  detail: string
  evidence?: Record<string, unknown>
  durationMs: number
}

export interface SelfCheckReport {
  domain: string
  runAt: number // ms epoch
  durationMs: number
  summary: SelfCheckSummary
  target: { host: string; port: number; scheme: 'https' | 'http'; hasSrv: boolean }
  resolver: string
  ntpServer: string
  checks: SelfCheckCheck[]
}

// Reference NTP / DNS resolver options for the controls. `alias` is a brand/region tag shown alongside
// the technical value (not localized — Aliyun / Tencent are recognized in either language).
export const NTP_SERVERS: ReadonlyArray<{ value: string; alias: string }> = [
  { value: 'ntp.aliyun.com', alias: 'Aliyun' },
  { value: 'time1.cloud.tencent.com', alias: 'Tencent Cloud' },
  { value: 'cn.ntp.org.cn', alias: 'China NTP' },
  { value: 'pool.ntp.org', alias: 'NTP Pool' },
  { value: 'time.google.com', alias: 'Google' },
  { value: 'time.cloudflare.com', alias: 'Cloudflare' },
  { value: 'time.windows.com', alias: 'Microsoft' },
]

export const DNS_RESOLVERS: ReadonlyArray<{ value: string; alias: string }> = [
  { value: 'system', alias: 'System' },
  { value: '223.5.5.5', alias: 'AliDNS' },
  { value: '119.29.29.29', alias: 'DNSPod' },
  { value: '114.114.114.114', alias: '114 DNS' },
  { value: '8.8.8.8', alias: 'Google' },
  { value: '1.1.1.1', alias: 'Cloudflare' },
]

// ── RBAC (mirrors backend AdminRole enum) ────────────────────────────────────
export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'VIEWER'

// ── Current admin identity (POST /admin/me) ──────────────────────────────────
export interface MeResult {
  account: string
  name: string
  role: AdminRole
}

// ── User 360° detail (POST /admin/users/:id/detail) ──────────────────────────
export interface UserDetailUser {
  id: number
  account: string
  name: string
  avatar: string
  bio: string
  domain: string | null
  isForeigner: boolean
  isGroup: boolean
  isDeleted: boolean
  tokenVersion: number
  createdAt: number
  updatedAt: number
}

export interface UserDetailGroup {
  threadId: number
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null
  joinedAt: number
  leftAt: number | null
  thread: { groupUser: { account: string; name: string } | null }
}

export interface UserDetailPushToken {
  id: number
  platform: 'ANDROID' | 'WEB' | 'IOS'
  deviceId: string | null
  lastSeenAt: number
}

export interface UserDetail {
  user: UserDetailUser
  groups: UserDetailGroup[]
  sessions: Session[]
  pushTokens: UserDetailPushToken[]
}

// ── Dashboard overview (POST /admin/dashboard) ───────────────────────────────
// Backend BigInt (media.bytes) is serialized to a string by the global interceptor.
export interface DashboardFederation {
  trusted: number
  demoted: number
  pending: number
  blocked: number
}

export interface DashboardAction {
  id: string
  action: string
  targetType: string | null
  targetId: string | null
  adminId: number
  adminRole: AdminRole
  success: boolean
  errorMessage: string | null
  ip: string | null
  at: number
}

export interface DashboardSummary {
  online: { totalConnections: number; uniqueUsers: number }
  activeSessions: number
  federation: DashboardFederation
  media: { bytes: string; assetCount: number; reclaimable: number }
  recentActions: DashboardAction[]
}

// ── Audit log (POST /admin/audit) ────────────────────────────────────────────
export interface AuditEntry {
  id: string
  adminId: number
  adminRole: AdminRole
  action: string
  targetType: string | null
  targetId: string | null
  ip: string | null
  userAgent: string | null
  route: string | null
  success: boolean
  errorMessage: string | null
  at: number
}

export interface AuditListResult {
  list: AuditEntry[]
  total: number
}

// ── Media storage (POST /admin/media/stats) ──────────────────────────────────
// BigInt byte sums are serialized to strings by the global interceptor.
export interface MediaExtBucket {
  ext: string
  files: number
  bytes: string
}

export interface MediaStats {
  db: { bytes: string; assetCount: number; reclaimable: number }
  onDisk: { files: number; bytes: string; byExt: MediaExtBucket[] }
}

// ── Admin self-management (POST /admin/admins*) ──────────────────────────────
export interface AdminAccount {
  id: number
  userId: number
  account: string
  name: string
  role: AdminRole
  enabled: boolean
  lastLoginAt: number | null
  lastLoginIp: string | null
  createdAt: number
}

export interface AdminListResult {
  list: AdminAccount[]
  total: number
}

// ── Groups/threads (POST /admin/groups) ──────────────────────────────────────
export interface GroupRow {
  id: number
  createdAt: number
  lastMessageAt: number | null
  lastMessagePreview: string | null
  originDomain: string | null
  fedGroupAccount: string | null
  groupUser: { account: string; name: string } | null
  _count: { ThreadParticipant: number }
}

export interface GroupListResult {
  list: GroupRow[]
  total: number
}

// ── Settings (POST /admin/settings/*) ────────────────────────────────────────
/** Stored VAPID config as seen by the admin read view. privateKey is intentionally absent (write-only). */
export interface VapidDescriptor {
  configured: boolean
  subject?: string
  publicKey?: string
  updatedAt?: number
}

/** Response of /admin/settings/notifications — the Settings page's read model. */
export interface NotificationSettings {
  vapid: VapidDescriptor
  fcmConfigured: boolean
  somsDomain: string
}

/** Deterministic VAPID health-check report (POST /admin/settings/health-check). */
export interface VapidHealthReport {
  configured: boolean
  publicKeyValid: boolean
  privateKeyValid: boolean
  pairMatches: boolean
  subjectValid: boolean
  fcmConfigured: boolean
  webPushConfigured: boolean
  somsDomain: string
  errors: string[]
}

/** Result of generate / save — publicKey + subject (never privateKey). */
export interface VapidMutationResult {
  configured: boolean
  subject: string
  publicKey: string
}

/** Paste-an-existing-keypair payload. */
export interface SaveVapidPayload {
  subject: string
  publicKey: string
  privateKey: string
}

/** Generate payload — subject is optional. */
export interface GenerateVapidPayload {
  subject?: string
}

