import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { userBlock } from '../database/schema.js';

/**
 * UserBlock data layer.
 *
 * A block is one-way and INDEPENDENT of the Friendship state machine: it survives an unfriend, applies
 * to strangers, and does not reveal itself to the blocked user. Exactly one row per (blocker, blocked)
 * direction; a mutual block is two rows. The message path consults this to:
 *  - drop SSE / push / notif-snapshot fan-out to a participant who blocks the sender (they never get
 *    notified of, nor receive, the blocked user's messages);
 *  - filter query-messages so the blocker never sees a blocked creator's messages in the thread.
 *
 * Block is P2P-scoped at the call sites (the chat header menu only offers it for P2P threads; group
 * threads leave blocked members' messages visible — WhatsApp neutral-ground semantics).
 */
@Injectable()
export class UserBlockService {
  constructor(private readonly database: DatabaseService) {}

  /** Block a user. Idempotent: re-blocking an already-blocked user is a no-op (upsert). */
  async block(blockerId: number, blockedId: number): Promise<void> {
    await this.database.db
      .insert(userBlock)
      .values({ blockerId, blockedId })
      .onConflictDoNothing({
        target: [userBlock.blockerId, userBlock.blockedId],
      });
  }

  /** Unblock a user. Idempotent: unblocking someone not blocked is a no-op (deleteMany never throws). */
  async unblock(blockerId: number, blockedId: number): Promise<void> {
    await this.database.db
      .delete(userBlock)
      .where(
        and(
          eq(userBlock.blockerId, blockerId),
          eq(userBlock.blockedId, blockedId),
        ),
      );
  }

  /** Users whom `blockerId` has blocked. Hides their messages in query-messages (the blocker's view). */
  async blockedByMe(blockerId: number): Promise<Set<number>> {
    const rows = await this.database.db
      .select({ blockedId: userBlock.blockedId })
      .from(userBlock)
      .where(eq(userBlock.blockerId, blockerId));
    return new Set(rows.map((r) => r.blockedId));
  }

  /** Of `targetIds`, the subset that `blockerId` has blocked — batched lookup for hydrating a list of
   *  P2P conversations with each peer's blocked flag in one query. */
  async blockedAmong(
    blockerId: number,
    targetIds: number[],
  ): Promise<Set<number>> {
    if (targetIds.length === 0) return new Set();
    const rows = await this.database.db
      .select({ blockedId: userBlock.blockedId })
      .from(userBlock)
      .where(
        and(
          eq(userBlock.blockerId, blockerId),
          inArray(userBlock.blockedId, targetIds),
        ),
      );
    return new Set(rows.map((r) => r.blockedId));
  }

  /** Users who have blocked `userId`. Used by send-message fan-out to drop those recipients — they
   *  must not receive the sender's messages. */
  async blockersOf(userId: number): Promise<Set<number>> {
    const rows = await this.database.db
      .select({ blockerId: userBlock.blockerId })
      .from(userBlock)
      .where(eq(userBlock.blockedId, userId));
    return new Set(rows.map((r) => r.blockerId));
  }

  /** True iff `blockerId` currently blocks `blockedId`. */
  async isBlocked(blockerId: number, blockedId: number): Promise<boolean> {
    const row = await this.database.db
      .select({ id: userBlock.id })
      .from(userBlock)
      .where(
        and(
          eq(userBlock.blockerId, blockerId),
          eq(userBlock.blockedId, blockedId),
        ),
      )
      .limit(1);
    return row.length > 0;
  }
}
