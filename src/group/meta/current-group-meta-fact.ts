import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { groupMetaMemberFeed } from '../../database/schema.js';

/** Replace the current operation and coordinate for each stable group/member
 * key. The same write rule serves source reconciliation and direct membership
 * transitions; the primary key still rejects coordinate collisions. */
export async function upsertCurrentGroupMetaFactsInTx(
  tx: DatabaseTransaction,
  facts: (typeof groupMetaMemberFeed.$inferInsert)[],
): Promise<void> {
  if (facts.length === 0) return;
  await tx
    .insert(groupMetaMemberFeed)
    .values(facts)
    .onConflictDoUpdate({
      target: [
        groupMetaMemberFeed.threadId,
        groupMetaMemberFeed.memberAccount,
        groupMetaMemberFeed.profileNamespaceId,
      ],
      set: {
        feedId: sql`EXCLUDED."feedId"`,
        operation: sql`EXCLUDED.operation`,
        body: sql`EXCLUDED.body`,
        // Departures retain the old message coordinate; rejoining starts a
        // new membership interval and must not inherit that coordinate.
        profileSourceSeq: sql`CASE WHEN "GroupMetaMemberFeed".operation = 'MEMBER_DEPART'
          AND EXCLUDED.operation = 'MEMBER_UPSERT' THEN NULL
          ELSE "GroupMetaMemberFeed"."profileSourceSeq" END`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
}
