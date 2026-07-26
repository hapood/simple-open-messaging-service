import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listAllSessions, purgeAllSessions, revokeSession } from '@/api/sessions'

export interface SessionsQuery {
  skip: number
  take: number
  userId?: number
  ip?: string
}

export function useAllSessions(q: SessionsQuery) {
  return useQuery({
    queryKey: ['admin', 'sessions', q],
    queryFn: () => listAllSessions(q),
    placeholderData: (prev) => prev,
  })
}

export function usePurgeSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => purgeAllSessions(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'sessions'] }),
  })
}

/** Revoke one user session. Invalidates the system-wide list (['admin','sessions']) AND every user's
 *  device list (['admin','users', id, 'sessions']) — either may be the source of the action — but NOT
 *  the user list ['admin','users'] itself: a single session revoke changes neither the roster nor any
 *  user row, so needlessly refetching it is wasted work. */
export function useRevokeSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => revokeSession(id),
    onSuccess: () =>
      qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey
          return (
            (k[0] === 'admin' && k[1] === 'sessions') ||
            (k[0] === 'admin' && k[1] === 'users' && k[3] === 'sessions')
          )
        },
      }),
  })
}
