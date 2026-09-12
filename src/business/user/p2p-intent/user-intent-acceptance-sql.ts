import { sql, type SQL } from 'drizzle-orm';
import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../../../federation/federation-history-access-setting.js';
import { authoredIntentWriteSql } from '../../shared/sql/authored-relationship-intent-sql.js';
import {
  userIntentClientBodiesSql,
  userIntentPeerWriteSql,
  type UserIntentFeedInput,
} from './user-intent-client-feed-sql.js';

function threadFanoutScopeKey(threadId: number): string {
  return JSON.stringify(['THREAD_FANOUT', threadId]);
}

export interface UserIntentAcceptanceInput extends UserIntentFeedInput {
  actorSide: 'A' | 'B';
  reverseSide: 'A' | 'B';
  actorAccount: string;
  targetAccount: string;
  targetDomain: string;
  targetNamespaceId: number;
  /** '' for an ACK entry; the crossed requester's note survives the REQ collapse. */
  note: string;
  acceptedAt: Date;
}

/** One composed statement for the confirmed friendship: the actor authors
 * ACCEPTED, a live local peer direction is promoted (the reverse upgrade keeps
 * it from expiring under an active pair), the pair activates with audiences,
 * fresh read windows, and the FRIEND_ADDED system message whose thread fan-out
 * is admitted here. The retained-history audiences stay untouched; only missing
 * rows are inserted. Remote-peer synchronization state is prepared by the
 * existing relationship initializer inside the same transaction. */
