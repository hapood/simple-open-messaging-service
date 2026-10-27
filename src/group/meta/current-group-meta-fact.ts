import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { groupMetaMemberFeed } from '../../database/schema.js';

/** All four operations use the same storage and copy-time rules. Announcement
 * has one group-wide key; the other facts use the publisher-scoped subject key. */
export async function upsertCurrentGroupMetaFactsInTx(
  tx: DatabaseTransaction,
  facts: (typeof groupMetaMemberFeed.$inferInsert)[],
): Promise<void> {
  const now = new Date();
  for (const announcement of [false, true]) {
    const batch = facts.filter(
      (fact) => (fact.operation === 'GROUP_ANNOUNCEMENT') === announcement,
    );
    if (!batch.length) continue;
    const target = announcement
      ? sql`("threadId") WHERE operation = 'GROUP_ANNOUNCEMENT'`
      : sql`("threadId", (body ->> 'account'), (body -> 'namespaceId')) WHERE operation <> 'GROUP_ANNOUNCEMENT'`;
    await tx.execute(sql`
      INSERT INTO "GroupMetaMemberFeed"
        ("threadId", "feedId", operation, body, "profileSourceSeq", "createdAt", "originCreatedAt")
      SELECT value.thread_id, value.feed_id, value.operation, value.body,
        value.profile_source_seq, value.created_at, value.origin_created_at
      FROM unnest(
        ${sql.param(batch.map((fact) => fact.threadId))}::integer[],
        ${sql.param(batch.map((fact) => fact.feedId))}::integer[],
        ${sql.param(batch.map((fact) => fact.operation))}::"GroupMetaMemberOperation"[],
        ARRAY[${sql.join(
          batch.map((fact) => sql`${JSON.stringify(fact.body)}::jsonb`),
          sql`, `,
        )}]::jsonb[],
        ${sql.param(batch.map((fact) => fact.profileSourceSeq ?? null))}::integer[],
        ${sql.param(batch.map((fact) => (fact.createdAt ?? now).toISOString()))}::timestamptz[],
        ${sql.param(batch.map((fact) => fact.originCreatedAt?.toISOString() ?? null))}::timestamptz[]
      ) AS value(thread_id, feed_id, operation, body, profile_source_seq, created_at, origin_created_at)
      ON CONFLICT ${target} DO UPDATE SET
        "createdAt" = CASE WHEN "GroupMetaMemberFeed"."feedId" = EXCLUDED."feedId"
          THEN "GroupMetaMemberFeed"."createdAt" ELSE EXCLUDED."createdAt" END,
        "originCreatedAt" = CASE WHEN "GroupMetaMemberFeed"."feedId" = EXCLUDED."feedId"
          THEN "GroupMetaMemberFeed"."originCreatedAt" ELSE EXCLUDED."originCreatedAt" END,
        "feedId" = EXCLUDED."feedId", operation = EXCLUDED.operation, body = EXCLUDED.body,
        "profileSourceSeq" = CASE WHEN "GroupMetaMemberFeed".operation = 'MEMBER_DEPART'
          AND EXCLUDED.operation = 'MEMBER_UPSERT' THEN NULL
          ELSE "GroupMetaMemberFeed"."profileSourceSeq" END,
        "updatedAt" = CURRENT_TIMESTAMP
    `);
  }
}
