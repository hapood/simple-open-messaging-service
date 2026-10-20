import { sql } from 'drizzle-orm';

/** Row of the thread-keyed established-relationship locator: the caller's own
 * account plus both pair endpoints. The caller's side is identified by its
 * local (namespace 0) account; the peer endpoint becomes the REVOKED target. */
export interface ActivePeerByThreadRow extends Record<string, unknown> {
  actorAccount: string;
  endpointAAccount: string;
  endpointANamespaceId: number;
  endpointBAccount: string;
  endpointBNamespaceId: number;
  pairActive: boolean;
  authorizationEpoch: number;
}

/** Locate the P2P pair owning a thread for one local caller. The statement is
 * a plain read: pair and account business locks stay owned by the composed
 * intent transaction that runs after the peer endpoint is resolved. */
export function activePeerByThreadSql(userId: number, threadId: number) {
  return sql`
    SELECT a.account AS "actorAccount",
      p."endpointAAccount", p."endpointANamespaceId",
      p."endpointBAccount", p."endpointBNamespaceId",
      p.active AS "pairActive", t."authorizationEpoch"
    FROM "Account" a
    JOIN "MessageThread" t
      ON t.id = ${threadId} AND t.type = 'P2P'
    JOIN "RelationshipPair" p
      ON p."threadId" = t.id
      AND p.kind = 'P2P'
      AND p."endpointAType" = 'USER'
      AND p."endpointBType" = 'USER'
    WHERE a.id = ${userId}
      AND a."namespaceId" = 0
  `;
}
