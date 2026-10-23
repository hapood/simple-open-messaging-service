import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  grantViewer,
  disableAdmin,
  enableAdmin,
  listAdmins,
  resetAdminTwoFactor,
  setAdminRole,
  type AdminsQuery,
} from '@/api/admins';
import type { AdminRole } from '@/types/api';

function useInvalidateAdmins() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['admin', 'admins'] }),
      qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
    ]);
}

export function useAdmins(q: AdminsQuery) {
  return useQuery({
    queryKey: ['admin', 'admins', q],
    queryFn: () => listAdmins(q),
    placeholderData: (prev) => prev,
  });
}

export function useGrantViewer() {
  const invalidate = useInvalidateAdmins();
  return useMutation({
    mutationFn: (userId: number) => grantViewer(userId),
    onSuccess: invalidate,
  });
}

export function useDisableAdmin() {
  const invalidate = useInvalidateAdmins();
  return useMutation({
    mutationFn: (id: number) => disableAdmin(id),
    onSuccess: invalidate,
  });
}

export function useEnableAdmin() {
  const invalidate = useInvalidateAdmins();
  return useMutation({
    mutationFn: (id: number) => enableAdmin(id),
    onSuccess: invalidate,
  });
}

export function useSetAdminRole() {
  const invalidate = useInvalidateAdmins();
  return useMutation({
    mutationFn: (v: { id: number; role: AdminRole }) =>
      setAdminRole(v.id, v.role),
    onSuccess: invalidate,
  });
}

export function useResetAdminTwoFactor() {
  const invalidate = useInvalidateAdmins();
  return useMutation({
    mutationFn: (id: number) => resetAdminTwoFactor(id),
    onSuccess: invalidate,
  });
}
