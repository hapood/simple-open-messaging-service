export type RelationshipIntentStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';

export interface RelationshipIntentSnapshot {
  status: RelationshipIntentStatus;
  expiresAt: Date | string | null;
}

export interface RelationshipIntentTransition {
  state: 'CONFIRMED' | 'UNCONFIRMED';
  promoteLocalRequest: boolean;
}

const timestamp = (value: Date | string): number =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

/** Whether one authored direction is currently a positive relationship fact. */
export function isEffectiveRelationshipIntent(
  intent: RelationshipIntentSnapshot | undefined,
  now: Date,
): boolean {
  if (!intent || intent.status === 'REVOKED') return false;
  if (intent.status === 'ACCEPTED') return true;
  return (
    intent.expiresAt !== null && timestamp(intent.expiresAt) > now.getTime()
  );
}

/**
 * Derive the relationship effect of two independently authored directions.
 * A crossed request confirms immediately, but the caller must persist the
 * requested local promotion atomically with confirmed-dependent effects.
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
