import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { Prisma } from '../prisma/generated/client.js';

/**
 * ThreadParticipant data layer.
 *
 * ThreadParticipant is the single source of truth for "who is in a conversation" and their per-user
 * state (read position, mute, role). It replaces both the participation half of UserMessageThread and
 * the whole GroupMember table. P2P and GROUP share it; role is null for P2P.
 *
 * Authorization invariant used across the app: a user may interact with a conversation iff they have an
 * ACTIVE participant row (leftAt IS NULL) on that thread — one check for both P2P and GROUP.
 */
@Injectable()
export class ThreadParticipantService {
  constructor(private prisma: PrismaService) {}

  /** The caller's participant row, regardless of leftAt. */
  findParticipant(userId: number, threadId: number) {
    return this.prisma.threadParticipant.findUnique({
      where: { userId_threadId: { userId, threadId } },
    });
  }

  /** The caller's participant row only if still active (not left). Null otherwise. */
  async findActiveParticipant(userId: number, threadId: number) {
    const p = await this.findParticipant(userId, threadId);
    return p && p.leftAt === null ? p : null;
  }

  /** Active member userIds of a conversation — the SSE fan-out set (P2P and GROUP alike). */
  getActiveParticipantUserIds(threadId: number) {
    return this.prisma.threadParticipant.findMany({
      where: { threadId, leftAt: null },
      select: { userId: true },
    });
  }

  /**
   * Active roster of a conversation with each member's profile (login name + display name +
   * avatar) and role — the data behind group/members. Ordered by join time; the controller sorts
   * by role for display. P2P threads have exactly two rows with role null.
   */
  getRoster(threadId: number) {
    return this.prisma.threadParticipant.findMany({
      where: { threadId, leftAt: null },
      include: { user: { include: { userExtra: true } } },
      orderBy: { joinedAt: 'asc' },
    });
  }

  /**
   * Generic list query (used by the conversation-list endpoint). Generic over the args so that
   * `include`/`select` are reflected in the returned payload type — Prisma can't infer includes
   * passed through a plain `FindManyArgs`-typed variable.
   */
  queryParticipants<T extends Prisma.ThreadParticipantFindManyArgs>(
    params: T,
  ): Promise<Prisma.ThreadParticipantGetPayload<T>[]> {
    // Cast: findMany's generic return narrows to the default payload, but callers passing `include` need the included
    // fields typed (e.g. `thread`). GetPayload<T> models exactly that.
    return this.prisma.threadParticipant.findMany(params) as unknown as Promise<
      Prisma.ThreadParticipantGetPayload<T>[]
    >;
  }

  /**
   * For each P2P thread id, the OTHER active participant (the peer). Used to hydrate peerUser on the
   * conversation list. Returns at most one peer per thread (P2P threads have exactly two participants).
   */
  findP2PPeers(threadIds: number[], notUserId: number) {
    return this.prisma.threadParticipant.findMany({
      where: {
        threadId: { in: threadIds },
        leftAt: null,
        userId: { not: notUserId },
      },
    });
  }

  /** Add a member to a conversation (used by group create/join). */
  createParticipant(data: Prisma.ThreadParticipantCreateInput) {
    return this.prisma.threadParticipant.create({ data });
  }

  /**
   * Advance the caller's read watermark for a conversation, but only forward (monotonic): a stale
   * mark-read for an older message (e.g. an out-of-order retry, or marking read on an older message
   * after newer ones arrived) never regresses the cursor. Returns whether the cursor actually moved,
   * so the controller can tell "already read up to here" from a genuine update.
   */
  async advanceReadCursor(
    userId: number,
    threadId: number,
    lastReadMsgId: bigint,
  ): Promise<boolean> {
    const p = await this.findParticipant(userId, threadId);
    if (p === null) return false;
    if (p.lastReadMsgId !== null && p.lastReadMsgId >= lastReadMsgId) return false;
    await this.prisma.threadParticipant.update({
      where: { userId_threadId: { userId, threadId } },
      data: { lastReadMsgId },
    });
    return true;
  }
}
