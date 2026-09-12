import { sql, type SQL } from 'drizzle-orm';
import type { RelationshipIntentStatus } from '../../../relationship/relationship-intent-state.js';

/** Parameterized authored-intent write. The caller owns the pair lock and validates the transition.
 * Keep the authored profile reference across acceptance/revocation and preserve revoked heads. */
export function authoredIntentWriteSql(params: {
  pair: { id: bigint; threadId: number };
  authorSide: 'A' | 'B';
  status: RelationshipIntentStatus;
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
}) {
  const { status, requestedAt, expiresAt } = params;
  return sql`
      INSERT INTO "RelationshipIntent" (
        "pairId", "authorSide", status, "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.pair.id}, ${params.authorSide},
        ${status}::"RelationshipIntentStatus",
        COALESCE((
          SELECT CASE
            WHEN ${params.authorSide} = 'A' AND pair."endpointAType" = 'USER' THEN
              (SELECT profile."defaultProfileRev" FROM "Account" profile
                WHERE profile.account = pair."endpointAAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
            WHEN ${params.authorSide} = 'B' AND pair."endpointBType" = 'USER' THEN
              (SELECT profile."defaultProfileRev" FROM "Account" profile
                WHERE profile.account = pair."endpointBAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
            WHEN ${params.authorSide} = 'A' AND pair."endpointAType" = 'GROUP' THEN
              (SELECT profile."defaultProfileRev" FROM "GroupAccount" profile
                WHERE profile.account = pair."endpointAAccount" LIMIT 1)
            WHEN ${params.authorSide} = 'B' AND pair."endpointBType" = 'GROUP' THEN
              (SELECT profile."defaultProfileRev" FROM "GroupAccount" profile
                WHERE profile.account = pair."endpointBAccount" LIMIT 1)
          END
          FROM "RelationshipPair" pair WHERE pair.id = ${params.pair.id}
         ), 0), ${(params.note ?? '').slice(0, 255)},
        COALESCE((SELECT MAX(m.seq) FROM "Message" m
          WHERE m."threadId" = ${params.pair.threadId} AND m."contentType" <> 'SYSTEM'), 0),
        COALESCE((SELECT MAX(d."deletionSeq") FROM "DeletedMessage" d
          JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
          WHERE d."threadId" = ${params.pair.threadId} AND d."sourceNamespaceId" = 0), 0),
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
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
        "requestedAt" = CASE
          WHEN EXCLUDED.status IN ('REQUESTED', 'ACCEPTED') THEN EXCLUDED."requestedAt"
          ELSE "RelationshipIntent"."requestedAt" END,
        "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
         OR "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING id, status, "profileRev", note, "requestedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq"
  `;
}

/** Decision-time manager notification is a projection status flip only: no client
 * feed row, no feed allocation, and no head write. Request-time fields stay as
 * first written. The flip touches only the member's existing projection rows for
 * the given directions; `status IS DISTINCT FROM` keeps repeats write-free.
 * RETURNING is the caller's dependency signal (empty = nothing changed). */
export function managerProjectionFlipSql(params: {
  threadId: number;
  memberAccount: string;
  memberDomain: string;
  memberNamespaceId: number;
  managerIds: readonly number[];
  status: 'ACCEPTED' | 'REVOKED';
  directions: readonly ('APPLICATION' | 'INVITATION')[];
}): SQL {
  return sql`
    manager_requests AS MATERIALIZED (
      SELECT r.*
      FROM "GroupRequestProjection" r
      WHERE r."threadId" = ${params.threadId} AND r."memberAccount" = ${params.memberAccount}
        AND r."memberDomain" = ${params.memberDomain} AND r."memberNamespaceId" = ${params.memberNamespaceId}
        AND r.direction = ANY(${sql.param(params.directions)}::text[])
        AND r."managerUserId" = ANY(${sql.param(params.managerIds)}::integer[])
        AND r.status IS DISTINCT FROM ${params.status}
    ), request_projection AS (
      UPDATE "GroupRequestProjection" r SET status = ${params.status}, "updatedAt" = CURRENT_TIMESTAMP
      FROM manager_requests p
      WHERE r."managerUserId" = p."managerUserId" AND r."threadId" = p."threadId" AND r."memberAccount" = p."memberAccount"
        AND r."memberDomain" = p."memberDomain" AND r."memberNamespaceId" = p."memberNamespaceId" AND r.direction = p.direction
      RETURNING r."managerUserId"
    )`;
}

/** Merge-then-insert admission for one thread fan-out task type. The owning
 * statement must compose `system_message` and `seq_alloc` CTEs: the roster
 * effect that requires projection is exactly the system message they produced,
 * so message existence is both the admission gate and the payload's forward
 * head. A PENDING task merges the new heads instead of a second row; running
 * tasks are never touched. The payload carries forward heads only — the fan-out
 * executor reconciles the group meta head itself at execution time. */
export function threadFanoutAdmissionSql(params: {
  threadId: number;
  /** CTE name prefix; must be unique within the owning statement. */
  prefix: string;
  federation: boolean;
}): SQL {
  const scopeKey = JSON.stringify([
    params.federation ? 'FEDERATION_THREAD_FANOUT' : 'THREAD_FANOUT',
    params.threadId,
  ]);
  const taskType = params.federation
    ? 'FAN_OUT_FEDERATION_THREAD_CONTENT'
    : 'FAN_OUT_THREAD_CONTENT';
  const prefix = sql.raw(params.prefix);
  return sql`
    ${prefix}_merge AS (
      UPDATE "DurableTask" d SET payload = jsonb_build_object(
        'threadId', ${params.threadId}::integer,
        'messageEndSeq', GREATEST((d.payload->>'messageEndSeq')::bigint, (SELECT seq FROM system_message)),
        'tombstoneEndSeq', GREATEST((d.payload->>'tombstoneEndSeq')::bigint,
          (SELECT "tombstoneEndSeq" FROM seq_alloc)))
      WHERE EXISTS (SELECT 1 FROM system_message) AND d.kind = 'PROJECTION'
        AND d."scopeType" = 'THREAD' AND d."scopeKey" = ${scopeKey}
        AND d."taskType" = ${taskType} AND d.status = 'PENDING'
      RETURNING d.id
    ), ${prefix}_insert AS (
      INSERT INTO "DurableTask"
        (kind, "scopeType", "scopeKey", "taskType", payload, "coalescingKey", status)
      SELECT 'PROJECTION'::"DurableTaskKind", 'THREAD'::"DurableTaskScopeType", ${scopeKey},
        ${taskType},
        jsonb_build_object('threadId', ${params.threadId}::integer,
          'messageEndSeq', (SELECT seq FROM system_message),
          'tombstoneEndSeq', (SELECT "tombstoneEndSeq" FROM seq_alloc)),
        ${scopeKey}, 'PENDING'::"DurableTaskStatus"
      WHERE EXISTS (SELECT 1 FROM system_message)
        AND NOT EXISTS (SELECT 1 FROM ${prefix}_merge)
      RETURNING id
    )`;
}
