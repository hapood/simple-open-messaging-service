import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  batchUsers,
  createUser,
  disableUser,
  enableUser,
  forceLogoutUser,
  generateInitialPassword,
  issueLoginCode,
  listLoginCodes,
  revokeLoginCode,
  userSessions,
  type UserBatchAction,
} from '@/api/users'

function useInvalidateUsers() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['admin', 'users'] })
}

export function useDisableUser() {
  const invalidate = useInvalidateUsers()
  return useMutation({ mutationFn: (id: number) => disableUser(id), onSuccess: invalidate })
}

export function useEnableUser() {
  const invalidate = useInvalidateUsers()
  return useMutation({ mutationFn: (id: number) => enableUser(id), onSuccess: invalidate })
}

export function useForceLogoutUser() {
  const invalidate = useInvalidateUsers()
  return useMutation({ mutationFn: (id: number) => forceLogoutUser(id), onSuccess: invalidate })
}

/** Create a user account (admin-provisioned). Invalidates the user list so the new row appears. */
export function useCreateUser() {
  const invalidate = useInvalidateUsers()
  return useMutation({
    mutationFn: (v: { account: string; name: string; password?: string }) => createUser(v),
    onSuccess: invalidate,
  })
}

/** Issue a one-time login code. Returns the plaintext ONCE (reveal-once); on success invalidates the
 *  user's login-code audit list so the new code appears. */
export function useIssueLoginCode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => issueLoginCode(id),
    onSuccess: (_data, id) => qc.invalidateQueries({ queryKey: ['admin', 'users', id, 'login-codes'] }),
  })
}

/** (Re-)generate the user's initial password. Returns the plaintext ONCE (reveal-once). */
export function useGenerateInitialPassword() {
  return useMutation({ mutationFn: (id: number) => generateInitialPassword(id) })
}

/** Revoke an unused login code. Invalidates the user's login-code audit list. */
export function useRevokeLoginCode(userId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => revokeLoginCode(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users', userId, 'login-codes'] }),
  })
}

export function useBatchUsers() {
  const invalidate = useInvalidateUsers()
  return useMutation({
    mutationFn: (v: { ids: number[]; action: UserBatchAction }) => batchUsers(v.ids, v.action),
    onSuccess: invalidate,
  })
}

export function useUserSessions(id: number | null) {
  return useQuery({
    queryKey: ['admin', 'users', id, 'sessions'],
    queryFn: () => userSessions(id!),
    enabled: id !== null,
  })
}

/** Login-code audit list for a user (newest first). */
export function useUserLoginCodes(id: number | null) {
  return useQuery({
    queryKey: ['admin', 'users', id, 'login-codes'],
    queryFn: () => listLoginCodes(id!),
    enabled: id !== null,
  })
}
