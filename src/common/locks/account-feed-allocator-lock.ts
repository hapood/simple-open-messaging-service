import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';

/**
 * Lock every Account row whose client or thread-feed allocator may advance.
 * The caller must acquire this terminal implicit resource after the business
 * and thread locks, but before writing participant or feed state. Sorting here
 * makes allocator acquisition independent of query and audience order.
 */
export async function lockAccountFeedAllocatorsInTx(
  tx: DatabaseTransaction,
  accountIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(accountIds)].sort((left, right) => left - right);
  if (ids.length === 0) return;
  await tx.execute(sql`
    SELECT id FROM "Account"
    WHERE id = ANY(${sql.param(ids)}::integer[])
    ORDER BY id
    FOR NO KEY UPDATE
  `);
}
