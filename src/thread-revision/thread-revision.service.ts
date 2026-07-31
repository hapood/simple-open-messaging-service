import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { SseService } from '../gateway/sse.service.js';

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
    private readonly prisma: PrismaService,
    private readonly sse: SseService,
  ) {}

  /** Record a thread ADD: bump threadRevision, upsert the ADD row (reactivate on re-add), push signal. */
  async recordThreadAdd(userId: number, threadId: number): Promise<void> {
    const revision = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { threadRevision: { increment: 1 } },
        select: { threadRevision: true },
      });
      await tx.threadRevision.upsert({
        where: {
          userId_threadId_direction: { userId, threadId, direction: 'ADD' },
        },
        create: {
          userId,
          threadId,
          direction: 'ADD',
          revision: u.threadRevision,
          isDelete: false,
        },
        update: { revision: u.threadRevision, isDelete: false },
      });
      return u.threadRevision;
    });
    this.sse.onThreadRevisionUpdated(userId, {
      threadRevision: revision,
    });
  }

  /** Record a thread DELETE: bump threadRevision, upsert the DELETE row, mark the ADD row soft-deleted,
   *  push signal. */
  async recordThreadDelete(userId: number, threadId: number): Promise<void> {
    const revision = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { threadRevision: { increment: 1 } },
        select: { threadRevision: true },
      });
      await tx.threadRevision.upsert({
        where: {
          userId_threadId_direction: { userId, threadId, direction: 'DELETE' },
        },
        create: {
          userId,
          threadId,
          direction: 'DELETE',
          revision: u.threadRevision,
        },
        update: { revision: u.threadRevision },
      });
      await tx.threadRevision.updateMany({
        where: { userId, threadId, direction: 'ADD' },
        data: { isDelete: true },
      });
      return u.threadRevision;
    });
    this.sse.onThreadRevisionUpdated(userId, {
      threadRevision: revision,
    });
  }

  async isThreadHidden(userId: number, threadId: number): Promise<boolean> {
    const add = await this.prisma.threadRevision.findUnique({
      where: {
        userId_threadId_direction: { userId, threadId, direction: 'ADD' },
      },
      select: { isDelete: true },
    });
    return add?.isDelete === true;
  }

  /** Re-add only participants whose current list state is DELETE. This makes a fresh message restore an
   * active chat without bumping every recipient's thread revision for every ordinary message. */
  async restoreHiddenThreads(
    threadId: number,
    activeUserIds: number[],
  ): Promise<void> {
    if (activeUserIds.length === 0) return;
    const hidden = await this.prisma.threadRevision.findMany({
      where: {
        threadId,
        userId: { in: activeUserIds },
        direction: 'ADD',
        isDelete: true,
      },
      select: { userId: true },
    });
    await Promise.all(
      hidden.map((row) => this.recordThreadAdd(row.userId, threadId)),
    );
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
    const rows = await this.prisma.threadRevision.findMany({
      where: { userId, revision: { gt: fromRevision, lte: toRevision } },
      orderBy: { revision: 'asc' },
      select: { threadId: true, direction: true, revision: true },
    });
    return rows as {
      threadId: number;
      direction: 'ADD' | 'DELETE';
      revision: number;
    }[];
  }
}
