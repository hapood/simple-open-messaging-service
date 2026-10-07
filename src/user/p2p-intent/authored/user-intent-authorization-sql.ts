import { sql, type SQL } from 'drizzle-orm';

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
      SELECT id, account, availability, "disabledAt"
      FROM "Account"
      WHERE id = ${params.actorUserId} AND "namespaceId" = 0
    ), actor_domain AS MATERIALIZED (
      SELECT domain FROM "IdentityNamespace" WHERE id = 0
    ), target_account AS MATERIALIZED (
      SELECT id, availability, "disabledAt" FROM "Account"
      WHERE account = ${params.targetAccount}
        AND "namespaceId" = 0
        AND ${params.targetNamespaceId} = 0
        AND (SELECT domain FROM actor_domain) = ${params.targetDomain}
    ), pair AS MATERIALIZED (
      SELECT p.id, p."threadId"
      FROM "RelationshipPair" p CROSS JOIN actor a
      WHERE p.kind = 'P2P'
        AND p."endpointAType" = 'USER' AND p."endpointBType" = 'USER'
        -- Canonical order (compareEndpoints): the local endpoint sits on A; a
        -- local actor and local target order by account string. Accounts are
        -- stored lowercase over [a-z0-9._-], where string comparison here
        -- matches localeCompare, so LEAST/GREATEST reproduce the mint order.
        AND p."endpointANamespaceId" = 0
        AND p."endpointBNamespaceId" = ${params.targetNamespaceId}
        AND p."endpointAAccount" = (CASE WHEN ${params.targetNamespaceId} = 0
          THEN LEAST(a.account, ${params.targetAccount}) ELSE a.account END)
        AND p."endpointBAccount" = (CASE WHEN ${params.targetNamespaceId} = 0
          THEN GREATEST(a.account, ${params.targetAccount}) ELSE ${params.targetAccount} END)
    )
    SELECT a.account AS "actorAccount", (SELECT domain FROM actor_domain) AS "actorDomain",
      a.availability AS "actorAvailability", a."disabledAt"::text AS "actorDisabledAt",
      pair.id::text AS "pairId", pair."threadId",
      t.id::integer AS "localTargetId",
      t.availability AS "localTargetAvailability",
      t."disabledAt"::text AS "localTargetDisabledAt"
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
  authorizationEpoch: number;
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
 * the three commands dispatch on. Both directions are addressed by the
 * actor/target coordinates the caller already holds. */
export function userIntentAuthorizationSql(params: {
  pairId: bigint;
  actorUserId: number;
  actorAccount: string;
  actorNamespaceId: number;
  targetAccount: string;
  targetDomain: string;
  targetNamespaceId: number;
}): SQL {
  const { actorAccount, actorNamespaceId, targetAccount, targetNamespaceId } =
    params;
  return sql`
    SELECT p.active AS "pairActive", p.established AS "pairEstablished",
      p."threadId", t."authorizationEpoch", t."curSeq" AS "threadCurSeq",
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
    LEFT JOIN "RelationshipIntent" own
      ON own."authorAccount" = ${actorAccount} AND own."authorNamespaceId" = ${actorNamespaceId}
      AND own."receiverAccount" = ${targetAccount} AND own."receiverNamespaceId" = ${targetNamespaceId}
    LEFT JOIN "RelationshipIntent" rev
      ON rev."authorAccount" = ${targetAccount} AND rev."authorNamespaceId" = ${targetNamespaceId}
      AND rev."receiverAccount" = ${actorAccount} AND rev."receiverNamespaceId" = ${actorNamespaceId}
    CROSS JOIN "Account" a
    LEFT JOIN "Account" tgt ON tgt.account = ${params.targetAccount}
      AND tgt."namespaceId" = 0
      AND ${params.targetNamespaceId} = 0
      AND (SELECT domain FROM "IdentityNamespace" WHERE id = 0) = ${params.targetDomain}
    WHERE p.id = ${params.pairId} AND a.id = ${params.actorUserId}
  `;
}
