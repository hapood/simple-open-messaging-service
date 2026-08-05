import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type Database,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { threadRevision, user } from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';

export interface PendingThreadRevision {
  userId: number;
  revision: number;
}

/**
 * Per-user thread-list versioning. Every thread add/delete (friend approve, group join, unfriend,
 * leave, kick) bumps User.threadRevision and writes a ThreadRevision log row (ADD or DELETE); the
 * client holds threadRevision as its cursor and pulls ADD/DELETE deltas via query-thread(from, to].
 *
 * The ADD row carries an `isDelete` flag (redundant with the DELETE row's existence) for fast "active
 * threads" queries (WHERE direction=ADD AND isDelete=false) — snapshot(revision=R) still uses the
 * revision columns for historical accuracy. Re-add upserts the ADD row (isDelete=false + new revision).
 */
@Injectable()
export class ThreadRevisionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
  ) {}

  /** Record a thread ADD: bump threadRevision, upsert the ADD row (reactivate on re-add), push signal. */
  async recordThreadAdd(userId: number, threadId: number): Promise<void> {
    const revision = await this.database.db.transaction((tx) =>
      this.recordThreadAddInTx(tx, userId, threadId),
    );
    this.notifyThreadRevision({ userId, revision });
  }

  async recordThreadAddInTx(
    tx: DatabaseTransaction,
    userId: number,
    threadId: number,
  ): Promise<number> {
    const [u] = await tx
      .update(user)
      .set({
        threadRevision: sql`${user.threadRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId))
      .returning({ threadRevision: user.threadRevision });
    await tx
      .insert(threadRevision)
      .values({
        userId,
        threadId,
        direction: 'ADD',
        revision: u.threadRevision,
        isDelete: false,
      })
      .onConflictDoUpdate({
        target: [
          threadRevision.userId,
          threadRevision.threadId,
          threadRevision.direction,
        ],
        set: { revision: u.threadRevision, isDelete: false },
      });
    return u.threadRevision;
  }

  notifyThreadRevision(pending: PendingThreadRevision): void {
    this.sse.onThreadRevisionUpdated(pending.userId, {
      threadRevision: pending.revision,
    });
  }

  /** Record a thread DELETE: bump threadRevision, upsert the DELETE row, mark the ADD row soft-deleted,
   *  push signal. */
  async recordThreadDelete(userId: number, threadId: number): Promise<void> {
    const revision = await this.database.db.transaction((tx) =>
      this.recordThreadDeleteInTx(tx, userId, threadId),
    );
    this.notifyThreadRevision({ userId, revision });
  }

  async recordThreadDeleteInTx(
    tx: DatabaseTransaction,
    userId: number,
    threadId: number,
  ): Promise<number> {
    const [u] = await tx
      .update(user)
      .set({
        threadRevision: sql`${user.threadRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId))
      .returning({ threadRevision: user.threadRevision });
    await tx
      .insert(threadRevision)
      .values({
        userId,
        threadId,
        direction: 'DELETE',
        revision: u.threadRevision,
      })
      .onConflictDoUpdate({
        target: [
          threadRevision.userId,
          threadRevision.threadId,
          threadRevision.direction,
        ],
        set: { revision: u.threadRevision },
      });
    await tx
      .update(threadRevision)
      .set({ isDelete: true })
      .where(
        and(
          eq(threadRevision.userId, userId),
          eq(threadRevision.threadId, threadId),
          eq(threadRevision.direction, 'ADD'),
        ),
      );
    return u.threadRevision;
  }

  async isThreadHiddenInTx(
    tx: Database | DatabaseTransaction,
    userId: number,
    threadId: number,
  ): Promise<boolean> {
    const [add] = await tx
      .select({ isDelete: threadRevision.isDelete })
      .from(threadRevision)
      .where(
        and(
          eq(threadRevision.userId, userId),
          eq(threadRevision.threadId, threadId),
          eq(threadRevision.direction, 'ADD'),
        ),
      )
      .limit(1);
    return add?.isDelete === true;
  }

  async isThreadHidden(userId: number, threadId: number): Promise<boolean> {
    return this.isThreadHiddenInTx(this.database.db, userId, threadId);
  }

  /** Re-add only participants whose current list state is DELETE. This makes a fresh message restore an
   * active chat without bumping every recipient's thread revision for every ordinary message. */
  async restoreHiddenThreads(
    threadId: number,
    activeUserIds: number[],
  ): Promise<void> {
    if (activeUserIds.length === 0) return;
    const pending = await this.database.db.transaction((tx) =>
      this.restoreHiddenThreadsInTx(tx, threadId, activeUserIds),
    );
    pending.forEach((revision) => this.notifyThreadRevision(revision));
  }

  async restoreHiddenThreadsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    activeUserIds: number[],
  ): Promise<PendingThreadRevision[]> {
    if (activeUserIds.length === 0) return [];
    const hidden = await tx
      .select({ userId: threadRevision.userId })
      .from(threadRevision)
      .where(
        and(
          eq(threadRevision.threadId, threadId),
          inArray(threadRevision.userId, activeUserIds),
          eq(threadRevision.direction, 'ADD'),
          eq(threadRevision.isDelete, true),
        ),
      );
    const pending: PendingThreadRevision[] = [];
    for (const row of hidden) {
      pending.push({
        userId: row.userId,
        revision: await this.recordThreadAddInTx(tx, row.userId, threadId),
      });
    }
    return pending;
  }

  /** Pull ADD/DELETE deltas in (fromRevision, toRevision] (from exclusive, to inclusive). The client
   *  applies them in revision order to sync its local thread list. */
  async queryDelta(
    userId: number,
    fromRevision: number,
    toRevision: number,
  ): Promise<
    { threadId: number; direction: 'ADD' | 'DELETE'; revision: number }[]
  > {
    return this.database.db
      .select({
        threadId: threadRevision.threadId,
        direction: threadRevision.direction,
        revision: threadRevision.revision,
      })
      .from(threadRevision)
      .where(
        and(
          eq(threadRevision.userId, userId),
          gt(threadRevision.revision, fromRevision),
          lte(threadRevision.revision, toRevision),
        ),
      )
      .orderBy(asc(threadRevision.revision));
  }
}
