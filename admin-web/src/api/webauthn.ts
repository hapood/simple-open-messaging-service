import { request } from '@/api/client'
import type { WebAuthnCredentialView, WebAuthnRegBegin, WebAuthnStatus } from '@/types/api'

/** Current admin's passkey status (availability + enrollment). */
export function getWebAuthnStatus(): Promise<WebAuthnStatus> {
  return request<WebAuthnStatus>('/admin/webauthn/status')
}

/** Begin passkey enrollment (re-auth password + optional label) → options + pending token. */
export function beginWebAuthnRegistration(input: {
  password: string
  nickname?: string
}): Promise<WebAuthnRegBegin> {
  return request<WebAuthnRegBegin>('/admin/webauthn/registration/begin', input)
}

/** Confirm passkey enrollment → persists the credential (returns its display view). */
export function completeWebAuthnRegistration(input: {
  pendingToken: string
  registrationResponse: unknown
}): Promise<{ id: string; nickname: string | null; deviceType: string | null; backed: boolean }> {
  return request('/admin/webauthn/registration/finish', input)
}

/** List the current admin's saved passkeys. */
export function listWebAuthnCredentials(): Promise<WebAuthnCredentialView[]> {
  return request<WebAuthnCredentialView[]>('/admin/webauthn/credentials')
}

/** Rename a saved passkey (id is the stringified BigInt from the list view). */
export function renameWebAuthnCredential(id: string, nickname: string): Promise<void> {
  return request<void>(`/admin/webauthn/credentials/${encodeURIComponent(id)}/rename`, { nickname })
}

/** Delete a saved passkey → returns the remaining count. */
export function removeWebAuthnCredential(id: string): Promise<{ remaining: number }> {
  return request(`/admin/webauthn/credentials/${encodeURIComponent(id)}/delete`)
}
