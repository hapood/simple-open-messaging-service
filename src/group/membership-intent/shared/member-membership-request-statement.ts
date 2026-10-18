import { sql, type SQL } from 'drizzle-orm';
import { clientIntentFeedWriteSql } from '../../../common/sql/relationship-intent-recipient-feed-sql.js';

export interface MemberMembershipRequestStateInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupProfileRev: number;
  /** The applying member. Local for this family's own actor; a remote member
   * when the received-intent applier drives the same statement. */
  memberAccount: string;
  profileNamespaceId: number;
  /** The applicant's local Account id, or null for a remote member: no local
   * applicant feed row exists to write in that case. */
  localMemberId: number | null;
  note: string;
  requestedAt: Date;
  expiresAt: Date;
}

/** One composed statement for the member-authored REQUESTED decision (a join
 * application). The pair row already exists (the transaction owner minted it).
 * The projection advance is the application's own number stream, one row per
 * (group, member, direction), and the projection fan-out task carries the per-manager wake — the
 * statement itself only wakes the local applicant, whose own intent feed row is
 * a one-person fact. No audience row: an applicant gains no thread access. */
export function memberMembershipRequestStatement(
  input: MemberMembershipRequestStateInput,
  intentWrite: SQL,
): SQL {
  return sql`
    WITH authored AS (
      ${intentWrite}
    ), request_state AS MATERIALIZED (
      SELECT status, "profileRev", note, "requestedAt", "expiresAt", snapshot FROM authored
      UNION ALL
      SELECT status, "profileRev", note, "requestedAt", "expiresAt", snapshot
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.memberAccount} AND "authorNamespaceId" = ${input.profileNamespaceId}
        AND "receiverAccount" = ${input.groupAccount} AND "receiverNamespaceId" = 0
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), projection_alloc AS (
      UPDATE "GroupMeta" f
        SET "applicationEndId" = f."applicationEndId" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE f."threadId" = ${input.threadId} AND EXISTS (SELECT 1 FROM authored)
      RETURNING f."applicationEndId" AS "feedId"
    ), request_projection AS (
      INSERT INTO "GroupRequestProjection"
        ("threadId", "memberAccount", "profileNamespaceId",
          "memberProfileRev", direction, status, note, "requestedAt", "expiresAt", "feedId")
      SELECT ${input.threadId}, ${input.memberAccount},
        ${input.profileNamespaceId},
        v."profileRev", 'APPLICATION',
        'REQUESTED'::"RequestProjectionStatus", v.note, v."requestedAt", v."expiresAt",
        (SELECT "feedId" FROM projection_alloc)
      FROM request_state v
      WHERE EXISTS (SELECT 1 FROM projection_alloc)
      ON CONFLICT ("threadId", "memberAccount",
        "profileNamespaceId", "direction") DO UPDATE SET
        "feedId" = EXCLUDED."feedId",
        "memberProfileRev" = EXCLUDED."memberProfileRev", status = EXCLUDED.status,
        note = EXCLUDED.note, "requestedAt" = EXCLUDED."requestedAt",
        "expiresAt" = EXCLUDED."expiresAt"
      RETURNING 1
    ), recipient_body AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status, 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', floor(extract(epoch FROM v."expiresAt") * 1000)::bigint,
          'direction', 'OUTGOING', 'snapshot', v.snapshot,
          'threadId', ${input.threadId}::integer,
          'established', (SELECT p.established FROM "RelationshipPair" p WHERE p.id = ${input.pairId}),
          'group', jsonb_build_object('account', ${input.groupAccount}::text, 'namespaceId', 0,
            'profileRev', 0)
        ) AS body
      FROM request_state v
    ), candidate_bodies AS MATERIALIZED (
      SELECT ${input.localMemberId}::integer AS "userId", 0 AS "namespaceId", 1 AS ordinal,
        ${memberFeedCompactionKey(input.groupAccount, input.memberAccount)}::text AS "compactionKey",
        ${input.memberAccount}::text AS account,
        ${input.groupAccount}::text AS "subjectAccount", 0::integer AS "subjectNamespaceId",
        b.body
      FROM recipient_body b
      WHERE ${input.localMemberId}::integer IS NOT NULL
    ), ${clientIntentFeedWriteSql()}
    SELECT v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM request_projection) AS "projectionChanged",
      (SELECT "userId" FROM recipient_result) AS "recipientUserId",
      (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"
    FROM request_state v
    CROSS JOIN (SELECT count(*) FROM request_projection) projection_barrier
  `;
}

/** Matches ClientStateFeedService.compactionKey for the applicant's feed write. */
function memberFeedCompactionKey(
  groupAccount: string,
  memberAccount: string,
): string {
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    0,
    memberAccount,
    groupAccount,
    0,
  ]);
}
