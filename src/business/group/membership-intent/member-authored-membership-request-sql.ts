import { sql, type SQL } from 'drizzle-orm';
import { authoredIntentWriteSql } from '../../shared/sql/authored-relationship-intent-sql.js';
import { clientIntentFeedWriteSql } from '../../shared/sql/relationship-intent-recipient-feed-sql.js';

export interface MemberAuthoredMembershipRequestInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupName: string;
  groupAvatar: string;
  groupDescription: string;
  groupProfileRev: number;
  localDomain: string;
  /** The applying member: local by definition — this family serves the local actor. */
  memberAccount: string;
  localMemberId: number;
  managerIds: readonly number[];
  note: string;
  requestedAt: Date;
  expiresAt: Date;
}

/** One composed statement for the member-authored REQUESTED decision (a join
 * application). The pair row already exists (the transaction owner minted it).
 * The projection advance is the application's own number stream, one row per
 * manager, and the projection fan-out task carries the per-manager wake — the
 * statement itself only wakes the applicant, whose own intent feed row is a
 * one-person fact. No audience row: an applicant gains no thread access. */
export function memberAuthoredMembershipRequestSql(
  input: MemberAuthoredMembershipRequestInput,
): SQL {
  return sql`
    WITH authored AS (
      ${authoredIntentWriteSql({
        pair: { id: input.pairId, threadId: input.threadId },
        authorSide: 'B',
        status: 'REQUESTED',
        note: input.note,
        requestedAt: input.requestedAt,
        expiresAt: input.expiresAt,
      })}
    ), request_state AS MATERIALIZED (
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent" WHERE "pairId" = ${input.pairId} AND "authorSide" = 'B'
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), projection_alloc AS (
      UPDATE "GroupMeta" f
        SET "applicationEndId" = f."applicationEndId" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE f."threadId" = ${input.threadId} AND EXISTS (SELECT 1 FROM authored)
      RETURNING f."applicationEndId" AS "feedId"
    ), request_projection AS (
      INSERT INTO "GroupRequestProjection"
        ("managerUserId", "threadId", "memberAccount", "memberDomain", "memberNamespaceId",
          "memberProfileRev", direction, "requestId", status, note, "requestedAt", "expiresAt", "feedId")
      SELECT m.id, ${input.threadId}, ${input.memberAccount}, 'local', 0,
        v."profileRev", 'APPLICATION',
        v.id, v.status, v.note, v."requestedAt", v."expiresAt",
        (SELECT "feedId" FROM projection_alloc)
      FROM request_state v CROSS JOIN (SELECT id FROM unnest(
        ${sql.param(input.managerIds)}::integer[]) AS id ORDER BY id) m
      WHERE EXISTS (SELECT 1 FROM projection_alloc)
      ON CONFLICT ("managerUserId", "threadId", "memberAccount", "memberDomain",
        "memberNamespaceId", "direction") DO UPDATE SET
        "feedId" = EXCLUDED."feedId", "requestId" = EXCLUDED."requestId",
        "memberProfileRev" = EXCLUDED."memberProfileRev", status = EXCLUDED.status,
        note = EXCLUDED.note, "requestedAt" = EXCLUDED."requestedAt",
        "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "managerUserId"
    ), recipient_body AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status, 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', floor(extract(epoch FROM v."expiresAt") * 1000)::bigint,
          'direction', 'OUTGOING',
          'threadId', ${input.threadId}::integer,
          'established', (SELECT p.established FROM "RelationshipPair" p WHERE p.id = ${input.pairId}),
          'group', jsonb_build_object('account', ${input.groupAccount}::text, 'domain', 'local',
            'isLocal', true, 'name', ${input.groupName}::text, 'avatar', ${input.groupAvatar}::text,
            'description', ${input.groupDescription}::text, 'profileRev', ${input.groupProfileRev}::integer)
        ) AS body
      FROM request_state v
    ), candidate_bodies AS MATERIALIZED (
      SELECT ${input.localMemberId}::integer AS "userId", 0 AS "namespaceId", 1 AS ordinal,
        ${memberFeedCompactionKey(input.groupAccount, input.memberAccount)}::text AS "compactionKey",
        ${input.groupAccount}::text AS account, 'local'::text AS domain,
        ${input.memberAccount}::text AS "subjectAccount", 'local'::text AS "subjectDomain",
        b.body
      FROM recipient_body b
    ), ${clientIntentFeedWriteSql()}
    SELECT v.id::text AS "requestId", v.status, v.note,
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
    groupAccount,
    'local',
    memberAccount,
    'local',
  ]);
}
