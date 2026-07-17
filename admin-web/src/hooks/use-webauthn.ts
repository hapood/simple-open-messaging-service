import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  beginWebAuthnRegistration,
  completeWebAuthnRegistration,
  getWebAuthnStatus,
  listWebAuthnCredentials,
  removeWebAuthnCredential,
  renameWebAuthnCredential,
} from '@/api/webauthn'

/** Query keys for the passkey status + credential list (invalidated by every enrollment/remove mutation). */
const STATUS_KEY = ['admin', 'webauthn', 'status'] as const
const CREDS_KEY = ['admin', 'webauthn', 'credentials'] as const

export function useWebAuthnStatus() {
  return useQuery({ queryKey: STATUS_KEY, queryFn: getWebAuthnStatus })
}

export function useWebAuthnCredentials() {
  return useQuery({ queryKey: CREDS_KEY, queryFn: listWebAuthnCredentials })
}

export function useBeginWebAuthnRegistration() {
  return useMutation({ mutationFn: beginWebAuthnRegistration })
}

export function useCompleteWebAuthnRegistration() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: completeWebAuthnRegistration,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: STATUS_KEY })
      qc.invalidateQueries({ queryKey: CREDS_KEY })
    },
  })
}

export function useRenameWebAuthnCredential() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; nickname: string }) => renameWebAuthnCredential(v.id, v.nickname),
    onSuccess: () => qc.invalidateQueries({ queryKey: CREDS_KEY }),
  })
}

export function useRemoveWebAuthnCredential() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => removeWebAuthnCredential(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: STATUS_KEY })
      qc.invalidateQueries({ queryKey: CREDS_KEY })
    },
  })
}
