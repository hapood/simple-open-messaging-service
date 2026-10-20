import { sql, type SQL } from 'drizzle-orm';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import { userIntentSystemParticipantsSql } from './user-intent-system-participants-sql.js';
import {
  userIntentPeerWriteSql,
  type UserIntentFeedInput,
} from './user-intent-peer-feed-sql.js';

function threadFanoutScopeKey(threadId: number): string {
  return JSON.stringify(['THREAD_FANOUT', threadId]);
}

export interface UserIntentRevocationInput extends UserIntentFeedInput {
  /** Local Account.id of the actor (always set: the actor is authenticated locally). */
  localActorId: number;
  /** Local Account.id of the target, or null for a peer-hosted target. */
  localTargetId: number | null;
  /** Alternate validated writer used by received peer intents. */
  authoredSql?: SQL;
}

/** One composed statement for the user-authored REVOKED direction: withdraw,
 * reject, and end-friendship share it. Every departure effect — the
 * FRIEND_REMOVED message with its watermarks, the epoch bump, audience close,
 * thread/departure fan-outs — is gated on the
 * pair actually transitioning, so a pending withdraw costs only the intent
 * write and the recipient publications. */
export function userIntentRevocationSql(input: UserIntentRevocationInput): SQL {
  const remote = input.targetNamespaceId !== 0;
  const threadScope = threadFanoutScopeKey(input.threadId);
  const participants = userIntentSystemParticipantsSql({
    pairId: input.pairId,
    actorState: 'revocation',
  });
  // The initiator is whichever pair endpoint the command actor occupies.
  const content = sql`jsonb_build_object('type', 'FRIEND_REMOVED',
    'participants', ${participants},
    'initiator', ${participants}->(
      SELECT CASE WHEN p."endpointAAccount" = ${input.actorAccount}
          AND p."endpointANamespaceId" = ${input.actorNamespaceId}
        THEN 0 ELSE 1 END
      FROM "RelationshipPair" p WHERE p.id = ${input.pairId}))`;
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
      status: 'REVOKED',
      note: '',
      requestedAt: null,
      expiresAt: null,
    });
  return sql`
    WITH authored AS (
      ${authoredSql}
    ), revocation AS MATERIALIZED (
      SELECT "authorAccount", "authorNamespaceId", status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT "authorAccount", "authorNamespaceId", status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.actorAccount} AND "authorNamespaceId" = ${input.actorNamespaceId}
        AND "receiverAccount" = ${input.targetAccount} AND "receiverNamespaceId" = ${input.targetNamespaceId}
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND active IS DISTINCT FROM false
      RETURNING id
    ), departed AS MATERIALIZED (
      SELECT EXISTS (SELECT 1 FROM pair_change) AS departed
    ), seq_alloc AS (
      -- One update per row per statement: the epoch bump, the round disable,
      -- the head allocation, and the touch share this single write.
      UPDATE "MessageThread" t SET "curSeq" = t."curSeq" + 1,
        "authorizationEpoch" = t."authorizationEpoch" + 1,
        "federationRoundsEnabled" = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE t.id = ${input.threadId} AND EXISTS (SELECT 1 FROM pair_change)
      RETURNING t."curSeq", t."tombstoneEndSeq"
    ), system_message AS (
      INSERT INTO "Message" ("threadId", seq, "contentType", content, "creatorAccount", "profileNamespaceId", "publisherNamespaceId", "updatedAt")
      SELECT ${input.threadId}, s."curSeq", 'SYSTEM'::"ContentType", ${content}::jsonb,
        '$system', 0, 0, CURRENT_TIMESTAMP
      FROM seq_alloc s
      RETURNING seq
    ), member_watermark AS (
      UPDATE "AccountThreadState" s SET "messageVisibleThroughSeq" = m.seq,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM system_message m, "RelationshipPair" p, "Account" a
      WHERE s."threadId" = ${input.threadId} AND a.id = s."accountId" AND a."namespaceId" = 0
        AND ((p.id = ${input.pairId} AND p."endpointAAccount" = a.account AND p."endpointANamespaceId" = 0)
          OR (p.id = ${input.pairId} AND p."endpointBAccount" = a.account AND p."endpointBNamespaceId" = 0))
      RETURNING s."accountId"
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
    ), departure_task AS (
      INSERT INTO "DurableTask"
        (kind, "scopeType", "scopeKey", "taskType", payload, status)
      SELECT 'PROJECTION'::"DurableTaskKind", 'THREAD'::"DurableTaskScopeType",
        ('["ACCOUNT_THREAD_FANOUT",' || ${input.threadId}::text || ',' || a.id::text || ']')::text,
        'FAN_OUT_ACCOUNT_THREAD_CONTENT',
        jsonb_build_object('threadId', ${input.threadId}::integer,
          'messageEndSeq', (SELECT seq FROM system_message),
          'tombstoneEndSeq', (SELECT "tombstoneEndSeq" FROM seq_alloc),
          'accountId', a.id::integer),
        'PENDING'::"DurableTaskStatus"
      FROM "Account" a, departed d
      WHERE d.departed AND EXISTS (SELECT 1 FROM system_message) AND a."namespaceId" = 0
        AND EXISTS (SELECT 1 FROM "RelationshipPair" p WHERE p.id = ${input.pairId}
          AND ((p."endpointAAccount" = a.account AND p."endpointANamespaceId" = 0)
            OR (p."endpointBAccount" = a.account AND p."endpointBNamespaceId" = 0)))
      RETURNING id
    ), audience_close AS (
      DELETE FROM "ThreadAudience" ta
      WHERE ta."threadId" = ${input.threadId} AND (
        ta."localUserId" IS NOT NULL
        OR (${remote ? sql`true` : sql`false`}
          AND ta."targetNamespaceId" = ${input.targetNamespaceId}
          AND ta."localUserId" IS NULL)
      ) AND (SELECT departed FROM departed d)
      RETURNING ta.id
    )${
      remote
        ? sql`, head_close AS (
            -- The compacted outbound THREAD_CONTENT_HEAD dies with the pair:
            -- the receiving side converges from the REVOKED fact alone and must
            -- never re-read a content boundary for a departed relationship.
            DELETE FROM "PeerStateFeed" psf
            WHERE psf."namespaceId" = ${input.targetNamespaceId}
              AND psf."account" = ${input.actorAccount}
              AND psf."eventType" = 'THREAD_CONTENT_HEAD'
              AND psf."subjectAccount" = ${input.targetAccount}
              AND psf."subjectNamespaceId" = ${input.targetNamespaceId}
              AND (SELECT departed FROM departed d)
            RETURNING psf."feedId"
          ), ${userIntentPeerWriteSql({
            ...input,
            ownState: 'revocation',
            revoked: true,
            // A later incoming request may be rejected while our authored
            // direction is already REVOKED. It still needs a new peer feed ID.
            always: true,
            resultName: 'peer_result',
          })}`
        : sql``
    }
    SELECT v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM audience_close) AS "audienceChanged",
      (SELECT seq FROM system_message) AS "systemMessageSeq",
      ${remote ? sql`(SELECT max("feedId") FROM peer_result)` : sql`NULL::text`} AS "peerFeedId"
    FROM revocation v
    CROSS JOIN (SELECT count(*) FROM member_watermark) watermark_barrier
    CROSS JOIN (SELECT count(*) FROM seq_alloc) thread_barrier
  `;
}
