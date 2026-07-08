import { request } from '@/api/client'
import type { SessionListResult } from '@/types/api'

/** System-wide active session overview (cross-user, filterable by userId/ip). */
export function listAllSessions(params: {
  skip?: number
  take?: number
  userId?: number
  ip?: string
}): Promise<SessionListResult> {
  return request<SessionListResult>('/admin/sessions', params)
}

/** Purge all active sessions in one shot (revokes refresh + bumps tokenVersion, forcing every user to re-login). */
export function purgeAllSessions(): Promise<{ purgedUsers: number }> {
  return request<{ purgedUsers: number }>('/admin/sessions/purge')
}
