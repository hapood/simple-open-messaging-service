import { sql, type SQL } from 'drizzle-orm';

/** Snapshot both relationship endpoints at the event boundary. An authored
 * intent's write is invisible to sibling CTEs in the base-table snapshot, so
 * its revision must come from the materialized authored state instead — the
 * actorState CTE returns the author coordinates so its row can be matched to
 * the direction being rendered. The local endpoint (side A) has namespace zero;
 * a remote endpoint's display domain resolves through IdentityNamespace. The
 * enclosing message supplies the publisher namespace. */
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
      jsonb_build_object('account', p."endpointAAccount", 'domain', 'local',
        'profileNamespaceId', p."endpointANamespaceId",
        'profileRev', ${revision({
          author: sql`p."endpointAAccount"`,
          authorNamespace: sql`p."endpointANamespaceId"`,
          receiver: sql`p."endpointBAccount"`,
          receiverNamespace: sql`p."endpointBNamespaceId"`,
        })}),
      jsonb_build_object('account', p."endpointBAccount", 'domain', nb.domain,
        'profileNamespaceId', p."endpointBNamespaceId",
        'profileRev', ${revision({
          author: sql`p."endpointBAccount"`,
          authorNamespace: sql`p."endpointBNamespaceId"`,
          receiver: sql`p."endpointAAccount"`,
          receiverNamespace: sql`p."endpointANamespaceId"`,
        })}))
    FROM "RelationshipPair" p
    LEFT JOIN "IdentityNamespace" nb ON nb.id = p."endpointBNamespaceId"
    WHERE p.id = ${input.pairId})`;
}
