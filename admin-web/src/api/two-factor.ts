import { request } from '@/api/client'
import type { TwoFactorBackupResult, TwoFactorSetupBundle, TwoFactorStatus } from '@/types/api'

/** Current admin's 2FA status (enabled + remaining backup codes). */
export function getTwoFactorStatus(): Promise<TwoFactorStatus> {
  return request<TwoFactorStatus>('/admin/2fa/status')
}

/** Begin enrollment: returns the otpauth URI + base32 secret + a signed pending token. */
export function beginTwoFactorSetup(): Promise<TwoFactorSetupBundle> {
  return request<TwoFactorSetupBundle>('/admin/2fa/setup')
}

/** Confirm enrollment with the first 6-digit code → enables 2FA + returns backup codes ONCE. */
export function completeTwoFactorSetup(pendingToken: string, code: string): Promise<TwoFactorBackupResult> {
  return request<TwoFactorBackupResult>('/admin/2fa/setup/verify', { pendingToken, code })
}

/** Disable 2FA (current password + a live TOTP or backup code required). */
export function disableTwoFactor(input: {
  password: string
  code?: string
  backupCode?: string
}): Promise<void> {
  return request<void>('/admin/2fa/disable', input)
}

/** Regenerate the backup-code set (a live TOTP or backup code required) → new codes returned ONCE. */
export function regenerateBackupCodes(input: { code?: string; backupCode?: string }): Promise<TwoFactorBackupResult> {
  return request<TwoFactorBackupResult>('/admin/2fa/backup/regenerate', input)
}
