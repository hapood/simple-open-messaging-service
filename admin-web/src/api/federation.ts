import { request } from '@/api/client';
import type {
  FederatedPeer,
  FederatedPeerListResult,
  FederatedPeerEvent,
  FederatedPeerNamespace,
  FederatedPeerNamespaceSwitchResult,
  SelfCheckReport,
} from '@/types/api';

export interface FederationPeersQuery {
  skip?: number;
  take?: number;
  search?: string;
  status?: string; // Federation v1 recognition lifecycle filter
}

export function listFederationPeers(
  q: FederationPeersQuery,
): Promise<FederatedPeerListResult> {
  return request<FederatedPeerListResult>('/admin/federation/peers', q);
}

/** Single peer's current lifecycle state (the routed detail page's source — deep-linkable by domain). */
export function getFederationPeer(domain: string): Promise<FederatedPeer> {
  return request<FederatedPeer>(
    `/admin/federation/peers/${encodeURIComponent(domain)}`,
  );
}

/** The domain is a single path segment (dots are fine; never a slash), so it routes as :domain. */
export function federationPeerEvents(
  domain: string,
  take?: number,
): Promise<FederatedPeerEvent[]> {
  return request<FederatedPeerEvent[]>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/events`,
    { take },
  );
}

export function federationPeerNamespaces(
  domain: string,
): Promise<FederatedPeerNamespace[]> {
  return request<FederatedPeerNamespace[]>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/namespaces`,
  );
}

export function setActiveFederationPeerNamespace(
  domain: string,
  namespaceId: number,
): Promise<FederatedPeerNamespaceSwitchResult> {
  return request<FederatedPeerNamespaceSwitchResult>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/namespaces/active`,
    { namespaceId },
  );
}

export function blockFederationPeer(
  domain: string,
  note?: string,
): Promise<void> {
  return request<void>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/block`,
    { note },
  );
}

export function unblockFederationPeer(domain: string): Promise<void> {
  return request<void>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/unblock`,
  );
}

/** Run the S2S handshake self-check. Both options are optional; the server defaults to
 *  ntp.aliyun.com and the system DNS resolver. */
export function runFederationSelfCheck(opts?: {
  ntpServer?: string;
  dnsResolver?: string;
}): Promise<SelfCheckReport> {
  return request<SelfCheckReport>('/admin/federation/self-check', opts);
}
