import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listFederationPeers,
  getFederationPeer,
  federationPeerNamespaces,
  setActiveFederationPeerNamespace,
  blockFederationPeer,
  unblockFederationPeer,
  runFederationSelfCheck,
  type FederationPeersQuery,
} from '@/api/federation'

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

export function useFederationPeerNamespaces(domain: string | null) {
  return useQuery({
    queryKey: ['admin', 'federation', 'peers', domain, 'namespaces'],
    queryFn: () => federationPeerNamespaces(domain!),
    enabled: domain !== null,
  })
}

/** Single peer current-state (routed detail page). Distinct singular key 'peer' to avoid any overlap
 *  with the list ('peers', q) / events ('peers', domain, 'events') keys. */
export function useFederationPeer(domain: string | null) {
  return useQuery({
    queryKey: ['admin', 'federation', 'peer', domain],
    queryFn: () => getFederationPeer(domain!),
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

export function useSetActiveFederationPeerNamespace() {
  const invalidate = useInvalidateFederation()
  return useMutation({
    mutationFn: (v: { domain: string; namespaceId?: number }) =>
      setActiveFederationPeerNamespace(v.domain, v.namespaceId),
    onSuccess: invalidate,
  })
}

/** Manual-trigger self-check (not cached — it does real outbound probing each click). The report is the
 *  mutation's return value; callers render it in local state. */
export function useFederationSelfCheck() {
  return useMutation({
    mutationFn: (opts?: { ntpServer?: string; dnsResolver?: string }) => runFederationSelfCheck(opts),
  })
}
