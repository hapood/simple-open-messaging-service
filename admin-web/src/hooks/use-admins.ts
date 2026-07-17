import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createAdmin,
  disableAdmin,
  enableAdmin,
  listAdmins,
  resetAdminTwoFactor,
  setAdminRole,
  type AdminsQuery,
} from '@/api/admins'
import type { AdminRole } from '@/types/api'

function useInvalidateAdmins() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['admin', 'admins'] })
}

export function useAdmins(q: AdminsQuery) {
  return useQuery({
    queryKey: ['admin', 'admins', q],
    queryFn: () => listAdmins(q),
    placeholderData: (prev) => prev,
  })
}

export function useCreateAdmin() {
  const invalidate = useInvalidateAdmins()
  return useMutation({
    mutationFn: (v: { userId: number; role: AdminRole }) => createAdmin(v.userId, v.role),
    onSuccess: invalidate,
  })
}

export function useDisableAdmin() {
  const invalidate = useInvalidateAdmins()
  return useMutation({ mutationFn: (id: number) => disableAdmin(id), onSuccess: invalidate })
}

export function useEnableAdmin() {
  const invalidate = useInvalidateAdmins()
  return useMutation({ mutationFn: (id: number) => enableAdmin(id), onSuccess: invalidate })
}

export function useSetAdminRole() {
  const invalidate = useInvalidateAdmins()
  return useMutation({
    mutationFn: (v: { id: number; role: AdminRole }) => setAdminRole(v.id, v.role),
    onSuccess: invalidate,
  })
}

export function useResetAdminTwoFactor() {
  const invalidate = useInvalidateAdmins()
  return useMutation({ mutationFn: (id: number) => resetAdminTwoFactor(id), onSuccess: invalidate })
}
