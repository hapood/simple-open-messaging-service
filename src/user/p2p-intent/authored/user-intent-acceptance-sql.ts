import { sql, type SQL } from 'drizzle-orm';
import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../../../federation/federation-history-access-setting.js';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import {
  userIntentClientBodiesSql,
  userIntentPeerWriteSql,
  type UserIntentFeedInput,
} from './user-intent-client-feed-sql.js';
import { threadFanoutAdmissionSql } from '../../../common/sql/thread-content-fanout-admission-sql.js';
import { userIntentSystemParticipantsSql } from './user-intent-system-participants-sql.js';

export interface UserIntentAcceptanceInput extends UserIntentFeedInput {
  /** '' for an ACK entry; the crossed requester's note survives the REQ collapse. */
  note: string;
  acceptedAt: Date;
  /** Alternate validated writer used by received peer intents. */
  authoredSql?: SQL;
}

/** One composed statement for the confirmed friendship: the actor authors
 * ACCEPTED, a live local peer direction is promoted (the reverse upgrade keeps
 * it from expiring under an active pair), the pair activates with audiences,
 * fresh read windows, and the FRIEND_ADDED system message whose thread fan-out
 * is admitted here. The retained-history audiences stay untouched; only missing
 * rows are inserted. Remote-peer synchronization state is prepared by the
 * existing relationship initializer inside the same transaction. Every intent
 * row is addressed by the actor/target coordinates the caller holds. */
export function userIntentAcceptanceSql(input: UserIntentAcceptanceInput): SQL {
  const remote = input.targetDomain !== 'local';
  const authoredSql =
    input.authoredSql ??
    authoredIntentWriteSql({
      author: {
        account: input.actorAccount,
        namespaceId: input.actorNamespaceId,
      },
      receiver: {
        account: input.targetAccount,
        namespaceId: input.targetNamespaceId,
      },
      threadId: input.threadId,
      status: 'ACCEPTED',
      note: input.note,
      requestedAt: input.acceptedAt,
      expiresAt: null,
    });
  return sql`
    WITH join_source AS MATERIALIZED (
      SELECT p.active AS "wasActive", t."curSeq"
      FROM "RelationshipPair" p JOIN "MessageThread" t ON t.id = p."threadId"
      WHERE p.id = ${input.pairId}
    ), authored AS (
      ${authoredSql}
    ), accepted AS MATERIALIZED (
      SELECT "authorAccount", "authorNamespaceId", status, "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT "authorAccount", "authorNamespaceId", status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.actorAccount} AND "authorNamespaceId" = ${input.actorNamespaceId}
        AND "receiverAccount" = ${input.targetAccount} AND "receiverNamespaceId" = ${input.targetNamespaceId}
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), reverse_upgrade AS (
      UPDATE "RelationshipIntent" SET status = 'ACCEPTED', "expiresAt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "authorAccount" = ${input.targetAccount} AND "authorNamespaceId" = ${input.targetNamespaceId}
        AND "receiverAccount" = ${input.actorAccount} AND "receiverNamespaceId" = ${input.actorNamespaceId}
        AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
        AND ${remote ? sql`false` : sql`true`} AND EXISTS (SELECT 1 FROM authored)
      RETURNING "authorAccount", "authorNamespaceId", status, "profileRev", note, "requestedAt", "expiresAt"
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = true, established = true,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND NOT active AND EXISTS (SELECT 1 FROM accepted)
      RETURNING id
    ), ${userIntentClientBodiesSql({
      ...input,
      ownState: 'accepted',
      // The reverse upgrade's base-table effect is invisible to this
      // statement's snapshot, so the reverse direction publishes from the
      // upgrade's read-back.
      reverseState: 'reverse_upgrade',
      // The published body represents the post-activation pair even though
      // sibling CTEs otherwise see the statement snapshot.
      establishedOverride: sql`(SELECT true FROM pair_change)`,
    })}, audience_local AS (
      INSERT INTO "ThreadAudience" ("threadId", "targetNamespaceId", "localUserId")
      SELECT ${input.threadId}, 0, a.id
      FROM "RelationshipPair" p, "Account" a
      WHERE p.id = ${input.pairId} AND a.domain = 'local' AND a."namespaceId" = 0
        AND ((p."endpointAAccount" = a.account AND p."endpointANamespaceId" = 0)
          OR (p."endpointBAccount" = a.account AND p."endpointBNamespaceId" = 0))
        AND EXISTS (SELECT 1 FROM pair_change)
      ON CONFLICT ("localUserId", "threadId") WHERE "localUserId" IS NOT NULL DO NOTHING
      RETURNING id
    ), audience_remote AS (
      INSERT INTO "ThreadAudience" ("threadId", "targetNamespaceId",
        "localUserId", "messageAccessAfterSeq")
      SELECT ${input.threadId}, ${input.targetNamespaceId}, NULL,
        CASE WHEN COALESCE((SELECT value <> 'false' FROM "SystemSetting"
          WHERE key = ${FEDERATION_HISTORY_ACCESS_SETTING_KEY}), true)
          THEN 0 ELSE (SELECT j."curSeq" FROM join_source j) END
      WHERE ${remote ? sql`true` : sql`false`} AND EXISTS (SELECT 1 FROM pair_change)
      ON CONFLICT ("targetNamespaceId", "threadId") WHERE "localUserId" IS NULL DO NOTHING
      RETURNING id
    ), seq_alloc AS (
      -- One update per row per statement: the round enable, the head
      -- allocation, and the touch share this single write.
      UPDATE "MessageThread" t SET "curSeq" = t."curSeq" + 1,
        "federationRoundsEnabled" = true, "updatedAt" = CURRENT_TIMESTAMP
      WHERE t.id = ${input.threadId} AND EXISTS (SELECT 1 FROM pair_change)
      RETURNING t."curSeq", t."tombstoneEndSeq"
    ), system_message AS (
      INSERT INTO "Message" ("threadId", seq, "contentType", content, "creatorAccount", "profileNamespaceId", "publisherNamespaceId", "updatedAt")
      SELECT ${input.threadId}, s."curSeq", 'SYSTEM'::"ContentType",
        jsonb_build_object('type', 'FRIEND_ADDED', 'participants',
          ${userIntentSystemParticipantsSql({ pairId: input.pairId, actorState: 'accepted' })}),
        '$system', 0, 0, CURRENT_TIMESTAMP
      FROM seq_alloc s
      RETURNING seq
    ), ${threadFanoutAdmissionSql({
      threadId: input.threadId,
      prefix: 'thread_fanout',
      federation: false,
    })},
    ${threadFanoutAdmissionSql({
      threadId: input.threadId,
      prefix: 'federation_fanout',
      federation: true,
    })}${
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
    SELECT v.status, v.note,
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
