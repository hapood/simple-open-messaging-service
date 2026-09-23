import { sql, type SQL } from 'drizzle-orm';

/** Snapshot both relationship endpoints at the event boundary. An authored
 * intent's write is invisible to sibling CTEs in the base-table snapshot, so
 * its revision must come from the materialized authored state instead.
 * A pair's namespace fields may both refer to a federated binding; a local
 * endpoint's identity namespace is always zero. */
export function userIntentSystemParticipantsSql(input: {
  pairId: bigint;
  actorSide: 'A' | 'B';
  actorState: 'accepted' | 'revocation';
}): SQL {
  const revision = (side: 'A' | 'B') => sql`COALESCE(
    ${
      input.actorSide === side
        ? sql`(SELECT "profileRev" FROM ${sql.identifier(input.actorState)})`
        : sql`NULL::integer`
    },
    (SELECT "profileRev" FROM "RelationshipIntent"
      WHERE "pairId" = ${input.pairId} AND "authorSide" = ${side} LIMIT 1), 0)`;
  const endpoint = (side: 'A' | 'B') =>
    side === 'A'
      ? sql`jsonb_build_object('account', p."endpointAAccount", 'domain', p."endpointADomain",
          'namespaceId', CASE WHEN p."endpointADomain" = 'local' THEN 0 ELSE p."endpointANamespaceId" END,
          'profileRev', ${revision('A')})`
      : sql`jsonb_build_object('account', p."endpointBAccount", 'domain', p."endpointBDomain",
          'namespaceId', CASE WHEN p."endpointBDomain" = 'local' THEN 0 ELSE p."endpointBNamespaceId" END,
          'profileRev', ${revision('B')})`;
  return sql`(SELECT jsonb_build_array(${endpoint('A')}, ${endpoint('B')})
    FROM "RelationshipPair" p WHERE p.id = ${input.pairId})`;
}
