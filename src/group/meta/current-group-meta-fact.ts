import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { groupMetaMemberFeed } from '../../database/schema.js';

/** The stable subject key of the current-fact unique index: the publisher
 * coordinate inside the body. The conflict target must repeat the exact index
 * expressions and predicate. */
const MEMBER_CONFLICT_TARGET = sql`("threadId", (body ->> 'account'), (body -> 'namespaceId')) WHERE operation <> 'GROUP_ANNOUNCEMENT'`;

/** Replace the current operation and coordinate for each stable group/member
 * key. The same write rule serves source reconciliation and direct membership
 * transitions; the primary key still rejects coordinate collisions. */
export async function upsertCurrentGroupMetaFactsInTx(
  tx: DatabaseTransaction,
  facts: (typeof groupMetaMemberFeed.$inferInsert)[],
): Promise<void> {
  if (facts.length === 0) return;
  await tx.execute(sql`
    INSERT INTO "GroupMetaMemberFeed" ("threadId", "feedId", operation, body, "profileSourceSeq")
    SELECT values.thread_id, values.feed_id, values.operation, values.body::jsonb, values.profile_source_seq
    FROM unnest(
      ${sql.param(facts.map((fact) => fact.threadId))}::integer[],
      ${sql.param(facts.map((fact) => fact.feedId))}::integer[],
      ${sql.param(facts.map((fact) => fact.operation))}::"GroupMetaMemberOperation"[],
      ARRAY[${sql.join(
        facts.map((fact) => sql`${JSON.stringify(fact.body)}::jsonb`),
        sql`, `,
      )}]::jsonb[],
      ${sql.param(facts.map((fact) => fact.profileSourceSeq ?? null))}::integer[]
    ) AS values(thread_id, feed_id, operation, body, profile_source_seq)
    ON CONFLICT ${MEMBER_CONFLICT_TARGET}
    DO UPDATE SET "feedId" = EXCLUDED."feedId",
      operation = EXCLUDED.operation,
      body = EXCLUDED.body,
      -- Departures retain the old message coordinate; rejoining starts a
      -- new membership interval and must not inherit that coordinate.
      "profileSourceSeq" = CASE WHEN "GroupMetaMemberFeed".operation = 'MEMBER_DEPART'
        AND EXCLUDED.operation = 'MEMBER_UPSERT' THEN NULL
        ELSE "GroupMetaMemberFeed"."profileSourceSeq" END,
      "updatedAt" = CURRENT_TIMESTAMP
  `);
}
