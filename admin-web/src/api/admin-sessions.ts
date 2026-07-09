import { request } from '@/api/client'
import type { AdminSessionListResult } from '@/types/api'

/** List of active admin sessions (independent AdminRefreshToken table; joins Admin for the account). */
export function listAdminSessions(params: {
  skip?: number
  take?: number
  ip?: string
}): Promise<AdminSessionListResult> {
  return request<AdminSessionListResult>('/admin/admin-sessions', params)
}

/** Revoke a given admin session by jti (its access stays valid for up to 15m — admins have no tokenVersion). */
export function revokeAdminSession(jti: string): Promise<void> {
  return request<void>(`/admin/admin-sessions/${jti}/revoke`)
}
