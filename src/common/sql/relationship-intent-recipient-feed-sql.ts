import { sql, type SQL } from 'drizzle-orm';

/** Peer feed writes → dedupe, one allocation block, upsert, result. The caller
 * builds `peer_changes` (body, position, and optionally invalid) so per-statement
 * dedupe rules stay explicit. `resultName` renames the result CTE when a
 * statement publishes both a local recipient and a peer event. */
export function peerIntentFeedWriteSql(params: {
  namespaceId: number;
  selfAccount: string;
  resultName?: string;
}): SQL {
  const resultName = params.resultName ?? 'recipient_result';
  return sql`
    peer_alloc AS (
      UPDATE "IdentityNamespace" SET "stateFeedEndId" = "stateFeedEndId" + (SELECT count(*) FROM peer_changes)
      WHERE id = ${params.namespaceId} AND "retiredAt" IS NULL
      RETURNING "stateFeedEndId" AS "allocatedThrough"
    ), peer_feed AS (
      INSERT INTO "PeerStateFeed"
        ("namespaceId", account, "eventType", "subjectAccount", "subjectNamespaceId", "feedId", body)
      SELECT ${params.namespaceId}, ${params.selfAccount},
        'RELATIONSHIP_INTENT', c."subjectAccount",
        c."subjectNamespaceId",
        a."allocatedThrough" - (SELECT count(*) FROM peer_changes) + c.position, c.body
      FROM peer_changes c CROSS JOIN peer_alloc a
      ON CONFLICT ("namespaceId", account, "eventType", "subjectAccount", "subjectNamespaceId") DO UPDATE SET
        "feedId" = EXCLUDED."feedId", body = EXCLUDED.body, "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "feedId"
    ), ${sql.raw(resultName)} AS MATERIALIZED (
      SELECT NULL::integer AS "userId", max("feedId")::text AS "feedId",
        COALESCE((SELECT bool_or(invalid) FROM peer_changes), false) AS invalid
      FROM peer_feed
    )
  `;
}
