import { sql, type SQLWrapper } from 'drizzle-orm';
import type { NamespacedAddress } from '../../common/client-identity.js';
import { relationshipEndpointMatchesUserSql } from './relationship-authorization.js';

export function addressRelation(address: NamespacedAddress) {
  return sql`(SELECT ${address.account}::text AS account, ${address.domain}::text AS domain,
    ${address.namespaceId}::integer AS "namespaceId")`;
}

/** Derive the other endpoint directly from the retained pair, without a remote Account row. */
export function p2pPeerRelation(pair: SQLWrapper, self: SQLWrapper) {
  const selfIsA = relationshipEndpointMatchesUserSql(pair, 'A', self);
  const selfIsB = relationshipEndpointMatchesUserSql(pair, 'B', self);
  return sql`LATERAL (
    SELECT CASE WHEN ${selfIsA} THEN ${pair}."endpointBAccount" ELSE ${pair}."endpointAAccount" END AS account,
      CASE WHEN ${selfIsA} THEN ${pair}."endpointBDomain" ELSE ${pair}."endpointADomain" END AS domain,
      CASE WHEN (CASE WHEN ${selfIsA} THEN ${pair}."endpointBDomain" ELSE ${pair}."endpointADomain" END) = 'local'
        THEN 0 ELSE ${pair}."endpointANamespaceId" END AS "namespaceId",
      CASE WHEN ${selfIsA} THEN 'B' ELSE 'A' END AS side
    WHERE (${selfIsA}) OR (${selfIsB})
  )`;
}
