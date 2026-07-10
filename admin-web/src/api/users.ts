import { request } from '@/api/client'
import type { Session, UserDetail, UserListResult } from '@/types/api'

export function listUsers(params: {
  skip?: number
  take?: number
  search?: string
}): Promise<UserListResult> {
  return request<UserListResult>('/admin/users', params)
}

export function getUserDetail(id: number): Promise<UserDetail> {
  return request<UserDetail>(`/admin/users/${id}/detail`)
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

export type UserBatchAction = 'disable' | 'enable' | 'force-logout'

export function batchUsers(
  ids: number[],
  action: UserBatchAction,
): Promise<{ affected: number }> {
  return request<{ affected: number }>('/admin/users/batch', { ids, action })
}
