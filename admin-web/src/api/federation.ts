import { request } from '@/api/client'
import type { FederatedPeerListResult, FederatedPeerEvent } from '@/types/api'

export interface FederationPeersQuery {
  skip?: number
  take?: number
  search?: string
  status?: string // trustLevel filter: pending | trusted | demoted | blocked
}

export function listFederationPeers(q: FederationPeersQuery): Promise<FederatedPeerListResult> {
  return request<FederatedPeerListResult>('/admin/federation/peers', q)
}

/** The domain is a single path segment (dots are fine; never a slash), so it routes as :domain. */
export function federationPeerEvents(domain: string, take?: number): Promise<FederatedPeerEvent[]> {
  return request<FederatedPeerEvent[]>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/events`,
    { take },
  )
}

export function blockFederationPeer(domain: string, note?: string): Promise<void> {
  return request<void>(`/admin/federation/peers/${encodeURIComponent(domain)}/block`, { note })
}

export function unblockFederationPeer(domain: string): Promise<void> {
  return request<void>(`/admin/federation/peers/${encodeURIComponent(domain)}/unblock`)
}
