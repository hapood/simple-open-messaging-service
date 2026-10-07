import { request } from '@/api/client';
import type {
  FederationIdentityReview,
  FederationPeerNamespacesResult,
  FederationPeerState,
  FederationPeerStateListResult,
  FederationPredecessorCheckResult,
  FederationReviewDecisionResult,
  FederationRecognizeResult,
  LocalFederationRootEpoch,
  LocalFederationRootRotationResult,
  LocalFederationRootUnpublishResult,
  SelfCheckReport,
} from '@/types/api';

export interface FederationPeersQuery {
  skip?: number;
  take?: number;
  search?: string;
  status?: string; // Federation v1 recognition lifecycle filter
}

export function localFederationRootEpochs(): Promise<
  LocalFederationRootEpoch[]
> {
  return request<LocalFederationRootEpoch[]>(
    '/admin/federation/local-root-epochs',
  );
}

export function rotateLocalFederationRoot(): Promise<LocalFederationRootRotationResult> {
  return request<LocalFederationRootRotationResult>(
    '/admin/federation/local-root-epochs/rotate',
    {},
  );
}

export function unpublishLocalFederationRoot(
  rootId: number,
): Promise<LocalFederationRootUnpublishResult> {
  return request<LocalFederationRootUnpublishResult>(
    `/admin/federation/local-root-epochs/${rootId}/unpublish`,
    {},
  );
}

export function listFederationPeers(
  q: FederationPeersQuery,
): Promise<FederationPeerStateListResult> {
  return request<FederationPeerStateListResult>('/admin/federation/peers', q);
}

/** Single peer's current lifecycle state (the routed detail page's source — deep-linkable by domain). */
export function getFederationPeer(
  domain: string,
): Promise<FederationPeerState> {
  return request<FederationPeerState>(
    `/admin/federation/peers/${encodeURIComponent(domain)}`,
  );
}

export function federationPeerNamespaces(
  domain: string,
): Promise<FederationPeerNamespacesResult> {
  return request<FederationPeerNamespacesResult>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/namespaces`,
  );
}

export function federationPendingIdentityReviews(): Promise<
  FederationIdentityReview[]
> {
  return request<FederationIdentityReview[]>(
    '/admin/federation/identity-reviews',
  );
}

export function approveFederationIdentityReview(
  reviewId: number,
): Promise<FederationReviewDecisionResult> {
  return request<FederationReviewDecisionResult>(
    `/admin/federation/identity-reviews/${reviewId}/approve`,
    {},
  );
}

export function rejectFederationIdentityReview(
  reviewId: number,
): Promise<FederationReviewDecisionResult> {
  return request<FederationReviewDecisionResult>(
    `/admin/federation/identity-reviews/${reviewId}/reject`,
    {},
  );
}

/** Seal a fresh challenge under the pinned predecessor root and ask the peer
 *  to open it through its sealed-challenge service (rotation continuity). */
export function federationPredecessorCheck(
  reviewId: number,
): Promise<FederationPredecessorCheckResult> {
  return request<FederationPredecessorCheckResult>(
    `/admin/federation/identity-reviews/${reviewId}/predecessor-check`,
    {},
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

export function recognizeFederationPeer(
  domain: string,
): Promise<FederationRecognizeResult> {
  return request<FederationRecognizeResult>(
    `/admin/federation/peers/${encodeURIComponent(domain)}/recognize`,
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
