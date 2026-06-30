import { request } from '@/api/client'
import type { Session, UserListResult } from '@/types/api'

export function listUsers(params: {
  skip?: number
  take?: number
  search?: string
}): Promise<UserListResult> {
  return request<UserListResult>('/admin/users', params)
}

export function disableUser(id: number): Promise<void> {
  return request<void>(`/admin/users/${id}/disable`)
}

export function enableUser(id: number): Promise<void> {
  return request<void>(`/admin/users/${id}/enable`)
}

export function forceLogoutUser(id: number): Promise<void> {
  return request<void>(`/admin/users/${id}/force-logout`)
}

export function userSessions(id: number): Promise<Session[]> {
  return request<Session[]>(`/admin/users/${id}/sessions`)
}

export function resetPassword(id: number, newPassword: string): Promise<void> {
  return request<void>(`/admin/users/${id}/reset-password`, { newPassword })
}
