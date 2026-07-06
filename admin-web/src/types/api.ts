// 统一响应外壳（对齐后端 src/common/api-result.ts）
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

// 用户行（后端已删 hashPwd；Date 字段被全局拦截器序列化为毫秒时间戳 number）
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

// 用户活跃会话（POST /admin/users/:id/sessions）
export interface Session {
  jti: string
  device: string | null
  userAgent: string | null
  ip: string | null
  createdAt: number
  expiresAt: number
}

// 全系统活跃会话总览条目（POST /admin/sessions，join user 出用户名）
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

// 管理员活跃会话条目（POST /admin/admin-sessions，join Admin 出 username；无 device 字段）
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

// 当前登录封禁条目（POST /admin/bans，按 type 区分 IP/账户）
export interface Ban {
  key: string
  type: 'ip' | 'user'
  value: string
  until: number
  remainingMs: number
}

// refresh 重用告警（POST /admin/reuse-alerts）
export interface ReuseAlert {
  userId: number
  familyId: string
  jti: string
  ip: string | null
  userAgent: string | null
  revokedAt: number
}

// 在线 SSE 连接（POST /admin/connections，按用户聚合；since=该用户最早建连时刻 ms）
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

// 推送设备 token（POST /admin/push/tokens）。platform: ANDROID/IOS 走 FCM，WEB 走 Web Push
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

// 测试推送结果（POST /admin/push/test；ok=false 时 error 给出原因，例如 token 失效 / 通道未配置）
export interface PushTestResult {
  ok: boolean
  error?: string
}
