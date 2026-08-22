import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  clientMessageFeed,
  clientMessageFeedTarget,
  clientMessageTombstoneFeed,
  threadParticipant,
  user,
} from '../database/schema.js';

/** Product policy switch: whether a user's own authored messages advance that user's client message feed. */
export const CLIENT_MESSAGE_FEED_INCLUDE_SELF = false;

/** Transactional writer for the two per-user compacted client feeds.
 *
 * The allocator row is the commit-order lock for one user. Participant ids are always visited in ascending
 * order so two messages delivered to overlapping groups cannot acquire the same allocator rows in opposite
 * order. All callers must invoke these methods inside the transaction that creates the source fact. */
export class ClientMessageFeedWriter {
  static async publishMessage(
    tx: DatabaseTransaction,
    threadId: number,
    messageEndSeq: number,
    creatorId: number,
  ): Promise<void> {
    const userIds = await this.activeUserIds(
      tx,
      threadId,
      CLIENT_MESSAGE_FEED_INCLUDE_SELF ? undefined : creatorId,
    );
    for (const userId of userIds) {
      await this.ensureTarget(tx, userId);
      // Lock before inspecting the compacted row. This makes the no-op check and allocation one ordered
      // operation for the user even when different threads are being published concurrently.
      await this.lockTarget(tx, userId);
      const threadCurrent = await tx.query.clientMessageFeed.findFirst({
        where: sql`${clientMessageFeed.userId} = ${userId} AND ${clientMessageFeed.threadId} = ${threadId}`,
        columns: { messageEndSeq: true },
      });
      if (threadCurrent && threadCurrent.messageEndSeq >= messageEndSeq)
        continue;
      const [allocated] = await tx
        .update(clientMessageFeedTarget)
        .set({
          messageAllocatedThrough: sql`${clientMessageFeedTarget.messageAllocatedThrough} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(clientMessageFeedTarget.userId, userId))
        .returning({ feedId: clientMessageFeedTarget.messageAllocatedThrough });
      if (!allocated)
        throw new Error(`missing client feed target for user ${userId}`);
      await tx
        .insert(clientMessageFeed)
        .values({ userId, threadId, feedId: allocated.feedId, messageEndSeq })
        .onConflictDoUpdate({
          target: [clientMessageFeed.userId, clientMessageFeed.threadId],
          set: {
            feedId: allocated.feedId,
            messageEndSeq,
            updatedAt: new Date(),
          },
          setWhere: sql`${clientMessageFeed.feedId} < ${allocated.feedId}`,
        });
    }
  }

  static async publishTombstone(
    tx: DatabaseTransaction,
    threadId: number,
    tombstoneEndSeq: bigint,
  ): Promise<void> {
    const userIds = await this.activeUserIds(tx, threadId);
    for (const userId of userIds) {
      await this.ensureTarget(tx, userId);
      await this.lockTarget(tx, userId);
      const current = await tx.query.clientMessageTombstoneFeed.findFirst({
        where: sql`${clientMessageTombstoneFeed.userId} = ${userId} AND ${clientMessageTombstoneFeed.threadId} = ${threadId}`,
        columns: { tombstoneEndSeq: true },
      });
      if (current && current.tombstoneEndSeq >= tombstoneEndSeq) continue;
      const [allocated] = await tx
        .update(clientMessageFeedTarget)
        .set({
          tombstoneAllocatedThrough: sql`${clientMessageFeedTarget.tombstoneAllocatedThrough} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(clientMessageFeedTarget.userId, userId))
        .returning({
          feedId: clientMessageFeedTarget.tombstoneAllocatedThrough,
        });
      if (!allocated)
        throw new Error(`missing client feed target for user ${userId}`);
      await tx
        .insert(clientMessageTombstoneFeed)
        .values({
          userId,
          threadId,
          feedId: allocated.feedId,
          tombstoneEndSeq,
        })
        .onConflictDoUpdate({
          target: [
            clientMessageTombstoneFeed.userId,
            clientMessageTombstoneFeed.threadId,
          ],
          set: {
            feedId: allocated.feedId,
            tombstoneEndSeq,
            updatedAt: new Date(),
          },
          setWhere: sql`${clientMessageTombstoneFeed.feedId} < ${allocated.feedId}`,
        });
    }
  }

  private static async activeUserIds(
    tx: DatabaseTransaction,
    threadId: number,
    excludedUserId?: number,
  ): Promise<number[]> {
    const rows = await tx
      .select({ userId: threadParticipant.userId })
      .from(threadParticipant)
      .innerJoin(user, eq(user.id, threadParticipant.userId))
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          sql`${threadParticipant.state} = 'ESTABLISHED'`,
          eq(user.domain, 'local'),
          eq(user.isDeleted, false),
          ...(excludedUserId === undefined
            ? []
            : [ne(threadParticipant.userId, excludedUserId)]),
        ),
      )
      .orderBy(asc(threadParticipant.userId));
    return rows.map((row) => row.userId);
  }

  private static async ensureTarget(
    tx: DatabaseTransaction,
    userId: number,
  ): Promise<void> {
    await tx
      .insert(clientMessageFeedTarget)
      .values({ userId })
      .onConflictDoNothing({ target: clientMessageFeedTarget.userId });
  }

  private static async lockTarget(
    tx: DatabaseTransaction,
    userId: number,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT 1 FROM "ClientMessageFeedTarget" WHERE "userId" = ${userId} FOR UPDATE`,
    );
  }
}
