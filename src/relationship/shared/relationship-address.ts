import { sql, type SQLWrapper } from 'drizzle-orm';
import type { NamespacedAddress } from '../../common/client-identity.js';
import { relationshipEndpointMatchesUserSql } from './relationship-authorization.js';

export function addressRelation(address: NamespacedAddress) {
  return sql`(SELECT ${address.account}::text AS account, ${address.domain}::text AS domain,
    ${address.namespaceId}::integer AS "namespaceId")`;
}

/** Derive the other endpoint directly from the retained pair, without a remote
 * Account row. The display domain resolves through IdentityNamespace (namespace
 * 0 is local), so both sides of the pair share one resolution rule. */
export function p2pPeerRelation(pair: SQLWrapper, self: SQLWrapper) {
  const selfIsA = relationshipEndpointMatchesUserSql(pair, 'A', self);
  const selfIsB = relationshipEndpointMatchesUserSql(pair, 'B', self);
  return sql`LATERAL (
    SELECT CASE WHEN ${selfIsA} THEN ${pair}."endpointBAccount"
        ELSE ${pair}."endpointAAccount" END AS account,
      CASE WHEN ${selfIsA} THEN ${pair}."endpointBNamespaceId"
        ELSE ${pair}."endpointANamespaceId" END AS "namespaceId",
      peer_ns.domain AS domain
    FROM (SELECT 1) probe
    LEFT JOIN "IdentityNamespace" peer_ns ON peer_ns.id =
      CASE WHEN ${selfIsA} THEN ${pair}."endpointBNamespaceId"
        ELSE ${pair}."endpointANamespaceId" END
    WHERE (${selfIsA}) OR (${selfIsB})
  )`;
}
