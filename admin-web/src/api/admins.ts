import { request } from '@/api/client';
import type { AdminRole } from '@/types/api';

export function grantViewer(userId: number): Promise<{ id: number }> {
  return request<{ id: number }>(`/admin/users/${userId}/grant-viewer`);
}

export function disableAdmin(id: number): Promise<void> {
  return request<void>(`/admin/admins/${id}/disable`);
}

export function enableAdmin(id: number): Promise<void> {
  return request<void>(`/admin/admins/${id}/enable`);
}

export function setAdminRole(id: number, role: AdminRole): Promise<void> {
  return request<void>(`/admin/admins/${id}/role`, { role });
}

/** SUPER_ADMIN lockout recovery: disable an admin's 2FA outright (idempotent — no-op if not enrolled). */
export function resetAdminTwoFactor(id: number): Promise<void> {
  return request<void>(`/admin/admins/${id}/reset-2fa`);
}
