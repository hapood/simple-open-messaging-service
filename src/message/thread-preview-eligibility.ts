import { sql, type SQLWrapper } from 'drizzle-orm';
import { relationshipEndpointMatchesUserSql } from '../relationship/shared/relationship-authorization.js';

/** One owner predicate for startup and explicit initialization; retained history is not active membership. */
export function eligiblePreviewOwnerSql(
  state: SQLWrapper,
  thread: SQLWrapper,
  owner: SQLWrapper,
) {
  return sql`${state}.blocked = false
    AND ${owner}.domain = 'local' AND ${owner}."namespaceId" = 0
    AND ${owner}.availability = 'AVAILABLE'
    AND EXISTS (
      SELECT 1 FROM "IdentityNamespace" ns
      WHERE ns.id = ${thread}."authorityNamespaceId" AND ns."retiredAt" IS NULL
        AND (ns.id = 0 OR EXISTS (
          SELECT 1 FROM "FederatedPeer" peer
          WHERE peer."activeNamespaceId" = ns.id
        ))
    )
    AND EXISTS (
      SELECT 1 FROM "RelationshipPair" pair
      WHERE pair."threadId" = ${thread}.id AND pair.active = true
        AND ((${thread}.type = 'P2P' AND pair.kind = 'P2P')
          OR (${thread}.type = 'GROUP' AND pair.kind = 'GROUP_MEMBER'))
        AND ((${relationshipEndpointMatchesUserSql(sql`pair`, 'A', owner)})
          OR (${relationshipEndpointMatchesUserSql(sql`pair`, 'B', owner)}))
    )`;
}
