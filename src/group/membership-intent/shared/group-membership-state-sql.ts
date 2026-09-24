import { sql } from 'drizzle-orm';
import { groupStateSql } from '../../shared/group-state.js';

export interface GroupMembershipStateRow extends Record<string, unknown> {
  account: string;
  domain: string;
  namespaceId: number;
  name: string;
  avatar: string;
  description: string;
  profileRev: number;
  createdAt: string;
  updatedAt: string;
  dissolvedAt: string | null;
  pairId: string;
  memberAccount: string;
  memberDomain: string;
  memberNamespaceId: number;
  memberNote: string | null;
  memberIntentStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  memberProfileRev: number | null;
  memberIntentEffective: boolean | null;
  groupIntentStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  groupIntentNote: string | null;
  groupIntentExpiresAt: string | null;
  applicationPending: boolean | null;
  invitationOutstanding: boolean | null;
  pairActive: boolean;
  authorizedCount: number;
  alreadyAuthorized: boolean;
  localMemberId: number | null;
  authorized: boolean;
  managerIds: number[];
  projectionDirections: Array<'APPLICATION' | 'INVITATION'>;
}

/** Reads the locked canonical membership state used by member-authored commands
 * and system disband revocations. `actorUserId` is checked only for the
 * member-authored authorization result. */
export function groupMembershipStateSql(input: {
  threadId: number;
  pairId: bigint;
  actorUserId: number | null;
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
      SELECT * FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ${input.threadId}
    ), managers AS MATERIALIZED (
      SELECT a.id, r.body ->> 'role' AS role
      FROM roster r JOIN "Account" a ON a.account = r."memberAccount"
        AND a.domain = 'local' AND a."namespaceId" = 0
      JOIN "AccountThreadState" p ON p."accountId" = a.id AND p."threadId" = ${input.threadId}
      WHERE r."memberDomain" = 'local'
        AND r.operation = 'MEMBER_UPSERT' AND r.body->>'role' IN ('OWNER', 'ADMIN')
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
      COALESCE((SELECT pair.active FROM "RelationshipPair" pair
        WHERE pair.id = ${input.pairId}), false) AS "pairActive",
      COALESCE((SELECT c."authorizedCount" FROM capacity_scope c), 0) AS "authorizedCount",
      COALESCE((SELECT c."alreadyAuthorized" FROM capacity_scope c), false) AS "alreadyAuthorized",
      local_member.id AS "localMemberId",
      (${input.actorUserId}::integer IS NOT NULL
        AND local_member.id = ${input.actorUserId}) AS authorized,
      COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM managers
        WHERE id IS DISTINCT FROM local_member.id), '[]'::jsonb) AS "managerIds",
      COALESCE((SELECT jsonb_agg(DISTINCT p.direction ORDER BY p.direction)
        FROM "GroupRequestProjection" p
        WHERE p."threadId" = ${input.threadId} AND p."memberAccount" = ${input.memberAccount}
          AND p."memberDomain" = ${input.memberDomain}
          AND p."memberNamespaceId" = ${input.memberNamespaceId}
          AND p.status = 'REQUESTED'), '[]'::jsonb) AS "projectionDirections"
    FROM ${groupStateSql} g
    LEFT JOIN side_b ON true
    LEFT JOIN side_a ON true
    LEFT JOIN "Account" local_member ON local_member.account = ${input.memberAccount}
      AND local_member.domain = ${input.memberDomain}
      AND local_member."namespaceId" = CASE WHEN ${input.memberDomain} = 'local'
        THEN 0 ELSE ${input.memberNamespaceId} END
    WHERE g.id = ${input.threadId}
  `;
}
