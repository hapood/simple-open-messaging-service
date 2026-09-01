export const FEDERATION_STATE_EVENT_TYPES = [
  'RELATIONSHIP_INTENT',
  'GROUP_META_FEED_HEAD',
  'THREAD_CONTENT_HEAD',
] as const;

export type FederationStateEventType =
  (typeof FEDERATION_STATE_EVENT_TYPES)[number];

const federationStateEventTypes = new Set<string>(
  FEDERATION_STATE_EVENT_TYPES,
);

export function isFederationStateEventType(
  value: unknown,
): value is FederationStateEventType {
  return typeof value === 'string' && federationStateEventTypes.has(value);
}
