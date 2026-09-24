import { sql } from 'drizzle-orm';
import { groupStateSql } from '../../shared/group-state.js';
import { GroupRole } from '../../../database/enums.js';

/** Post-lock authorization row for an addressed group member decision. */
export type GroupMembershipAuthorizationRow = {
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
  memberAccount: string | null;
  memberDomain: string | null;
  memberNamespaceId: number | null;
  memberNote: string | null;
  memberIntentStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  memberProfileRev: number | null;
  /** The member's canonical roster role, or null when not rostered. */
  memberRole: GroupRole | null;
  /** The acting manager's canonical roster role (OWNER or ADMIN when authorized). */
  operatorRole: GroupRole | null;
  /** Pairs holding an ACCEPTED or unexpired group invitation — the capacity set. */
  authorizedCount: number;
  /** Whether the member's own pair is already part of the capacity set. */
  alreadyAuthorized: boolean;
  memberIntentEffective: boolean | null;
  groupIntentStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  groupIntentNote: string | null;
  groupIntentExpiresAt: string | null;
  applicationPending: boolean | null;
  invitationOutstanding: boolean | null;
  pairActive: boolean;
  localMemberId: number | null;
  authorized: boolean;
  managerIds: number[];
  projectionDirections: Array<'APPLICATION' | 'INVITATION'>;
};

/** Names the group's business scope before locking when no request exists yet.
 * It authorizes nothing; `dissolvedAt` lets the owner
 * reject a dissolved group's invitation before any write or pair mint. */
export function groupAuthoredMembershipTargetLocatorSql(input: {
  threadId: number;
}) {
  return sql`
    SELECT g.account AS "groupAccount", g.domain AS "groupDomain",
      g."dissolvedAt" AS "dissolvedAt"
    FROM ${groupStateSql} g WHERE g.id = ${input.threadId}
  `;
}

/** Resolve only the group's stable lock name and the target's current identity
 * namespace. Manager authorization and mutable group state are deliberately
 * re-read by the post-lock authorization query. */
export function groupAuthoredInvitationLocatorSql(input: {
  threadId: number;
  targetAccount: string;
  targetDomain: string;
}) {
  return sql`
    SELECT g.account AS "groupAccount", g.domain AS "groupDomain",
      target."namespaceId" AS "targetNamespaceId"
    FROM ${groupStateSql} g
    LEFT JOIN LATERAL (
      SELECT 0::integer AS "namespaceId"
      WHERE ${input.targetDomain} = 'local' AND EXISTS (
        SELECT 1 FROM "Account" local_target
        WHERE local_target.account = ${input.targetAccount}
          AND local_target.domain = 'local' AND local_target."namespaceId" = 0
      )
      UNION ALL
      SELECT peer."activeNamespaceId"
      FROM "FederatedPeer" peer
      JOIN "IdentityNamespace" ns ON ns.id = peer."activeNamespaceId"
        AND ns."retiredAt" IS NULL
      WHERE ${input.targetDomain} <> 'local'
        AND peer.domain = ${input.targetDomain}
    ) target ON true
    WHERE g.id = ${input.threadId}
  `;
}

/** Locate the current canonical pair for an addressed manager decision. The
 * post-lock authorization query checks its mutable intent and roster state. */
export function groupAuthoredMembershipAddressLocatorSql(input: {
  threadId: number;
  targetAccount: string;
  targetDomain: string;
}) {
  return sql`
    SELECT pair.id::text AS "pairId",
      pair."endpointBAccount" AS account, pair."endpointBDomain" AS domain,
      pair."endpointBNamespaceId" AS "namespaceId",
      g.account AS "groupAccount", g.domain AS "groupDomain"
    FROM ${groupStateSql} g
    JOIN "RelationshipPair" pair ON pair."threadId" = g.id
      AND pair.kind = 'GROUP_MEMBER'
      AND pair."endpointAAccount" = g.account
      AND pair."endpointADomain" = g.domain
      AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
    WHERE g.id = ${input.threadId}
      AND pair."endpointBAccount" = ${input.targetAccount}
      AND pair."endpointBDomain" = ${input.targetDomain}
      AND pair."endpointBNamespaceId" = CASE
        WHEN ${input.targetDomain} = 'local' THEN 0
        ELSE (SELECT peer."activeNamespaceId" FROM "FederatedPeer" peer
          WHERE peer.domain = ${input.targetDomain}) END
    ORDER BY pair.id DESC LIMIT 1
  `;
}

/** The invitation (group-authored REQUESTED) variant. The caller has already
 * minted the canonical pair, so member identity is the command's target address
 * rather than the reverse intent; the side B row may legitimately not exist.
 * ACK and REVOKE consume its addressed authorization row directly. */
export function groupAuthoredMembershipInvitationAuthorizationSql(input: {
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
      COALESCE((SELECT pair.active FROM "RelationshipPair" pair
        WHERE pair.id = ${input.pairId}), false) AS "pairActive",
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
          AND p.status = 'REQUESTED'), '[]'::jsonb) AS "projectionDirections"
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
