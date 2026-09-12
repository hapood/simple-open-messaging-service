export const FEDERATION_PEER_HEALTH_RECOVERED =
  'federation.peer-health.recovered' as const;

/** Emitted when a peer's trust level transitions degraded → available. */
export interface FederationPeerHealthRecovered {
  peerDomain: string;
}
