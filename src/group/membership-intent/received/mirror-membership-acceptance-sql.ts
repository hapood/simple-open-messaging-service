import { sql, type SQL } from 'drizzle-orm';
import {
  mirrorGroupDirection,
  mirrorIntentWriteSql,
  type MirrorGroupPresentationInput,
} from './mirror-membership-shared-sql.js';

export interface MirrorMembershipActivationInput {
  threadId: number;
  pairId: bigint;
  presentation: MirrorGroupPresentationInput;
  memberAccount: string;
  localMemberId: number;
  /** Wire coordinates from the received item body (side A's). */
  intent: {
    profileNamespaceId: number;
    profileRev: number;
    note: string;
    requestedAt: Date | null;
    expiresAt: Date | null;
    messageEndSeq: number;
    tombstoneEndSeq: number;
  };
  /** A received ACK persists ACCEPTED; a received REQUESTED that collapses into
   * a confirmed membership (pending application or dangling acceptance)
   * persists REQUESTED — both sides effective either way. */
  persistStatus: 'REQUESTED' | 'ACCEPTED';
}

/** The received side A write for the activation family, run before the domain
 * statement in the owning transaction: a received ACK persists ACCEPTED; a
 * received REQUESTED that collapses into a confirmed membership (pending
 * application or dangling acceptance) persists REQUESTED. Its guarded
 * RETURNING reports whether this delivery moved the mirrored group direction. */
export function mirrorMembershipActivationIntentWrite(
  input: MirrorMembershipActivationInput,
): SQL {
  const { author, receiver } = mirrorGroupDirection(
    input.presentation,
    input.memberAccount,
  );
  return mirrorIntentWriteSql({
    author,
    receiver,
    status: input.persistStatus,
    note: input.intent.note,
    requestedAt: input.intent.requestedAt,
    expiresAt: input.intent.expiresAt,
    profileNamespaceId: input.intent.profileNamespaceId,
    profileRev: input.intent.profileRev,
    messageEndSeq: input.intent.messageEndSeq,
    tombstoneEndSeq: input.intent.tombstoneEndSeq,
  });
}

/** Statement A of the activation, on the already-written side A row: derive
 * side B, and — when the conjunction crosses both-effective — activate the
 * pair, enable federation rounds, and seat the member's AccountThreadState at
 * the tail. The caller folds a still-live side B application beforehand through
 * the shared promotion writer; this statement only reads the result. No
 * sync-state write here: the applier calls the existing
 * relationship-thread-state initializer after this statement, on the
 * now-active pair. A mirror writes no meta facts, no system message, no
 * projections, and no audience rows. */
