import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { accountThreadState } from '../../database/schema.js';
import { captureThreadStateUpdatesInTx } from '../../client-state-feed/capture-thread-state-updates.js';
import type { PendingClientStateFeedUpdate } from '../../client-state-feed/client-state-feed.service.js';

/** Called only after an actual membership departure, under the caller's locks.
 * Read-only projections retain the old role; wake former managers to reconcile
 * request cards even if message unread/preview did not change. */
export async function captureGroupDepartureUpdatesInTx(
  tx: DatabaseTransaction,
  threadId: number,
  userId: number,
): Promise<PendingClientStateFeedUpdate[]> {
  const [manager] = await tx
    .select({ id: accountThreadState.id })
    .from(accountThreadState)
    .where(
      and(
        eq(accountThreadState.threadId, threadId),
        eq(accountThreadState.accountId, userId),
        inArray(accountThreadState.role, ['OWNER', 'ADMIN']),
      ),
    )
    .limit(1);
  // A departing manager's request attention is revoked: capture as
  // group-request-read so devices silently reconcile; anyone else only needs
  // the plain thread head.
  return manager
    ? captureThreadStateUpdatesInTx(tx, [userId], 'group-request-read')
    : captureThreadStateUpdatesInTx(tx, [userId]);
}
