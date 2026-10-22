export const FEDERATION_STATE_FEED_PUSH = 'federation.state-feed.push' as const;

export interface FederationStateFeedPush {
  namespaceId: number;
}

/** Narrow seam for scheduling State Feed push wake-ups. Consumers type their
 *  dependency against this interface so no type edge reaches the service
 *  classes (which would close a module-load cycle through state-pull /
 *  state-feed-consumer). FederationStateFeedPushService satisfies this
 *  structurally. */
export interface FederationStateFeedPusher {
  pushStateFeedNamespaces(namespaceIds: Iterable<number>): void;
}