export function mirrorMembershipActivationSql(
  input: MirrorMembershipActivationInput,
): SQL {
  const { author, receiver } = mirrorGroupDirection(
    input.presentation,
    input.memberAccount,
  );
  return sql`
    WITH join_source AS MATERIALIZED (
      SELECT p.active AS "wasActive", t."curSeq",
        b.status AS "memberStatus", b."expiresAt" AS "memberExpiresAt"
      FROM "RelationshipPair" p JOIN "MessageThread" t ON t.id = p."threadId"
      LEFT JOIN "RelationshipIntent" b
        ON b."authorAccount" = ${input.memberAccount} AND b."authorNamespaceId" = 0
          AND b."receiverAccount" = ${input.presentation.groupAccount}
          AND b."receiverNamespaceId" = ${input.presentation.groupNamespaceId}
      WHERE p.id = ${input.pairId} AND t.id = ${input.threadId}
    ), persisted_intent AS MATERIALIZED (
      SELECT status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${author.account} AND "authorNamespaceId" = ${author.namespaceId}
        AND "receiverAccount" = ${receiver.account} AND "receiverNamespaceId" = ${receiver.namespaceId}
    ), side_a_effective AS MATERIALIZED (
      SELECT (status = 'ACCEPTED' OR (status = 'REQUESTED'
          AND "expiresAt" > CURRENT_TIMESTAMP)) AS effective
      FROM persisted_intent
    ), side_b_effective AS MATERIALIZED (
      SELECT (join_source."memberStatus" = 'ACCEPTED'
          OR (join_source."memberStatus" = 'REQUESTED'
            AND join_source."memberExpiresAt" > CURRENT_TIMESTAMP)) AS effective
      FROM join_source
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = true, established = true, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND NOT active
        AND (SELECT effective FROM side_a_effective)
        AND (SELECT effective FROM side_b_effective)
      RETURNING id
    ), thread_rounds AS (
      -- Reactivation reopens the thread: rounds resume and a dissolved-mirror
      -- marker clears (the rejoin path back onto a live origin group).
      UPDATE "MessageThread" t
        SET "federationRoundsEnabled" = true, "groupDissolvedAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE t.id = ${input.threadId} AND EXISTS (SELECT 1 FROM pair_change)
      RETURNING t."curSeq"
    ), roster_role AS MATERIALIZED (
      SELECT COALESCE((SELECT body->>'role' FROM (
          SELECT operation, body FROM "GroupMetaMemberFeed"
          WHERE "threadId" = ${input.threadId} AND body ->> 'account' = ${input.memberAccount}
            AND (body -> 'namespaceId') = to_jsonb(0)
          ORDER BY "feedId" DESC LIMIT 1
        ) latest WHERE operation = 'MEMBER_UPSERT'), 'MEMBER') AS role
    ), member_state AS (
      INSERT INTO "AccountThreadState" ("accountId", "threadId", role, "lastReadSeq",
        "groupMetaFeedEndId", "threadProfileRev", "profileSourceId", "updatedAt")
      SELECT a.id, ${input.threadId}, r.role::"GroupRole",
        CASE WHEN a.availability = 'AVAILABLE' THEN j."curSeq" ELSE 0 END, 0,
        v."profileRev", NULL, CURRENT_TIMESTAMP
      FROM "Account" a
      CROSS JOIN roster_role r
      CROSS JOIN join_source j
      CROSS JOIN persisted_intent v
      CROSS JOIN pair_change
      WHERE a.id = ${input.localMemberId}
      ON CONFLICT ("accountId", "threadId") DO UPDATE SET
        role = EXCLUDED.role, "messageVisibleThroughSeq" = NULL, "updatedAt" = CURRENT_TIMESTAMP,
        "threadProfileRev" = EXCLUDED."threadProfileRev",
        "profileSourceId" = EXCLUDED."profileSourceId",
        "groupMetaFeedEndId" = GREATEST(
          COALESCE("AccountThreadState"."groupMetaFeedEndId", 0), EXCLUDED."groupMetaFeedEndId"),
        "lastReadSeq" = CASE WHEN (SELECT availability = 'AVAILABLE' FROM "Account" WHERE id = ${input.localMemberId})
          THEN GREATEST("AccountThreadState"."lastReadSeq", EXCLUDED."lastReadSeq")
          ELSE "AccountThreadState"."lastReadSeq" END,
        "unreadCount" = CASE WHEN (SELECT availability = 'AVAILABLE' FROM "Account" WHERE id = ${input.localMemberId})
          THEN 0 ELSE "AccountThreadState"."unreadCount" END,
        "previewSeqs" = CASE WHEN (SELECT availability = 'AVAILABLE' FROM "Account" WHERE id = ${input.localMemberId})
          THEN '{}'::integer[] ELSE "AccountThreadState"."previewSeqs" END,
        "lastMentionSeq" = CASE WHEN (SELECT availability = 'AVAILABLE' FROM "Account" WHERE id = ${input.localMemberId})
          THEN NULL ELSE "AccountThreadState"."lastMentionSeq" END
      RETURNING "accountId"
    )
    SELECT
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM member_state) AS "activated"
    FROM persisted_intent v
  `;
}
