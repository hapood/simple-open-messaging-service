export const FEDERATION_NAMESPACE_PAUSED =
  'federation.namespace.paused' as const;
export const FEDERATION_NAMESPACE_RESUMED =
  'federation.namespace.resumed' as const;

export interface FederationNamespaceSchedulingEvent {
  namespaceId: number;
}

export const FEDERATION_PEER_AVAILABLE = 'federation.peer.available' as const;

/** Emitted after peer acceptance and reachability make ordinary outbound work eligible. */
export interface FederationPeerAvailable {
  peerDomain: string;
}
