export const FEDERATION_THREAD_ROUND_WAKE =
  'federation.thread-round.wake' as const;

export interface FederationThreadRoundWake {
  threadId: number;
  peerDomain: string;
  direction: 'forward' | 'reverse' | 'both';
  /** Present for a committed THREAD_CONTENT_HEAD. The scheduler retains only the newest pair. */
  head?: {
    feedId: string;
    messageEndSeq: number;
    tombstoneEndSeq: number;
    tombstoneMaxMessageSeq: number;
  };
}

export const FEDERATION_STATE_FEED_PUSH = 'federation.state-feed.push' as const;

export interface FederationStateFeedPush {
  peerDomain: string;
}
