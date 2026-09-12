import { sql } from 'drizzle-orm';
import { groupStateSql } from '../../../group/group-state.js';

/** Use before locking only to name the business scopes. It authorizes nothing:
 * every mutable state is re-read under the locks by the authorization statement. */
export function groupMemberIntentLocatorSql(input: {
  threadId: number;
  requestId: bigint;
}) {
  return sql`
    SELECT pair.id::text AS "pairId",
      pair."endpointBAccount" AS account, pair."endpointBDomain" AS domain,
      CASE WHEN pair."endpointBDomain" = 'local' THEN 0
        ELSE pair."endpointBNamespaceId" END AS "namespaceId",
      pair."endpointAAccount" AS "groupAccount", pair."endpointADomain" AS "groupDomain"
    FROM "RelationshipIntent" intent
    JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
    WHERE pair."threadId" = ${input.threadId} AND intent.id = ${input.requestId}
      AND pair.kind = 'GROUP_MEMBER' AND intent."authorSide" = 'B'
  `;
}

/** Names the group's business scope before locking when no request exists yet.
 * Like the intent locator it authorizes nothing; `dissolvedAt` lets the owner
 * drop a dissolved group's invitation before any write (the legacy invite never
 * minted a pair for a dissolved group). */
export function groupIntentTargetLocatorSql(input: { threadId: number }) {
  return sql`
    SELECT g.account AS "groupAccount", g.domain AS "groupDomain",
      g."dissolvedAt" AS "dissolvedAt"
    FROM ${groupStateSql} g WHERE g.id = ${input.threadId}
  `;
}

/** One fresh post-lock statement validates the caller, the authoritative group,
 * and the entry branch. Member identity comes from the pair's endpoint B, so a
 * rostered member resolves regardless of intent state; `applicationPending`
 * carries the join-request gate and `memberIntentStatus`/`groupIntentStatus`
 * select the ACK entry (application vs invitation completion). */
export function groupIntentAuthorizationSql(input: {
  threadId: number;
  requestId: bigint;
  managerUserId: number;
}) {
  return sql`
    WITH reverse AS MATERIALIZED (
      SELECT i."pairId", i.status, i.note, i."profileRev", i."requestedAt", i."expiresAt",
        pair."endpointBAccount" AS account, pair."endpointBDomain" AS domain,
        CASE WHEN pair."endpointBDomain" = 'local' THEN 0
          ELSE pair."endpointBNamespaceId" END AS "namespaceId"
      FROM "RelationshipIntent" i JOIN "RelationshipPair" pair ON pair.id = i."pairId"
      WHERE pair."threadId" = ${input.threadId} AND i.id = ${input.requestId}
        AND pair.kind = 'GROUP_MEMBER' AND i."authorSide" = 'B'
    ), side_a AS MATERIALIZED (
      SELECT a.status, a.note, a."updatedAt", a."expiresAt"
      FROM "RelationshipIntent" a
      WHERE a."pairId" = (SELECT "pairId" FROM reverse) AND a."authorSide" = 'A'
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
      -- Authorization growth gate: each side A ACCEPTED pair and each
      -- unexpired group invitation occupies a slot; the member's own pair is
      -- its already-reserved slot.
      SELECT COUNT(*)::integer AS "authorizedCount", COALESCE(BOOL_OR(
          pair."endpointBAccount" = rev.account
          AND pair."endpointBDomain" = rev.domain
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
      LEFT JOIN reverse rev ON true
      WHERE scope.id = ${input.threadId}
    )
    SELECT g.*, rev.account AS "memberAccount", rev.domain AS "memberDomain",
      rev."namespaceId" AS "memberNamespaceId", rev.note AS "memberNote",
      rev.status AS "memberIntentStatus", rev."profileRev" AS "memberProfileRev",
      (rev.status = 'ACCEPTED' OR (rev.status = 'REQUESTED'
        AND rev."expiresAt" > CURRENT_TIMESTAMP)) AS "memberIntentEffective",
      side_a.status AS "groupIntentStatus", side_a.note AS "groupIntentNote",
      side_a."expiresAt" AS "groupIntentExpiresAt",
      (rev.status = 'ACCEPTED' AND side_a.status = 'REQUESTED'
        AND side_a."expiresAt" > CURRENT_TIMESTAMP) AS "invitationOutstanding",
      (rev.status = 'REQUESTED' AND rev."expiresAt" > CURRENT_TIMESTAMP
        AND (side_a.status IS NULL OR side_a.status = 'REQUESTED'
          OR (side_a.status = 'REVOKED' AND side_a."updatedAt" < rev."requestedAt"))
      ) AS "applicationPending",
      COALESCE(member_last.operation = 'UPSERT', false) AS "isMember",
      member_last.body ->> 'role' AS "memberRole",
      (SELECT m.role FROM managers m WHERE m.id = ${input.managerUserId}) AS "operatorRole",
      COALESCE((SELECT c."authorizedCount" FROM capacity_scope c), 0) AS "authorizedCount",
      COALESCE((SELECT c."alreadyAuthorized" FROM capacity_scope c), false) AS "alreadyAuthorized",
      local_member.id AS "localMemberId",
      EXISTS (SELECT 1 FROM managers m JOIN "Account" a ON a.id = m.id
        WHERE m.id = ${input.managerUserId} AND EXISTS (
          SELECT 1 FROM "RelationshipPair" p WHERE p."threadId" = ${input.threadId}
            AND p.kind = 'GROUP_MEMBER' AND p.active AND p."endpointBType" = 'USER'
            AND p."endpointBAccount" = a.account AND p."endpointBDomain" = 'local'
        )) AS authorized,
      COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM managers
        WHERE id IS DISTINCT FROM local_member.id), '[]'::jsonb) AS "managerIds",
      COALESCE((SELECT jsonb_agg(DISTINCT p.direction ORDER BY p.direction)
        FROM "GroupRequestProjection" p
        WHERE p."threadId" = ${input.threadId} AND p."memberAccount" = rev.account
          AND p."memberDomain" = rev.domain AND p."memberNamespaceId" = rev."namespaceId"
          AND p.status <> 'REVOKED'), '[]'::jsonb) AS "projectionDirections"
    FROM ${groupStateSql} g
    LEFT JOIN reverse rev ON true
    LEFT JOIN side_a ON true
    LEFT JOIN roster member_last ON member_last."memberAccount" = rev.account
      AND member_last."memberDomain" = rev.domain
    LEFT JOIN "Account" local_member ON rev.domain = 'local'
      AND local_member.account = rev.account AND local_member.domain = 'local'
      AND local_member."namespaceId" = 0
    WHERE g.id = ${input.threadId}
  `;
}

