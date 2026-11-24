export const FEDERATION_THREAD_ROUND_WAKE =
  'federation.thread-round.wake' as const;

export interface FederationThreadRoundWake {
  threadId: number;
  namespaceId: number;
  /** Callers do not choose a message cursor. `thread` starts the scheduler's
   * own message direction plus tombstone drain. `meta` is not a message pull. */
  mode: 'thread' | 'meta';
}
