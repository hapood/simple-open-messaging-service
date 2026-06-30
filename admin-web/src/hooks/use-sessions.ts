import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listAllSessions, purgeAllSessions } from '@/api/sessions'

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
