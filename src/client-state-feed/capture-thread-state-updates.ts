import { inArray } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { account } from '../database/schema.js';
import type { PendingClientStateFeedUpdate } from './client-state-feed.service.js';

/** Capture both allocators after conversation writes, including trigger-produced
 * snapshots. The owning transaction publishes these hints only after commit. */
export async function captureThreadStateUpdatesInTx(
  tx: DatabaseTransaction,
  userIds: readonly number[],
): Promise<PendingClientStateFeedUpdate[]> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return [];
  return tx
    .select({
      userId: account.id,
      feedId: account.stateFeedEndId,
      threadFeedEndId: account.threadFeedEndId,
    })
    .from(account)
    .where(inArray(account.id, ids));
}
