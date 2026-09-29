import { request } from '@/api/client';
import type {
  FederationPeerState,
  FederationPeerStateListResult,
  FederationNamespace,
  FederationNamespaceSwitchResult,
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
): Promise<FederationPeerStateListResult> {
  return request<FederationPeerStateListResult>('/admin/federation/peers', q);
}

/** Single peer's current lifecycle state (the routed detail page's source — deep-linkable by domain). */
export function getFederationPeer(domain: string): Promise<FederationPeerState> {
  return request<FederationPeerState>(
    `/admin/federation/peers/${encodeURIComponent(domain)}`,
  );
}

export function federationPeerNamespaces(
  domain: string,
): Promise<FederationNamespace[]> {
  return request<FederationNamespace[]>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/namespaces`,
  );
}

export function setActiveFederationPeerNamespace(
  domain: string,
  namespaceId?: number,
): Promise<FederationNamespaceSwitchResult> {
  return request<FederationNamespaceSwitchResult>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/namespaces/active`,
    namespaceId === undefined ? {} : { namespaceId },
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