export function userIntentAcceptanceSql(input: UserIntentAcceptanceInput): SQL {
  const remote = input.targetDomain !== 'local';
  const threadScope = threadFanoutScopeKey(input.threadId);
  return sql`
    WITH join_source AS MATERIALIZED (
      SELECT p.active AS "wasActive", t."curSeq"
      FROM "RelationshipPair" p JOIN "MessageThread" t ON t.id = p."threadId"
      WHERE p.id = ${input.pairId}
    ), authored AS (
      ${authoredIntentWriteSql({
        pair: { id: input.pairId, threadId: input.threadId },
        authorSide: input.actorSide,
        status: 'ACCEPTED',
        note: input.note,
        requestedAt: input.acceptedAt,
        expiresAt: null,
      })}
    ), accepted AS MATERIALIZED (
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent" WHERE "pairId" = ${input.pairId}
        AND "authorSide" = ${input.actorSide}
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), reverse_upgrade AS (
      UPDATE "RelationshipIntent" SET status = 'ACCEPTED', "expiresAt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "pairId" = ${input.pairId} AND "authorSide" = ${input.reverseSide}
        AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
        AND ${remote ? sql`false` : sql`true`} AND EXISTS (SELECT 1 FROM authored)
      RETURNING "authorSide"
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = true, established = true,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND NOT active AND EXISTS (SELECT 1 FROM accepted)
      RETURNING id
    ), ${userIntentClientBodiesSql({
      ...input,
      ownState: 'accepted',
      // The published body mirrors the post-activation pair, like the legacy
      // writer that runs after reconcileFriendPair.
      establishedOverride: sql`(SELECT true FROM pair_change)`,
    })}, audience_local AS (
      INSERT INTO "ThreadAudience" ("threadId", "targetDomain", "targetNamespaceId", "localUserId")
      SELECT ${input.threadId}, 'local', 0, a.id
      FROM "RelationshipPair" p, "Account" a
      WHERE p.id = ${input.pairId} AND a.domain = 'local' AND a."namespaceId" = 0
        AND ((p."endpointAAccount" = a.account AND p."endpointADomain" = 'local')
          OR (p."endpointBAccount" = a.account AND p."endpointBDomain" = 'local'))
        AND EXISTS (SELECT 1 FROM pair_change)
      ON CONFLICT ("targetDomain", "localUserId", "threadId") WHERE "targetDomain" = 'local' DO NOTHING
      RETURNING id
    ), audience_remote AS (
      INSERT INTO "ThreadAudience" ("threadId", "targetDomain", "targetNamespaceId",
        "localUserId", "messageAccessAfterSeq")
      SELECT ${input.threadId}, ${input.targetDomain}, ${input.targetNamespaceId}, NULL,
        CASE WHEN COALESCE((SELECT value <> 'false' FROM "SystemSetting"
          WHERE key = ${FEDERATION_HISTORY_ACCESS_SETTING_KEY}), true)
          THEN 0 ELSE (SELECT j."curSeq" FROM join_source j) END
      WHERE ${remote ? sql`true` : sql`false`} AND EXISTS (SELECT 1 FROM pair_change)
      ON CONFLICT ("targetNamespaceId", "threadId") WHERE "targetDomain" <> 'local' DO NOTHING
      RETURNING id
    ), seq_alloc AS (
      -- One update per row per statement: the round enable, the head
      -- allocation, and the touch share this single write.
      UPDATE "MessageThread" t SET "curSeq" = t."curSeq" + 1,
        "federationRoundsEnabled" = true, "updatedAt" = CURRENT_TIMESTAMP
      WHERE t.id = ${input.threadId} AND EXISTS (SELECT 1 FROM pair_change)
      RETURNING t."curSeq", t."tombstoneEndSeq"
    ), system_message AS (
      INSERT INTO "Message" ("threadId", seq, "contentType", content, "creatorAccount", "creatorDomain", "updatedAt")
      SELECT ${input.threadId}, s."curSeq", 'SYSTEM'::"ContentType",
        '{"type":"FRIEND_ADDED"}'::jsonb, '$system', 'local', CURRENT_TIMESTAMP
      FROM seq_alloc s
      RETURNING seq
    ), thread_fanout_merge AS (
      UPDATE "DurableTask" d SET payload = jsonb_build_object(
        'threadId', ${input.threadId}::integer,
        'messageEndSeq', GREATEST((d.payload->>'messageEndSeq')::bigint, (SELECT seq FROM system_message)),
        'tombstoneEndSeq', GREATEST((d.payload->>'tombstoneEndSeq')::bigint,
          (SELECT "tombstoneEndSeq" FROM seq_alloc)))
      WHERE d.kind = 'PROJECTION' AND d."scopeType" = 'THREAD'
        AND d."scopeKey" = ${threadScope} AND d."taskType" = 'FAN_OUT_THREAD_CONTENT'
        AND d.status = 'PENDING' AND EXISTS (SELECT 1 FROM system_message)
      RETURNING d.id
    ), thread_fanout_insert AS (
      INSERT INTO "DurableTask"
        (kind, "scopeType", "scopeKey", "taskType", payload, "coalescingKey", status)
      SELECT 'PROJECTION'::"DurableTaskKind", 'THREAD'::"DurableTaskScopeType", ${threadScope},
        'FAN_OUT_THREAD_CONTENT',
        jsonb_build_object('threadId', ${input.threadId}::integer,
          'messageEndSeq', (SELECT seq FROM system_message),
          'tombstoneEndSeq', (SELECT "tombstoneEndSeq" FROM seq_alloc)),
        ${threadScope}, 'PENDING'::"DurableTaskStatus"
      WHERE EXISTS (SELECT 1 FROM system_message) AND NOT EXISTS (SELECT 1 FROM thread_fanout_merge)
      RETURNING id
    )${
      remote
        ? sql`, ${userIntentPeerWriteSql({
            ...input,
            ownState: 'accepted',
            revoked: false,
            always: true,
            resultName: 'peer_result',
          })}`
        : sql``
    }
    SELECT v.id::text AS "requestId", v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM reverse_upgrade) AS "reverseUpgraded",
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM audience_local) OR EXISTS (SELECT 1 FROM audience_remote) AS "audienceChanged",
      (SELECT seq FROM system_message) AS "systemMessageSeq",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('userId', r."userId", 'feedId', r."feedId")
        ORDER BY r."userId") FROM recipient_result r), '[]'::jsonb) AS "clientUpdates",
      ${remote ? sql`(SELECT max("feedId") FROM peer_result)` : sql`NULL::text`} AS "peerFeedId"
    FROM accepted v
    CROSS JOIN (SELECT count(*) FROM seq_alloc) thread_barrier
  `;
}
