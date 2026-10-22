import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  beginTwoFactorSetup,
  completeTwoFactorSetup,
  disableTwoFactor,
  getTwoFactorStatus,
  regenerateBackupCodes,
} from '@/api/two-factor'

/** Query key for the current admin's 2FA status (invalidated by every 2FA mutation). */
const STATUS_KEY = ['admin', '2fa', 'status'] as const

export function useTwoFactorStatus() {
  return useQuery({ queryKey: STATUS_KEY, queryFn: getTwoFactorStatus })
}

export function useBeginTwoFactorSetup() {
  return useMutation({ mutationFn: beginTwoFactorSetup })
}

export function useCompleteTwoFactorSetup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { pendingToken: string; code: string }) => completeTwoFactorSetup(v.pendingToken, v.code),
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

export function useDisableTwoFactor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: disableTwoFactor,
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

export function useRegenerateBackupCodes() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: regenerateBackupCodes,
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}
