import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { continuePeer, continueUser, getBreakers } from '@/api/quota'
import type { ContinueQuotaInput } from '@/types/api'

/** All currently-tripped circuit breakers (peers + users). Polled every 10s so the banner reflects trips in
 *  near-real-time without a manual refresh; disabled polling when the tab is hidden (react-query default). */
export function useBreakers() {
  return useQuery({
    queryKey: ['admin', 'quota', 'breakers'],
    queryFn: getBreakers,
    // Keep the banner fresh while there is something to show; back off once clear.
    refetchInterval: (query) => {
      const data = query.state.data
      const any = !!data && (data.peers.length > 0 || data.users.length > 0)
      return any ? 10_000 : 60_000
    },
  })
}

/** Add today's additive quota to a tripped federated peer; invalidates the breakers + per-peer quota views. */
export function useContinuePeer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ domain, input }: { domain: string; input: ContinueQuotaInput }) =>
      continuePeer(domain, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'quota', 'breakers'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'quota', 'nodes'] }),
      ]),
  })
}

/** Add today's additive quota to a tripped local user; invalidates the breakers + per-user quota views. */
export function useContinueUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, input }: { userId: number; input: ContinueQuotaInput }) =>
      continueUser(userId, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'quota', 'breakers'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
      ]),
  })
}
