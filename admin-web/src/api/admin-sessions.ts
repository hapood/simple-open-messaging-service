import { request } from '@/api/client'
import type { AdminSessionListResult } from '@/types/api'

/** 管理员活跃会话列表（独立 AdminRefreshToken 表，join Admin username） */
export function listAdminSessions(params: {
  skip?: number
  take?: number
  ip?: string
}): Promise<AdminSessionListResult> {
  return request<AdminSessionListResult>('/admin/admin-sessions', params)
}

/** 吊销指定管理员会话（按 jti；其 access 15m 内仍有效——admin 无 tokenVersion） */
export function revokeAdminSession(jti: string): Promise<void> {
  return request<void>(`/admin/admin-sessions/${jti}/revoke`)
}
