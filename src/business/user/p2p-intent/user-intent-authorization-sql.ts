import { sql, type SQL } from 'drizzle-orm';

/** Row shape of the pre-lock locator. Carries identities and structural facts
 * only; every mutable state gate is re-read after the locks it names. */
export interface UserIntentLocatorRow extends Record<string, unknown> {
  actorAccount: string;
  pairId: string | null;
  pairThreadId: number | null;
  /** Local Account.id of the target, or null when the target is peer-hosted
   * or does not exist. */
  localTargetId: number | null;
}

/** Pre-lock locator for a user-authored P2P intent command. The actor is an
 * authenticated local user; the target is addressed. It authorizes nothing and
 * carries no state gate — like the group family, a missing pair is authoritative
 * enough to reject before any lock, because an absent pair cannot change. */
export function userIntentLocatorSql(params: {
  actorUserId: number;
  targetAccount: string;
  targetDomain: string;
  targetNamespaceId: number;
}): SQL {
  return sql`
    WITH actor AS MATERIALIZED (
      SELECT id, account FROM "Account"
      WHERE id = ${params.actorUserId} AND domain = 'local' AND "namespaceId" = 0
    ), target_account AS MATERIALIZED (
      SELECT id FROM "Account"
      WHERE account = ${params.targetAccount} AND domain = ${params.targetDomain}
        AND "namespaceId" = 0
        AND ${params.targetDomain === 'local' ? sql`true` : sql`false`}
    ), pair AS MATERIALIZED (
      SELECT p.id, p."threadId"
      FROM "RelationshipPair" p CROSS JOIN actor a
      WHERE p.kind = 'P2P'
        AND p."endpointAType" = 'USER' AND p."endpointBType" = 'USER'
        AND p."endpointANamespaceId" = p."endpointBNamespaceId"
        AND p."endpointANamespaceId" = ${params.targetNamespaceId}
        AND (p."endpointAAccount" = a.account AND p."endpointADomain" = 'local'
          AND p."endpointBAccount" = ${params.targetAccount} AND p."endpointBDomain" = ${params.targetDomain}
        OR p."endpointBAccount" = a.account AND p."endpointBDomain" = 'local'
          AND p."endpointAAccount" = ${params.targetAccount} AND p."endpointADomain" = ${params.targetDomain})
    )
    SELECT a.account AS "actorAccount", pair.id::text AS "pairId",
      pair."threadId", t.id::integer AS "localTargetId"
    FROM actor a
    LEFT JOIN pair ON true
    LEFT JOIN target_account t ON true
  `;
}

/** Row shape of the post-lock authorization statement: both directed intents,
 * the pair, the thread head, and the local identities the composed statements
 * write. Effectiveness (REQUESTED within expiry, or ACCEPTED) is derived by the
 * transaction owner with the same rule as RelationshipIntentService. */
export interface UserIntentAuthorizationRow extends Record<string, unknown> {
  pairActive: boolean;
  pairEstablished: boolean;
  threadId: number;
  threadCurSeq: number;
  ownStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  ownNote: string | null;
  ownRequestedAt: string | null;
  ownExpiresAt: string | null;
  ownProfileRev: number | null;
  reverseStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  reverseNote: string | null;
  reverseRequestedAt: string | null;
  reverseExpiresAt: string | null;
  reverseProfileRev: number | null;
  actorAvailability: string;
  localTargetId: number | null;
  targetAvailability: string | null;
}

/** One post-lock authorization statement. The pair and both intent rows are
 * already FOR NO KEY UPDATE locked by the preamble; this reads the branch state
 * the three commands dispatch on. */
export function userIntentAuthorizationSql(params: {
  pairId: bigint;
  actorUserId: number;
  targetAccount: string;
  targetDomain: string;
  actorSide: 'A' | 'B';
  reverseSide: 'A' | 'B';
}): SQL {
  return sql`
    SELECT p.active AS "pairActive", p.established AS "pairEstablished",
      p."threadId", t."curSeq" AS "threadCurSeq",
      own.status AS "ownStatus", own.note AS "ownNote",
      own."requestedAt"::text AS "ownRequestedAt", own."expiresAt"::text AS "ownExpiresAt",
      own."profileRev" AS "ownProfileRev",
      rev.status AS "reverseStatus", rev.note AS "reverseNote",
      rev."requestedAt"::text AS "reverseRequestedAt", rev."expiresAt"::text AS "reverseExpiresAt",
      rev."profileRev" AS "reverseProfileRev",
      a.availability AS "actorAvailability",
      tgt.id::integer AS "localTargetId", tgt.availability AS "targetAvailability"
    FROM "RelationshipPair" p
    JOIN "MessageThread" t ON t.id = p."threadId"
    LEFT JOIN "RelationshipIntent" own ON own."pairId" = p.id
      AND own."authorSide" = ${params.actorSide}
    LEFT JOIN "RelationshipIntent" rev ON rev."pairId" = p.id
      AND rev."authorSide" = ${params.reverseSide}
    CROSS JOIN "Account" a
    LEFT JOIN "Account" tgt ON tgt.account = ${params.targetAccount}
      AND tgt.domain = ${params.targetDomain} AND tgt."namespaceId" = 0
    WHERE p.id = ${params.pairId} AND a.id = ${params.actorUserId}
  `;
}
