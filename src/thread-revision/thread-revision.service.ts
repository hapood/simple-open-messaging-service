import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type Database,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  memberProfileStateRevision,
  profileStateRevision,
  threadParticipant,
  threadRevision,
  user,
} from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';

export interface PendingThreadRevision {
  userId: number;
  revision: number;
}

/**
 * Per-user thread-list versioning. Every thread add/delete (friend approve, group join, unfriend,
 * leave, kick) bumps User.threadRevision and writes a ThreadRevision log row (ADD or DELETE); the
 * client holds stateRevision as its cursor and pulls unified deltas via query-state(from, to].
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

  /**
   * Record a durable hydrated-thread refresh for every active local participant
   * whose conversation is currently visible. A hidden thread stays hidden; a
   * genuine join/message path must explicitly record ADD to restore it.
   * Reusing ADD is intentional: an ADD delta is a replacement snapshot, not merely
   * a first-time insertion. This keeps group metadata/roster/role changes in the
   * same replayable client-state log without a parallel GROUP_* SSE channel.
   */
  async recordActiveLocalThreadRefreshInTx(
    tx: DatabaseTransaction,
    threadId: number,
    excludeUserIds: readonly number[] = [],
  ): Promise<PendingThreadRevision[]> {
    const rows = await tx
      .select({ userId: user.id })
      .from(threadParticipant)
      .innerJoin(user, eq(user.id, threadParticipant.userId))
      .innerJoin(
        threadRevision,
        and(
          eq(threadRevision.userId, threadParticipant.userId),
          eq(threadRevision.threadId, threadParticipant.threadId),
          eq(threadRevision.direction, 'ADD'),
          eq(threadRevision.isDelete, false),
        ),
      )
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          isNull(threadParticipant.leftAt),
          eq(user.isForeigner, false),
          eq(user.isDeleted, false),
        ),
      );
    const excluded = new Set(excludeUserIds);
    const pending: PendingThreadRevision[] = [];
    for (const userId of [...new Set(rows.map((row) => row.userId))]
      .filter((id) => !excluded.has(id))
      .sort((a, b) => a - b)) {
      pending.push({
        userId,
        revision: await this.recordThreadAddInTx(tx, userId, threadId),
      });
    }
    return pending;
  }

  notifyThreadRevision(pending: PendingThreadRevision): void {
    this.sse.onThreadRevisionUpdated(pending.userId, {
      threadRevision: pending.revision,
    });
  }

  async recordProfileStateInTx(
    tx: DatabaseTransaction,
    subjectUserId: number,
    consumerUserIds: readonly number[],
  ): Promise<PendingThreadRevision[]> {
    const pending: PendingThreadRevision[] = [];
    for (const userId of [...new Set(consumerUserIds)].sort((a, b) => a - b)) {
      const [owner] = await tx
        .update(user)
        .set({
          threadRevision: sql`${user.threadRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(user.id, userId))
        .returning({ revision: user.threadRevision });
      if (!owner) continue;
      await tx
        .insert(profileStateRevision)
        .values({ userId, subjectUserId, revision: owner.revision })
        .onConflictDoUpdate({
          target: [
            profileStateRevision.userId,
            profileStateRevision.subjectUserId,
          ],
          set: { revision: owner.revision, createdAt: new Date() },
        });
      pending.push({ userId, revision: owner.revision });
    }
    return pending;
  }

  queryProfileDelta(userId: number, fromRevision: number, toRevision: number) {
    return this.database.db
      .select({
        subjectUserId: profileStateRevision.subjectUserId,
        revision: profileStateRevision.revision,
      })
      .from(profileStateRevision)
      .where(
        and(
          eq(profileStateRevision.userId, userId),
          gt(profileStateRevision.revision, fromRevision),
          lte(profileStateRevision.revision, toRevision),
        ),
      )
      .orderBy(asc(profileStateRevision.revision));
  }

  async recordMemberProfileStateInTx(
    tx: DatabaseTransaction,
    key: {
      sourcePeerDomain: string;
      memberAccount: string;
      memberDomain: string;
    },
    consumerUserIds: readonly number[],
  ): Promise<PendingThreadRevision[]> {
    const pending: PendingThreadRevision[] = [];
    for (const userId of [...new Set(consumerUserIds)].sort((a, b) => a - b)) {
      const [owner] = await tx
        .update(user)
        .set({
          threadRevision: sql`${user.threadRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(user.id, userId))
        .returning({ revision: user.threadRevision });
      if (!owner) continue;
      await tx
        .insert(memberProfileStateRevision)
        .values({ userId, ...key, revision: owner.revision })
        .onConflictDoUpdate({
          target: [
            memberProfileStateRevision.userId,
            memberProfileStateRevision.sourcePeerDomain,
            memberProfileStateRevision.memberAccount,
            memberProfileStateRevision.memberDomain,
          ],
          set: { revision: owner.revision },
        });
      pending.push({ userId, revision: owner.revision });
    }
    return pending;
  }

  async queryMemberProfileDelta(
    userId: number,
    fromRevision: number,
    toRevision: number,
  ) {
    const rows = await this.database.db
      .select({
        sourcePeerDomain: memberProfileStateRevision.sourcePeerDomain,
        memberAccount: memberProfileStateRevision.memberAccount,
        memberDomain: memberProfileStateRevision.memberDomain,
        revision: memberProfileStateRevision.revision,
      })
      .from(memberProfileStateRevision)
      .where(
        and(
          eq(memberProfileStateRevision.userId, userId),
          gt(memberProfileStateRevision.revision, fromRevision),
          lte(memberProfileStateRevision.revision, toRevision),
        ),
      )
      .orderBy(asc(memberProfileStateRevision.revision));
    return Promise.all(
      rows.map(async (row) => {
        const threads = await this.database.db.execute<{
          threadId: number;
        }>(sql`
          SELECT DISTINCT thread.id AS "threadId"
          FROM "MessageThread" thread
          JOIN "User" group_u ON group_u.id = thread."groupUserId"
            AND group_u.domain = ${row.sourcePeerDomain}
          JOIN "ThreadParticipant" mine ON mine."threadId" = thread.id
            AND mine."userId" = ${userId} AND mine."leftAt" IS NULL
          JOIN "ThreadParticipant" member_p ON member_p."threadId" = thread.id
            AND member_p."leftAt" IS NULL
          JOIN "User" member_u ON member_u.id = member_p."userId"
          WHERE member_u.account = ${row.memberAccount}
            AND (CASE WHEN member_u.domain = 'local'
                      THEN COALESCE((SELECT domain FROM "LocalFederationIdentity" LIMIT 1), 'local')
                      ELSE member_u.domain END) = ${row.memberDomain}
        `);
        return {
          ...row,
          threadIds: threads.rows.map((thread) => thread.threadId),
        };
      }),
    );
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
