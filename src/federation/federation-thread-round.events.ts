export const FEDERATION_THREAD_ROUND_WAKE =
  'federation.thread-round.wake' as const;

export interface FederationThreadRoundWake {
  threadId: number;
  peerDomain: string;
  namespaceId: number;
  direction: 'forward' | 'reverse' | 'meta' | 'both';
}
