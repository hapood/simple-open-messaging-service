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
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: { threadRevision: { increment: 1 } },
      select: { threadRevision: true },
    });
    await this.prisma.threadRevision.upsert({
      where: { userId_threadId_direction: { userId, threadId, direction: 'ADD' } },
      create: { userId, threadId, direction: 'ADD', revision: u.threadRevision, isDelete: false },
      update: { revision: u.threadRevision, isDelete: false },
    });
    this.sse.onThreadRevisionUpdated(userId, { revision: u.threadRevision });
  }

  /** Record a thread DELETE: bump threadRevision, upsert the DELETE row, mark the ADD row soft-deleted,
   *  push signal. */
  async recordThreadDelete(userId: number, threadId: number): Promise<void> {
    const u = await this.prisma.user.update({
      where: { id: userId },
      data: { threadRevision: { increment: 1 } },
      select: { threadRevision: true },
    });
    await this.prisma.threadRevision.upsert({
      where: { userId_threadId_direction: { userId, threadId, direction: 'DELETE' } },
      create: { userId, threadId, direction: 'DELETE', revision: u.threadRevision },
      update: { revision: u.threadRevision },
    });
    await this.prisma.threadRevision.updateMany({
      where: { userId, threadId, direction: 'ADD' },
      data: { isDelete: true },
    });
    this.sse.onThreadRevisionUpdated(userId, { revision: u.threadRevision });
  }

  /** Pull ADD/DELETE deltas in (fromRevision, toRevision] (from exclusive, to inclusive). The client
   *  applies them in revision order to sync its local thread list. */
  async queryDelta(
    userId: number,
    fromRevision: number,
    toRevision: number,
  ): Promise<{ threadId: number; direction: 'ADD' | 'DELETE'; revision: number }[]> {
    const rows = await this.prisma.threadRevision.findMany({
      where: { userId, revision: { gt: fromRevision, lte: toRevision } },
      orderBy: { revision: 'asc' },
      select: { threadId: true, direction: true, revision: true },
    });
    return rows as { threadId: number; direction: 'ADD' | 'DELETE'; revision: number }[];
  }

  /** The set of threadIds active (added, not since-deleted) at revision R for this user — the
   *  historically-accurate snapshot used to pin `query-thread/valid` pagination. Uses the operation-log
   *  revision columns, NOT the `isDelete` flag (that is a current-state fast-flag; snapshot(R) must reflect
   *  state as-of R). A thread is active at R iff its latest operation with revision ≤ R is an ADD — which
   *  correctly handles re-add (ADD upserted past a prior DELETE ⇒ ADD.revision > DELETE.revision ⇒ the ADD
   *  is the latest ⇒ active). The accepted tradeoff (per the upsert model) is that the window between an
   *  original ADD and its DELETE, when a later re-add overwrote the ADD row's revision, is inaccurate. */
  async activeThreadIdsAt(userId: number, revision: number): Promise<Set<number>> {
    const rows = await this.prisma.threadRevision.findMany({
      where: { userId, revision: { lte: revision } },
      select: { threadId: true, direction: true, revision: true },
    });
    // Latest operation per threadId (max revision ≤ R). With @@unique([userId, threadId, direction])
    // there is at most one ADD + one DELETE per thread, so this is a small per-user set.
    const latest = new Map<number, { dir: 'ADD' | 'DELETE'; rev: number }>();
    for (const r of rows) {
      const cur = latest.get(r.threadId);
      if (!cur || r.revision > cur.rev) {
        latest.set(r.threadId, { dir: r.direction, rev: r.revision });
      }
    }
    const active = new Set<number>();
    for (const [threadId, v] of latest) if (v.dir === 'ADD') active.add(threadId);
    return active;
  }
}