/** The invitation (group-authored REQUESTED) variant. The caller has already
 * minted the canonical pair, so member identity is the command's target address
 * rather than the reverse intent; the side B row may legitimately not exist.
 * Column shape matches `groupIntentAuthorizationSql` plus `pairId`, so both ACK
 * and REVOKE branches consume either row unchanged. */
export function groupIntentInvitationAuthorizationSql(input: {
  threadId: number;
  pairId: bigint;
  managerUserId: number;
  targetAccount: string;
  targetDomain: string;
  targetNamespaceId: number;
}) {
  return sql`
    WITH reverse AS MATERIALIZED (
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
      -- Same authorization growth gate as the request-keyed variant; the
      -- target names its own pair here, so the exemption keys on the address.
      SELECT COUNT(*)::integer AS "authorizedCount", COALESCE(BOOL_OR(
          pair."endpointBAccount" = ${input.targetAccount}
          AND pair."endpointBDomain" = ${input.targetDomain}
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
      ${input.targetAccount}::text AS "memberAccount",
      ${input.targetDomain}::text AS "memberDomain",
      ${input.targetNamespaceId}::integer AS "memberNamespaceId",
      rev.note AS "memberNote",
      rev.status AS "memberIntentStatus", rev."profileRev" AS "memberProfileRev",
      (rev.status = 'ACCEPTED' OR (rev.status = 'REQUESTED'
        AND rev."expiresAt" > CURRENT_TIMESTAMP)) AS "memberIntentEffective",
      side_a.status AS "groupIntentStatus", side_a.note AS "groupIntentNote",
      side_a."expiresAt" AS "groupIntentExpiresAt",
      (rev.status = 'ACCEPTED' AND side_a.status = 'REQUESTED'
        AND side_a."expiresAt" > CURRENT_TIMESTAMP) AS "invitationOutstanding",
      (rev.status = 'REQUESTED' AND rev."expiresAt" > CURRENT_TIMESTAMP
        AND (side_a.status IS NULL OR side_a.status = 'REQUESTED'
          OR (side_a.status = 'REVOKED' AND side_a."updatedAt" < rev."requestedAt"))
      ) AS "applicationPending",
      COALESCE(member_last.operation = 'UPSERT', false) AS "isMember",
      member_last.body ->> 'role' AS "memberRole",
      (SELECT m.role FROM managers m WHERE m.id = ${input.managerUserId}) AS "operatorRole",
      COALESCE((SELECT c."authorizedCount" FROM capacity_scope c), 0) AS "authorizedCount",
      COALESCE((SELECT c."alreadyAuthorized" FROM capacity_scope c), false) AS "alreadyAuthorized",
      local_member.id AS "localMemberId",
      EXISTS (SELECT 1 FROM managers m JOIN "Account" a ON a.id = m.id
        WHERE m.id = ${input.managerUserId} AND EXISTS (
          SELECT 1 FROM "RelationshipPair" p WHERE p."threadId" = ${input.threadId}
            AND p.kind = 'GROUP_MEMBER' AND p.active AND p."endpointBType" = 'USER'
            AND p."endpointBAccount" = a.account AND p."endpointBDomain" = 'local'
        )) AS authorized,
      COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM managers
        WHERE id IS DISTINCT FROM local_member.id), '[]'::jsonb) AS "managerIds",
      COALESCE((SELECT jsonb_agg(DISTINCT p.direction ORDER BY p.direction)
        FROM "GroupRequestProjection" p
        WHERE p."threadId" = ${input.threadId} AND p."memberAccount" = ${input.targetAccount}
          AND p."memberDomain" = ${input.targetDomain} AND p."memberNamespaceId" = ${input.targetNamespaceId}
          AND p.status <> 'REVOKED'), '[]'::jsonb) AS "projectionDirections"
    FROM ${groupStateSql} g
    LEFT JOIN reverse rev ON true
    LEFT JOIN side_a ON true
    LEFT JOIN roster member_last ON member_last."memberAccount" = ${input.targetAccount}
      AND member_last."memberDomain" = ${input.targetDomain}
    LEFT JOIN "Account" local_member ON local_member.account = ${input.targetAccount}
      AND local_member.domain = ${input.targetDomain}
      AND local_member."namespaceId" = ${input.targetNamespaceId}
    WHERE g.id = ${input.threadId}
  `;
}
