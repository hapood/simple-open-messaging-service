export type RelationshipIntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
export type RelationshipPairKind = 'P2P' | 'GROUP_MEMBER';

export const RELATIONSHIP_INTENT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RelationshipIntentSnapshot {
  status: RelationshipIntentStatus;
  expiresAt: Date | null;
}

export interface RelationshipIntentTransition {
  state: 'CONFIRMED' | 'UNCONFIRMED';
  promoteLocalRequest: boolean;
}

/** Whether one authored direction is currently a positive relationship fact. */
export function isEffectiveRelationshipIntent(
  intent: RelationshipIntentSnapshot | undefined,
  now: Date,
): boolean {
  if (!intent || intent.status === 'REVOKED') return false;
  if (intent.status === 'ACCEPTED') return true;
  return (
    intent.expiresAt !== null && intent.expiresAt.getTime() > now.getTime()
  );
}

/**
 * Derive the relationship effect of two independently authored directions. A caller may promote
 * only the locally authored request when the two directions confirm the relationship.
 */
export function deriveRelationshipIntentTransition(
  local: RelationshipIntentSnapshot | undefined,
  reverse: RelationshipIntentSnapshot | undefined,
  now: Date,
): RelationshipIntentTransition {
  const confirmed =
    isEffectiveRelationshipIntent(local, now) &&
    isEffectiveRelationshipIntent(reverse, now);
  return {
    state: confirmed ? 'CONFIRMED' : 'UNCONFIRMED',
    promoteLocalRequest: confirmed && local?.status === 'REQUESTED',
  };
}
