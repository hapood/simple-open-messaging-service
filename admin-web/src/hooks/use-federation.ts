import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listFederationPeers,
  getFederationPeer,
  federationPeerNamespaces,
  approveFederationIdentityReview,
  federationPendingIdentityReviews,
  rejectFederationIdentityReview,
  blockFederationPeer,
  unblockFederationPeer,
  recognizeFederationPeer,
  type FederationPeersQuery,
} from '@/api/federation';

function useInvalidateFederation() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['admin', 'federation'] });
}

export function useFederationPeers(q: FederationPeersQuery) {
  return useQuery({
    queryKey: ['admin', 'federation', 'peers', q],
    queryFn: () => listFederationPeers(q),
    placeholderData: (prev) => prev,
  });
}

export function useFederationPeerNamespaces(domain: string | null) {
  return useQuery({
    queryKey: ['admin', 'federation', 'peers', domain, 'namespaces'],
    queryFn: () => federationPeerNamespaces(domain!),
    enabled: domain !== null,
  });
}

/** Single peer current-state (routed detail page). Distinct singular key 'peer' to avoid any overlap
 *  with the list ('peers', q) / events ('peers', domain, 'events') keys. */
export function useFederationPeer(domain: string | null) {
  return useQuery({
    queryKey: ['admin', 'federation', 'peer', domain],
    queryFn: () => getFederationPeer(domain!),
    enabled: domain !== null,
  });
}

export function useBlockFederationPeer() {
  const invalidate = useInvalidateFederation();
  return useMutation({
    mutationFn: (v: { domain: string; note?: string }) =>
      blockFederationPeer(v.domain, v.note),
    onSuccess: invalidate,
  });
}

export function useUnblockFederationPeer() {
  const invalidate = useInvalidateFederation();
  return useMutation({
    mutationFn: (domain: string) => unblockFederationPeer(domain),
    onSuccess: invalidate,
  });
}

export function useFederationPendingIdentityReviews() {
  return useQuery({
    queryKey: ['federation', 'identity-reviews'],
    queryFn: () => federationPendingIdentityReviews(),
  });
}

export function useApproveFederationIdentityReview() {
  const invalidate = useInvalidateFederation();
  return useMutation({
    mutationFn: (
      decision:
        | number
        | { reviewId: number; resolution: 'new-peer' | 'replace-identity' },
    ) =>
      typeof decision === 'number'
        ? approveFederationIdentityReview(decision)
        : approveFederationIdentityReview(
            decision.reviewId,
            decision.resolution,
          ),
    onSuccess: invalidate,
  });
}

export function useRejectFederationIdentityReview() {
  const invalidate = useInvalidateFederation();
  return useMutation({
    mutationFn: (reviewId: number) => rejectFederationIdentityReview(reviewId),
    onSuccess: invalidate,
  });
}

export function useRecognizeFederationPeer() {
  const invalidate = useInvalidateFederation();
  return useMutation({
    mutationFn: (domain: string) => recognizeFederationPeer(domain),
    onSuccess: invalidate,
  });
}
