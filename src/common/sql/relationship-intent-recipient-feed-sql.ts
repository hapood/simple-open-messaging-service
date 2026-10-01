import { sql, type SQL } from 'drizzle-orm';

/** Relationship-intent client feed writes → body dedupe, one allocation block per recipient, upsert,
 * result. `candidate_bodies` must select "userId", "namespaceId", ordinal,
 * "compactionKey", account, domain, "subjectAccount", "subjectNamespaceId", body —
 * one row per (recipient, direction); a recipient may hold several. A repeated
 * identical body neither allocates a feed id nor wakes anyone, matching
 * ClientStateFeedService.writeInTx's body-level dedupe. Callers may force a
 * fresh position for a repeated terminal effect on a newer request. */
export function clientIntentFeedWriteSql(options?: { force?: SQL }): SQL {
  return sql`
    fresh_bodies AS MATERIALIZED (
      SELECT b.*, row_number() OVER (PARTITION BY b."userId" ORDER BY b.ordinal) AS position,
        count(*) OVER (PARTITION BY b."userId") AS total
      FROM candidate_bodies b
      WHERE (${options?.force ?? sql`false`}) OR NOT EXISTS (SELECT 1 FROM "ClientStateFeed" f
        WHERE f."userId" = b."userId" AND f."compactionKey" = b."compactionKey" AND f.body = b.body)
    ), recipient_alloc AS (
      UPDATE "Account" a SET "clientStateFeedEndId" = a."clientStateFeedEndId" + t.total,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM (SELECT "userId", max(total) AS total FROM fresh_bodies GROUP BY "userId") t
      WHERE a.id = t."userId"
      RETURNING a.id AS "userId", a."clientStateFeedEndId" AS "allocatedThrough"
    ), recipient_feed AS (
      INSERT INTO "ClientStateFeed"
        ("userId", account, domain, "namespaceId", "eventType", "subjectAccount", "subjectNamespaceId", "feedId", "compactionKey", body)
      SELECT f."userId", f.account, f.domain, f."namespaceId", 'RELATIONSHIP_INTENT',
        f."subjectAccount", f."subjectNamespaceId",
        a."allocatedThrough" - f.total + f.position, f."compactionKey", f.body
      FROM fresh_bodies f JOIN recipient_alloc a ON a."userId" = f."userId"
      ON CONFLICT ("userId", "compactionKey") DO UPDATE SET
        "feedId" = EXCLUDED."feedId", body = EXCLUDED.body, "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "userId", "feedId"
    ), recipient_result AS MATERIALIZED (
      SELECT "userId", max("feedId")::text AS "feedId" FROM recipient_feed GROUP BY "userId"
    )
  `;
}

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
