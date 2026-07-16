import { request } from '@/api/client'
import type { IssuedLoginCode, LoginCodeView, Session, UserDetail, UserListResult } from '@/types/api'

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

/** Create a user account (admin-provisioned). Password is required iff password login is enabled
 *  (loginMode ALL / PASSWORD_ONLY); omitted under APP_OTP_AND_QR → a passwordless OTP/QR account. */
export function createUser(body: {
  account: string
  name: string
  password?: string
}): Promise<{ id: number; account: string }> {
  return request<{ id: number; account: string }>('/admin/users/create', body)
}

/** Issue a one-time login code for a user. The plaintext `code` is returned ONCE (reveal-once);
 *  issuing also revokes the user's prior unconsumed code. */
export function issueLoginCode(id: number): Promise<IssuedLoginCode> {
  return request<IssuedLoginCode>(`/admin/users/${id}/issue-login-code`)
}

/** Audit list of a user's login codes — never the codeHash or token value; producedSessionId is the
 *  safe link into the session the consumed code created. Newest first. */
export function listLoginCodes(id: number): Promise<LoginCodeView[]> {
  return request<LoginCodeView[]>(`/admin/users/${id}/login-codes`)
}

/** Revoke an unused login code (admin cancellation). */
export function revokeLoginCode(id: number): Promise<void> {
  return request<void>(`/admin/login-codes/${id}/revoke`)
}

/** (Re-)initialize a user's initial password — a server-generated random password returned ONCE
 *  (reveal-once); sets mustChangePassword so the user is forced to set their own on next login.
 *  Refuses (LOGIN_METHOD_DISABLED) when password login is disabled. */
export function generateInitialPassword(id: number): Promise<{ password: string }> {
  return request<{ password: string }>(`/admin/users/${id}/generate-initial-password`)
}

export type UserBatchAction = 'disable' | 'enable' | 'force-logout'

export function batchUsers(
  ids: number[],
  action: UserBatchAction,
): Promise<{ affected: number }> {
  return request<{ affected: number }>('/admin/users/batch', { ids, action })
}
