import { sql } from 'drizzle-orm';
import {
  parseRequestSnapshot,
  type RequestSnapshot,
} from '../../../shared/request-snapshot.js';
import type { RelationshipIntentStatus } from '../../common/relationship-intent-state.js';

/** Only a locally authored request may introduce receiver presentation. */
export function authoredRequestSnapshotSql(input: {
  authorNamespaceId: number;
  status: RelationshipIntentStatus;
  snapshot: RequestSnapshot | null;
}) {
  if (input.status !== 'REQUESTED') {
    if (input.snapshot !== null) throw new Error('terminal intent cannot capture a snapshot');
    return sql`NULL::jsonb`;
  }
  if (input.authorNamespaceId !== 0 || input.status !== 'REQUESTED')
    throw new Error('only a local request may capture a receiver snapshot');
  return sql`${JSON.stringify(parseRequestSnapshot(input.snapshot))}::jsonb`;
}

/** A live request refresh keeps its send-time presentation. A new request after
 * expiration or a terminal direction replaces it, including explicit absence.
 * Acceptance and revocation never replace a previously captured snapshot. */
export function retainedRequestSnapshotSql() {
  return sql`CASE
    WHEN EXCLUDED.status = 'REQUESTED' AND (
      "RelationshipIntent".status <> 'REQUESTED'
      OR "RelationshipIntent"."expiresAt" <= CURRENT_TIMESTAMP
    ) THEN EXCLUDED.snapshot
    ELSE "RelationshipIntent".snapshot
  END`;
}
