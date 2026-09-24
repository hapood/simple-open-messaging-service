import { sql, type SQL } from 'drizzle-orm';
import { clientIntentFeedWriteSql } from '../../../common/sql/relationship-intent-recipient-feed-sql.js';
import {
  mirrorIntentCompactionKey,
  mirrorIntentFeedBodySql,
  mirrorIntentReadBackSql,
  mirrorIntentWriteSql,
  epochMillisSql,
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
  /** The system-authored side B promotion (REQUESTED → ACCEPTED) fires only
   * when side B still holds a live application; the completion path (side B
   * already ACCEPTED) authors nothing. */
  promote: boolean;
}

/** Statement A of the activation: persist side A, derive side B, and — when the
 * conjunction crosses both-effective — activate the pair, enable federation
 * rounds, and seat the member's AccountThreadState at the tail. No sync-state
 * write here: the applier calls the existing relationship-thread-state
 * initializer after this statement, on the now-active pair. A mirror writes no
 * meta facts, no system message, no projections, and no audience rows. */
export function mirrorMembershipActivationSql(
  input: MirrorMembershipActivationInput,
): SQL {
  return sql`
    WITH join_source AS MATERIALIZED (
      SELECT p.active AS "wasActive", t."curSeq",
        b.status AS "memberStatus", b."expiresAt" AS "memberExpiresAt"
      FROM "RelationshipPair" p JOIN "MessageThread" t ON t.id = p."threadId"
      LEFT JOIN "RelationshipIntent" b ON b."pairId" = p.id AND b."authorSide" = 'B'
      WHERE p.id = ${input.pairId} AND t.id = ${input.threadId}
    ), authored AS (
      ${mirrorIntentWriteSql({
        pairId: input.pairId,
        authorSide: 'A',
        status: input.persistStatus,
        note: input.intent.note,
        requestedAt: input.intent.requestedAt,
        expiresAt: input.intent.expiresAt,
        profileRev: input.intent.profileRev,
        messageEndSeq: input.intent.messageEndSeq,
        tombstoneEndSeq: input.intent.tombstoneEndSeq,
      })}
    ), ${mirrorIntentReadBackSql({
      writeName: 'authored',
      readBackName: 'persisted_intent',
      pairId: input.pairId,
      authorSide: 'A',
    })}, side_a_effective AS MATERIALIZED (
      SELECT (status = 'ACCEPTED' OR (status = 'REQUESTED'
          AND "expiresAt" > CURRENT_TIMESTAMP)) AS effective
      FROM persisted_intent
    ), promotion AS (
      UPDATE "RelationshipIntent" b
        SET status = 'ACCEPTED', "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE b."pairId" = ${input.pairId} AND b."authorSide" = 'B'
        AND b.status = 'REQUESTED' AND b."expiresAt" > CURRENT_TIMESTAMP
        AND ${input.promote ? sql`true` : sql`false`}
      RETURNING 1
    ), side_b_effective AS MATERIALIZED (
      SELECT (EXISTS (SELECT 1 FROM promotion)
          OR join_source."memberStatus" = 'ACCEPTED'
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
          WHERE "threadId" = ${input.threadId} AND "memberAccount" = ${input.memberAccount}
            AND "memberDomain" = 'local'
          ORDER BY "feedId" DESC LIMIT 1
        ) latest WHERE operation = 'MEMBER_UPSERT'), 'MEMBER') AS role
    ), member_state AS (
      INSERT INTO "AccountThreadState" ("accountId", "threadId", role, "lastReadSeq",
        "groupMetaFeedEndId", "updatedAt")
      SELECT a.id, ${input.threadId}, r.role::"GroupRole",
        CASE WHEN a.availability = 'AVAILABLE' THEN j."curSeq" ELSE 0 END, 0, CURRENT_TIMESTAMP
      FROM "Account" a
      CROSS JOIN roster_role r
      CROSS JOIN join_source j
      CROSS JOIN pair_change
      WHERE a.id = ${input.localMemberId}
      ON CONFLICT ("accountId", "threadId") DO UPDATE SET
        role = EXCLUDED.role, "messageVisibleThroughSeq" = NULL, "updatedAt" = CURRENT_TIMESTAMP,
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
    SELECT EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM promotion) AS "promoted",
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM member_state) AS "activated"
    FROM persisted_intent v
  `;
}

/** Statement B of the activation: the invitee's RELATIONSHIP_INTENT feed row,
 * carrying the received intent's own status/note/timestamps. Split from the
 * activation statement because the AccountThreadState insert fires participant
 * triggers that write the same Account allocator rows this statement allocates
 * from (one update per row per statement). */
export function mirrorMembershipActivationFeedSql(input: {
  presentation: MirrorGroupPresentationInput;
  memberAccount: string;
  localMemberId: number;
  status: 'REQUESTED' | 'ACCEPTED';
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
  threadId: number;
}): SQL {
  return sql`
    WITH candidate_bodies AS MATERIALIZED (
      SELECT ${input.localMemberId}::integer AS "userId",
        ${input.presentation.groupNamespaceId}::integer AS "namespaceId", 1 AS ordinal,
        ${mirrorIntentCompactionKey({
          groupNamespaceId: input.presentation.groupNamespaceId,
          groupAccount: input.presentation.groupAccount,
          groupDomain: input.presentation.groupDomain,
          memberAccount: input.memberAccount,
        })}::text AS "compactionKey",
        ${input.presentation.groupAccount}::text AS account,
        ${input.presentation.groupDomain}::text AS domain,
        ${input.memberAccount}::text AS "subjectAccount", 'local'::text AS "subjectDomain",
        ${mirrorIntentFeedBodySql({
          status: sql`${input.status}::text`,
          note: sql`${input.note}::text`,
          requestedAt: epochMillisSql(sql`${input.requestedAt}::timestamptz`),
          expiresAt: epochMillisSql(sql`${input.expiresAt}::timestamptz`),
          established: sql`true`,
          threadId: input.threadId,
          presentation: input.presentation,
        })} AS body
    ), ${clientIntentFeedWriteSql()}
    SELECT (SELECT "userId" FROM recipient_result) AS "recipientUserId",
      (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"
  `;
}
