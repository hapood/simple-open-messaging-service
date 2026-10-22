import { request } from '@/api/client'
import type { AdminSessionListResult } from '@/types/api'

/** List active opaque administrator sessions. */
export function listAdminSessions(params: {
  skip?: number
  take?: number
  ip?: string
}): Promise<AdminSessionListResult> {
  return request<AdminSessionListResult>('/admin/admin-sessions', params)
}

/** Revoke one administrator session; subsequent requests fail immediately. */
export function revokeAdminSession(id: string): Promise<void> {
  return request<void>(`/admin/admin-sessions/${id}/revoke`)
}
