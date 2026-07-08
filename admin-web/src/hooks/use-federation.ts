import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listFederationPeers,
  federationPeerEvents,
  blockFederationPeer,
  unblockFederationPeer,
  type FederationPeersQuery,
} from '@/api/federation'

/** Invalidate the whole federation namespace — both the peers list and any open peer's event timeline
 *  (the timeline key is nested under ['admin','federation',...], so this refetches it too). */
function useInvalidateFederation() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['admin', 'federation'] })
}

export function useFederationPeers(q: FederationPeersQuery) {
  return useQuery({
    queryKey: ['admin', 'federation', 'peers', q],
    queryFn: () => listFederationPeers(q),
    placeholderData: (prev) => prev,
  })
}

export function useFederationPeerEvents(domain: string | null) {
  return useQuery({
    queryKey: ['admin', 'federation', 'peers', domain, 'events'],
    queryFn: () => federationPeerEvents(domain!),
    enabled: domain !== null,
  })
}

export function useBlockFederationPeer() {
  const invalidate = useInvalidateFederation()
  return useMutation({
    mutationFn: (v: { domain: string; note?: string }) => blockFederationPeer(v.domain, v.note),
    onSuccess: invalidate,
  })
}

export function useUnblockFederationPeer() {
  const invalidate = useInvalidateFederation()
  return useMutation({
    mutationFn: (domain: string) => unblockFederationPeer(domain),
    onSuccess: invalidate,
  })
}
