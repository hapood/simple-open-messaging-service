import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  batchUsers,
  disableUser,
  enableUser,
  forceLogoutUser,
  resetPassword,
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

export function useResetPassword() {
  return useMutation({
    mutationFn: (v: { id: number; newPassword: string }) => resetPassword(v.id, v.newPassword),
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
