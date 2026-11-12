import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  listAllSessions,
  purgeAllSessions,
  revokeSession,
} from '@/api/sessions';

export interface SessionsQuery {
  skip: number;
  take: number;
  userId?: number;
  ip?: string;
  client?: string;
}

/** Session mutations affect credentials, embedded detail views, and online summaries. */
export function invalidateSessionViews(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey: key }) =>
      key[0] === 'admin' &&
      (key[1] === 'sessions' ||
        key[1] === 'connections' ||
        key[1] === 'dashboard' ||
        (key[1] === 'users' && (key[3] === 'sessions' || key[3] === 'detail'))),
  });
}

export function useAllSessions(query: SessionsQuery, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'sessions', query],
    queryFn: () => listAllSessions(query),
    enabled,
  });
}

export function usePurgeSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: purgeAllSessions,
    onSuccess: () => invalidateSessionViews(queryClient),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeSession,
    onSuccess: () => invalidateSessionViews(queryClient),
  });
}
