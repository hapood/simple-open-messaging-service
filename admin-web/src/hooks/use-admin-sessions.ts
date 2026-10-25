import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listAdminSessions, revokeAdminSession } from '@/api/admin-sessions';

export interface AdminSessionsQuery {
  skip: number;
  take: number;
  ip?: string;
}

export function useAdminSessions(q: AdminSessionsQuery) {
  return useQuery({
    queryKey: ['admin', 'admin-sessions', q],
    queryFn: () => listAdminSessions(q),
    placeholderData: (prev) => prev,
  });
}

export function useRevokeAdminSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeAdminSession(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'admin-sessions'] }),
  });
}
