export const FEDERATION_THREAD_ROUND_WAKE =
  'federation.thread-round.wake' as const;

export interface FederationThreadRoundWake {
  threadId: number;
  peerDomain: string;
  namespaceId: number;
  direction: 'forward' | 'reverse' | 'both';
}

export const FEDERATION_STATE_FEED_PUSH = 'federation.state-feed.push' as const;

export interface FederationStateFeedPush {
  peerDomain: string;
}
