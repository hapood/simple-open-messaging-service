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

/** Purge all active sessions in one shot (revokes every user's active session tokens, forcing
 * every user to re-login). */
export function purgeAllSessions(): Promise<{ purgedUsers: number }> {
  return request<{ purgedUsers: number }>('/admin/sessions/purge')
}

/** Revoke a single active user session — kicks only that device; the user stays online on every other
 * device (the surgical counterpart to force-logout). */
export function revokeSession(id: number): Promise<void> {
  return request<void>(`/admin/sessions/${id}/revoke`)
}
