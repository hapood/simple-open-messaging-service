import { request } from '@/api/client'
import type { AdminListResult, AdminRole } from '@/types/api'

export interface AdminsQuery {
  skip?: number
  take?: number
  search?: string
}

export function listAdmins(q: AdminsQuery): Promise<AdminListResult> {
  return request<AdminListResult>('/admin/admins', q)
}

export function createAdmin(userId: number, role: AdminRole): Promise<{ id: number }> {
  return request<{ id: number }>('/admin/admins/create', { userId, role })
}

export function disableAdmin(id: number): Promise<void> {
  return request<void>(`/admin/admins/${id}/disable`)
}

export function enableAdmin(id: number): Promise<void> {
  return request<void>(`/admin/admins/${id}/enable`)
}

export function setAdminRole(id: number, role: AdminRole): Promise<void> {
  return request<void>(`/admin/admins/${id}/role`, { role })
}
