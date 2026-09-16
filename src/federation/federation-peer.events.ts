export const FEDERATION_PEER_AVAILABLE = 'federation.peer.available' as const;

/** Emitted after peer acceptance and reachability make ordinary outbound work eligible. */
export interface FederationPeerAvailable {
  peerDomain: string;
}
