import { sql, type SQL } from 'drizzle-orm';
import type { RelationshipIntentStatus } from '../../../shared/relationship-intent-state.js';

/** Wire-carried intent coordinates applied verbatim on a mirror. The authored
 * fragment (`authoredIntentWriteSql`) derives the profile reference and thread
 * heads from GroupAccount and the local tail, which is wrong on a mirror: the
 * coordinates are the origin's. Change detection covers every wire field so a
 * repeated identical item neither writes nor wakes. */
export function mirrorIntentWriteSql(params: {
  pairId: bigint;
  authorSide: 'A' | 'B';
  status: RelationshipIntentStatus;
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
  profileRev: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
}) {
  return sql`
      INSERT INTO "RelationshipIntent" (
        "pairId", "authorSide", status, "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.pairId}, ${params.authorSide},
        ${params.status}::"RelationshipIntentStatus", ${params.profileRev}, ${params.note.slice(0, 255)},
        ${params.status === 'REVOKED' ? 0 : params.messageEndSeq},
        ${params.status === 'REVOKED' ? 0 : params.tombstoneEndSeq},
        ${params.requestedAt}, ${params.expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        "messageEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."messageEndSeq" ELSE EXCLUDED."messageEndSeq" END,
        "tombstoneEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."tombstoneEndSeq" ELSE EXCLUDED."tombstoneEndSeq" END,
        "profileRev" = CASE
          WHEN "RelationshipIntent".status = 'REVOKED'
            AND EXCLUDED.status = 'REQUESTED' THEN EXCLUDED."profileRev"
          ELSE "RelationshipIntent"."profileRev"
        END,
        "requestedAt" = EXCLUDED."requestedAt", "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "RelationshipIntent"."messageEndSeq" IS DISTINCT FROM EXCLUDED."messageEndSeq"
         OR "RelationshipIntent"."tombstoneEndSeq" IS DISTINCT FROM EXCLUDED."tombstoneEndSeq"
         OR "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
         OR "RelationshipIntent"."requestedAt" IS DISTINCT FROM EXCLUDED."requestedAt"
         OR "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING id, status, "profileRev", note, "requestedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq"
  `;
}

/** Persisted-intent read-back: the statement's own write when it fired, else the
 * pre-statement row. Sibling CTEs cannot see one another's base-table writes. */
export function mirrorIntentReadBackSql(params: {
  writeName: string;
  readBackName: string;
  pairId: bigint;
  authorSide: 'A' | 'B';
}): SQL {
  return sql`
    ${sql.raw(params.readBackName)} AS MATERIALIZED (
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt"
        FROM ${sql.raw(params.writeName)}
      UNION ALL
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent" WHERE "pairId" = ${params.pairId}
        AND "authorSide" = ${params.authorSide}
        AND NOT EXISTS (SELECT 1 FROM ${sql.raw(params.writeName)})
    )`;
}

export interface MirrorGroupPresentationInput {
  groupAccount: string;
  groupDomain: string;
  groupNamespaceId: number;
  groupName: string;
  groupAvatar: string;
  groupDescription: string;
  groupProfileRev: number;
}

/** The invitee-facing compaction key: same tuple ClientStateFeedService uses,
 * with the group's federation namespace in the identity position. */
export function mirrorIntentCompactionKey(input: {
  groupNamespaceId: number;
  groupAccount: string;
  groupDomain: string;
  memberAccount: string;
}): string {
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    input.groupNamespaceId,
    input.groupAccount,
    input.groupDomain,
    input.memberAccount,
    'local',
  ]);
}

/** The invitee's RELATIONSHIP_INTENT feed body for a received group intent:
 * status, note, timestamps, thread, and
 * the group presentation, isLocal false). `established` mirrors the pair's
 * sticky flag: a kicked former member must read true (sibling CTE reads see
 * the pre-statement snapshot, so a same-statement deactivation stays sticky). */
export function mirrorIntentFeedBodySql(params: {
  status: SQL | string;
  note: SQL;
  requestedAt: SQL;
  expiresAt: SQL;
  established: SQL;
  threadId: number;
  presentation: MirrorGroupPresentationInput;
}): SQL {
  return sql`jsonb_build_object('status', ${params.status}, 'note', ${params.note},
      'requestedAt', ${params.requestedAt}, 'expiresAt', ${params.expiresAt},
      'established', ${params.established},
      'threadId', ${params.threadId}::integer,
      'group', jsonb_build_object('account', ${params.presentation.groupAccount}::text,
        'domain', ${params.presentation.groupDomain}::text, 'isLocal', false,
        'name', ${params.presentation.groupName}::text, 'avatar', ${params.presentation.groupAvatar}::text,
        'description', ${params.presentation.groupDescription}::text,
        'profileRev', ${params.presentation.groupProfileRev}::integer))`;
}

/** Millisecond wire timestamps from nullable timestamp columns. */
export function epochMillisSql(column: SQL): SQL {
  return sql`CASE WHEN ${column} IS NULL THEN NULL
    ELSE floor(extract(epoch FROM ${column}) * 1000)::bigint END`;
}
