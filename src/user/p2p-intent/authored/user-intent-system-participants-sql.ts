import { sql, type SQL } from 'drizzle-orm';

/** Snapshot both relationship endpoints at the event boundary. An authored
 * intent's write is invisible to sibling CTEs in the base-table snapshot, so
 * its revision must come from the materialized authored state instead — the
 * actorState CTE returns the author coordinates so its row can be matched to
 * the direction being rendered. The local endpoint (side A) has namespace zero.
 * Each participant carries its own publisher namespace; display domains are
 * not part of the wire contract. */
export function userIntentSystemParticipantsSql(input: {
  pairId: bigint;
  actorState: 'accepted' | 'revocation';
}): SQL {
  const revision = (cols: {
    author: SQL;
    authorNamespace: SQL;
    receiver: SQL;
    receiverNamespace: SQL;
  }) => sql`COALESCE((
      SELECT a."profileRev" FROM ${sql.identifier(input.actorState)} a
        WHERE a."authorAccount" = ${cols.author} AND a."authorNamespaceId" = ${cols.authorNamespace}
    ), (
      SELECT "profileRev" FROM "RelationshipIntent"
        WHERE "authorAccount" = ${cols.author} AND "authorNamespaceId" = ${cols.authorNamespace}
          AND "receiverAccount" = ${cols.receiver} AND "receiverNamespaceId" = ${cols.receiverNamespace}
        LIMIT 1
    ), 0)`;
  return sql`(SELECT jsonb_build_array(
      jsonb_build_object('account', p."endpointAAccount",
        'publisherNamespaceId', p."endpointANamespaceId",
        'profileNamespaceId', 0,
        'profileRev', ${revision({
          author: sql`p."endpointAAccount"`,
          authorNamespace: sql`p."endpointANamespaceId"`,
          receiver: sql`p."endpointBAccount"`,
          receiverNamespace: sql`p."endpointBNamespaceId"`,
        })}),
      jsonb_build_object('account', p."endpointBAccount",
        'publisherNamespaceId', p."endpointBNamespaceId",
        'profileNamespaceId', 0,
        'profileRev', ${revision({
          author: sql`p."endpointBAccount"`,
          authorNamespace: sql`p."endpointBNamespaceId"`,
          receiver: sql`p."endpointAAccount"`,
          receiverNamespace: sql`p."endpointANamespaceId"`,
        })}))
    FROM "RelationshipPair" p
    WHERE p.id = ${input.pairId})`;
}
