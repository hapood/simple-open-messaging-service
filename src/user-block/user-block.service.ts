import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';

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
  constructor(private prisma: PrismaService) {}

  /** Block a user. Idempotent: re-blocking an already-blocked user is a no-op (upsert). */
  block(blockerId: number, blockedId: number) {
    return this.prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {},
    });
  }

  /** Unblock a user. Idempotent: unblocking someone not blocked is a no-op (deleteMany never throws). */
  unblock(blockerId: number, blockedId: number) {
    return this.prisma.userBlock.deleteMany({
      where: { blockerId, blockedId },
    });
  }

  /** Users whom `blockerId` has blocked. Hides their messages in query-messages (the blocker's view). */
  async blockedByMe(blockerId: number): Promise<Set<number>> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId },
      select: { blockedId: true },
    });
    return new Set(rows.map((r) => r.blockedId));
  }

  /** Of `targetIds`, the subset that `blockerId` has blocked — batched lookup for hydrating a list of
   *  P2P conversations with each peer's blocked flag in one query. */
  async blockedAmong(blockerId: number, targetIds: number[]): Promise<Set<number>> {
    if (targetIds.length === 0) return new Set();
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId, blockedId: { in: targetIds } },
      select: { blockedId: true },
    });
    return new Set(rows.map((r) => r.blockedId));
  }

  /** Users who have blocked `userId`. Used by send-message fan-out to drop those recipients — they
   *  must not receive the sender's messages. */
  async blockersOf(userId: number): Promise<Set<number>> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockedId: userId },
      select: { blockerId: true },
    });
    return new Set(rows.map((r) => r.blockerId));
  }

  /** True iff `blockerId` currently blocks `blockedId`. */
  async isBlocked(blockerId: number, blockedId: number): Promise<boolean> {
    const row = await this.prisma.userBlock.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      select: { id: true },
    });
    return row !== null;
  }
}
