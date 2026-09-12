import { sql } from 'drizzle-orm';
import { groupStateSql } from '../../../group/group-state.js';

/** Use before locking only to name the business scopes: the group's address and
 * the acting member's address. It authorizes nothing and `dissolvedAt` lets the
 * caller drop dissolved-group commands before any write. */
export function groupMembershipLocatorSql(input: {
  threadId: number;
  memberUserId: number;
}) {
  return sql`
    SELECT g.account AS "groupAccount", g.domain AS "groupDomain",
      g."dissolvedAt" AS "dissolvedAt",
      a.account AS "memberAccount"
    FROM ${groupStateSql} g
    JOIN "Account" a ON a.id = ${input.memberUserId}
      AND a.domain = 'local' AND a."namespaceId" = 0
    WHERE g.id = ${input.threadId}
  `;
}

/** One fresh post-lock statement validates the authoritative group and the
 * acting member, and selects the entry branch. The member acts on their own
 * pair, so `authorized` binds the row to the calling account — no manager
 * authorization and no outrank read exist on this side. Column shape matches
 * the group-side authorization rows so the ACK and REVOKE statements consume
 * it unchanged. */
export function groupMembershipAuthorizationSql(input: {
  threadId: number;
  pairId: bigint;
  memberUserId: number;
  memberAccount: string;
  memberDomain: string;
  memberNamespaceId: number;
}) {
  return sql`
    WITH side_b AS MATERIALIZED (
      SELECT status, note, "profileRev", "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "pairId" = ${input.pairId} AND "authorSide" = 'B'
    ), side_a AS MATERIALIZED (
      SELECT a.status, a.note, a."updatedAt", a."expiresAt"
      FROM "RelationshipIntent" a
      WHERE a."pairId" = ${input.pairId} AND a."authorSide" = 'A'
    ), roster AS MATERIALIZED (
      SELECT DISTINCT ON ("memberAccount", "memberDomain") *
      FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ${input.threadId}
      ORDER BY "memberAccount", "memberDomain", "feedId" DESC
    ), managers AS MATERIALIZED (
      SELECT a.id, r.body ->> 'role' AS role
      FROM roster r JOIN "Account" a ON a.account = r."memberAccount"
        AND a.domain = 'local' AND a."namespaceId" = 0
      JOIN "AccountThreadState" p ON p."accountId" = a.id AND p."threadId" = ${input.threadId}
      WHERE r."memberDomain" = 'local' AND r."memberNamespaceId" = 0
        AND r.operation = 'UPSERT' AND r.body->>'role' IN ('OWNER', 'ADMIN')
    ), capacity_scope AS MATERIALIZED (
      -- Same authorization growth gate as the group-side variants: each side A
      -- ACCEPTED pair and each unexpired invitation occupies a slot, and this
      -- member's own pair is its already-reserved slot.
      SELECT COUNT(*)::integer AS "authorizedCount", COALESCE(BOOL_OR(
          pair."endpointBAccount" = ${input.memberAccount}
          AND pair."endpointBDomain" = ${input.memberDomain}
        ), false) AS "alreadyAuthorized"
      FROM ${groupStateSql} scope
      JOIN "RelationshipPair" pair ON pair.kind = 'GROUP_MEMBER'
        AND pair."threadId" = ${input.threadId}
        AND pair."endpointAType" = 'GROUP'
        AND pair."endpointAAccount" = scope.account
        AND pair."endpointADomain" = scope.domain
        AND pair."endpointBType" = 'USER'
      JOIN "RelationshipIntent" slot_intent ON slot_intent."pairId" = pair.id
        AND slot_intent."authorSide" = 'A'
        AND (slot_intent.status = 'ACCEPTED' OR (slot_intent.status = 'REQUESTED'
          AND slot_intent."expiresAt" > CURRENT_TIMESTAMP))
      WHERE scope.id = ${input.threadId}
    )
    SELECT g.*, ${input.pairId}::text AS "pairId",
      ${input.memberAccount}::text AS "memberAccount",
      ${input.memberDomain}::text AS "memberDomain",
      ${input.memberNamespaceId}::integer AS "memberNamespaceId",
      side_b.note AS "memberNote",
      side_b.status AS "memberIntentStatus", side_b."profileRev" AS "memberProfileRev",
      (side_b.status = 'ACCEPTED' OR (side_b.status = 'REQUESTED'
        AND side_b."expiresAt" > CURRENT_TIMESTAMP)) AS "memberIntentEffective",
      side_a.status AS "groupIntentStatus", side_a.note AS "groupIntentNote",
      side_a."expiresAt" AS "groupIntentExpiresAt",
      (side_a.status = 'REQUESTED'
        AND side_a."expiresAt" > CURRENT_TIMESTAMP) AS "invitationOutstanding",
      (side_b.status = 'REQUESTED' AND side_b."expiresAt" > CURRENT_TIMESTAMP
        AND (side_a.status IS NULL OR side_a.status = 'REQUESTED'
          OR (side_a.status = 'REVOKED' AND side_a."updatedAt" < side_b."requestedAt"))
      ) AS "applicationPending",
      COALESCE(member_last.operation = 'UPSERT', false) AS "isMember",
      COALESCE((SELECT c."authorizedCount" FROM capacity_scope c), 0) AS "authorizedCount",
      COALESCE((SELECT c."alreadyAuthorized" FROM capacity_scope c), false) AS "alreadyAuthorized",
      local_member.id AS "localMemberId",
      (local_member.id = ${input.memberUserId}) AS authorized,
      COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM managers
        WHERE id IS DISTINCT FROM local_member.id), '[]'::jsonb) AS "managerIds",
      COALESCE((SELECT jsonb_agg(DISTINCT p.direction ORDER BY p.direction)
        FROM "GroupRequestProjection" p
        WHERE p."threadId" = ${input.threadId} AND p."memberAccount" = ${input.memberAccount}
          AND p."memberDomain" = ${input.memberDomain}
          AND p."memberNamespaceId" = ${input.memberNamespaceId}
          AND p.status <> 'REVOKED'), '[]'::jsonb) AS "projectionDirections"
    FROM ${groupStateSql} g
    LEFT JOIN side_b ON true
    LEFT JOIN side_a ON true
    LEFT JOIN roster member_last ON member_last."memberAccount" = ${input.memberAccount}
      AND member_last."memberDomain" = ${input.memberDomain}
    LEFT JOIN "Account" local_member ON local_member.account = ${input.memberAccount}
      AND local_member.domain = ${input.memberDomain}
      AND local_member."namespaceId" = ${input.memberNamespaceId}
    WHERE g.id = ${input.threadId}
  `;
}
