import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  grantViewer,
  disableAdmin,
  enableAdmin,
  resetAdminTwoFactor,
  setAdminRole,
} from '@/api/admins';
import type { AdminRole } from '@/types/api';
import { invalidateSessionViews } from './use-sessions';

function useInvalidateAdmins() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['admin', 'admin-sessions'] }),
      qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
    ]);
}

export function useGrantViewer() {
  const invalidate = useInvalidateAdmins();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) => grantViewer(userId),
    onSuccess: () =>
      Promise.all([invalidate(), invalidateSessionViews(queryClient)]),
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
