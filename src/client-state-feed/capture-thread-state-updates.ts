import { inArray } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { account } from '../database/schema.js';
import type {
  GroupRequestArrivalEvent,
  GroupRequestReadEvent,
  PendingClientStateFeedUpdate,
} from './client-state-feed.service.js';

/** A captured head snapshot stamped as the caller's final feed event. */
export interface CapturedThreadStateUpdate {
  kind: 'thread-feed';
  userId: number;
  feedId: number;
  threadFeedEndId: number;
}

export type CaptureEventKind =
  | 'thread-feed'
  | 'group-request-arrival'
  | 'group-request-read';

/** Capture both allocators after conversation writes, including trigger-produced
 * snapshots, and stamp them with the event kind the caller's domain intends.
 * The owning transaction publishes these events only after commit. */
export async function captureThreadStateUpdatesInTx(
  tx: DatabaseTransaction,
  userIds: readonly number[],
  kind: 'group-request-arrival',
): Promise<GroupRequestArrivalEvent[]>;
export async function captureThreadStateUpdatesInTx(
  tx: DatabaseTransaction,
  userIds: readonly number[],
  kind: 'group-request-read',
): Promise<GroupRequestReadEvent[]>;
export async function captureThreadStateUpdatesInTx(
  tx: DatabaseTransaction,
  userIds: readonly number[],
  kind?: 'thread-feed',
): Promise<CapturedThreadStateUpdate[]>;
export async function captureThreadStateUpdatesInTx(
  tx: DatabaseTransaction,
  userIds: readonly number[],
  kind: CaptureEventKind = 'thread-feed',
): Promise<PendingClientStateFeedUpdate[]> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return [];
  const rows = await tx
    .select({
      userId: account.id,
      feedId: account.clientStateFeedEndId,
      threadFeedEndId: account.threadFeedEndId,
    })
    .from(account)
    .where(inArray(account.id, ids));
  return rows.map((row) => ({ ...row, kind }));
}
