import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import {
  FriendshipStatus,
  MessageThreadType,
  Prisma,
} from '../prisma/generated/client.js';
import { NotifyService } from '../notify/notify.service.js';

/** Normalize an unordered user pair so userAId < userBId (the Friendship unique key). */
function pair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

/**
 * P2P relationship / friend-request state machine.
 *
 * Extracted from MessageService and reimplemented on the Friendship model: exactly ONE row per unordered
 * user pair (userAId < userBId), with direction carried by requesterId. This replaces the old two-half-edge
 * UserMessageThread rows and removes the lockstep-sync hazard (and the documented status-4 param-order bug).
 *
 * Status codes returned to controllers (preserved from the legacy API for stable user-facing messages):
 *  makeFriendRequest → 0 first request / 1 already friends / 2 deleted→reset / 3 mutual→auto-approved
 *                      / 4 unreachable / 5 already pending or blocked
 *  approve/decline/cancel → 0 ok / 1 no matching pending request
 */
@Injectable()
export class FriendshipService {
  constructor(
    private prisma: PrismaService,
    private readonly notifyService: NotifyService,
  ) {}

  findFriendship(userX: number, userY: number) {
    const [a, b] = pair(userX, userY);
    return this.prisma.friendship.findUnique({
      where: { userAId_userBId: { userAId: a, userBId: b } },
    });
  }

  /** Generic list query (used by the pending friend-request endpoints). */
  queryFriendships(params: Prisma.FriendshipFindManyArgs) {
    return this.prisma.friendship.findMany(params);
  }

  /** Whether two users are friends, plus the relationship row (for the P2P thread id). */
  async getFriendship(userX: number, userY: number) {
    const friendship = await this.findFriendship(userX, userY);
    return {
      friendship,
      isFriend: friendship?.status === FriendshipStatus.APPROVED,
    };
  }

  async makeFriendRequest(fromUserId: number, toUserId: number, message = '') {
    const reqMessage = (message ?? '').slice(0, 255); // Friendship.reqMessage is VARCHAR(255)
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.findFriendshipInTx(tx, fromUserId, toUserId);
      if (existing === null) {
        const [a, b] = pair(fromUserId, toUserId);
        await tx.friendship.create({
          data: {
            userAId: a,
            userBId: b,
            requesterId: fromUserId,
            status: FriendshipStatus.PENDING,
            reqMessage,
          },
        });
        await this.notifyService.recordFriendRequest(tx, fromUserId, toUserId);
        return { status: 0 }; // first request
      }
      switch (existing.status) {
        case FriendshipStatus.APPROVED:
          return { status: 1 }; // already friends
        case FriendshipStatus.DELETED:
          // re-arm as a fresh request from fromUserId
          await tx.friendship.update({
            where: { id: existing.id },
            data: { status: FriendshipStatus.PENDING, requesterId: fromUserId, reqMessage },
          });
          await this.notifyService.recordFriendRequest(
            tx,
            fromUserId,
            toUserId,
          );
          return { status: 2 }; // deleted → reset
        case FriendshipStatus.PENDING:
          if (existing.requesterId === toUserId) {
            // toUserId had already requested fromUserId → mutual, auto-approve
            await this.approveInTx(tx, existing);
            return { status: 3 };
          }
          return { status: 5 }; // already pending (my own) — idempotent
        case FriendshipStatus.BLOCKED:
          // Do not reveal the blocked state; treat as "request sent".
          return { status: 5 };
      }
    });
  }

  async approveFriendRequest(
    requesterId: number,
    approverId: number,
    /**
     * Federation: when the APPROVED thread is a federated 1:1 whose origin is THIS server, pass
     * { origin, federatedId } so approveInTx stamps them on the created MessageThread. Omitted for
     * purely-local approvals (origin defaults to "local", federatedId null).
     */
    threadMeta?: { origin: string; federatedId: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const f = await this.findFriendshipInTx(tx, requesterId, approverId);
      if (
        f !== null &&
        f.status === FriendshipStatus.PENDING &&
        f.requesterId === requesterId
      ) {
        await this.approveInTx(tx, f, threadMeta);
        return { status: 0 };
      }
      return { status: 1 };
    });
  }

  async declineFriendRequest(requesterId: number, declinerId: number) {
    return this.prisma.$transaction(async (tx) => {
      const f = await this.findFriendshipInTx(tx, requesterId, declinerId);
      if (
        f !== null &&
        f.status === FriendshipStatus.PENDING &&
        f.requesterId === requesterId
      ) {
        await tx.friendship.update({
          where: { id: f.id },
          data: { status: FriendshipStatus.DELETED },
        });
        return { status: 0 };
      }
      return { status: 1 };
    });
  }

  /** Cancel my own outgoing pending request. */
  async cancelFriendRequest(fromUserId: number, toUserId: number) {
    return this.prisma.$transaction(async (tx) => {
      const f = await this.findFriendshipInTx(tx, fromUserId, toUserId);
      if (
        f !== null &&
        f.status === FriendshipStatus.PENDING &&
        f.requesterId === fromUserId
      ) {
        await tx.friendship.update({
          where: { id: f.id },
          data: { status: FriendshipStatus.DELETED },
        });
        return { status: 0 };
      }
      return { status: 1 };
    });
  }

  /**
   * End an APPROVED friendship (unfriend) — the P2P counterpart of group/leave. Sets status DELETED
   * and soft-leaves BOTH participants of the P2P thread in one transaction, so the conversation
   * disappears from both users' lists and neither can send to it. Without this, an APPROVED
   * friendship+thread could never be ended: DELETED was only reachable from PENDING (decline/cancel).
   *
   * Mutual by construction (Friendship is one shared row), mirroring the shared-row data model the
   * way group/leave mirrors the per-user ThreadParticipant model. Re-friending later creates a fresh
   * thread (approveInTx), so the orphaned old thread — both sides leftAt — is harmless.
   *
   * Returns 'ok' + the thread id (so the controller can address the peer SSE) or 'not-friends' when
   * there is no APPROVED relationship to end (idempotent — unfriending twice is a no-op).
   */
  async deleteFriendship(
    userX: number,
    userY: number,
  ): Promise<{ status: 'ok' | 'not-friends'; threadId: number | null }> {
    return this.prisma.$transaction(async (tx) => {
      const f = await this.findFriendshipInTx(tx, userX, userY);
      if (
        f === null ||
        f.status !== FriendshipStatus.APPROVED ||
        f.threadId === null
      ) {
        return { status: 'not-friends', threadId: f?.threadId ?? null };
      }
      // Soft-leave both sides atomically with the status flip; updateMany (not update) so a missing
      // row on one side — a invariant violation, not a normal state — cannot poison the transaction.
      await tx.threadParticipant.updateMany({
        where: { threadId: f.threadId, leftAt: null },
        data: { leftAt: new Date() },
      });
      await tx.friendship.update({
        where: { id: f.id },
        data: { status: FriendshipStatus.DELETED, threadId: null },
      });
      return { status: 'ok', threadId: f.threadId };
    });
  }

  /**
   * Create this server's LOCAL reference to a federated 1:1 thread (this server is the REMOTE
   * participant; the origin server owns the thread identity + sequence). Called by the InboxHandler
   * on an inbound `thread.invite`: the Friendship is already APPROVED on this side (from the inbound
   * friend.approve on the origin), but had no local thread yet. Creates the MessageThread
   * {origin, federatedId} + both ThreadParticipants + links Friendship.threadId.
   *
   * Idempotent on federatedId: a redelivered thread.invite finds the existing thread and no-ops
   * (at-least-once delivery + the federatedId @unique constraint).
   */
  async attachRemoteThread(
    userX: number,
    userY: number,
    origin: string,
    federatedId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.messageThread.findUnique({ where: { federatedId } });
      if (existing) return; // already attached (redelivered invite)
      const f = await this.findFriendshipInTx(tx, userX, userY);
      if (!f || f.status !== FriendshipStatus.APPROVED) return; // no approved edge to attach to
      const thread = await tx.messageThread.create({
        data: { type: MessageThreadType.P2P, origin, federatedId },
      });
      await tx.threadParticipant.createMany({
        data: [
          { userId: f.userAId, threadId: thread.id },
          { userId: f.userBId, threadId: thread.id },
        ],
      });
      await tx.friendship.update({ where: { id: f.id }, data: { threadId: thread.id } });
    });
  }

  private findFriendshipInTx(
    tx: Prisma.TransactionClient,
    userX: number,
    userY: number,
  ) {
    const [a, b] = pair(userX, userY);
    return tx.friendship.findUnique({
      where: { userAId_userBId: { userAId: a, userBId: b } },
    });
  }

  /**
   * Approve a pending friendship atomically: create the P2P MessageThread + both ThreadParticipant rows,
   * then set status APPROVED with the thread id. Runs on the caller's transaction (used by both the public
   * approve endpoint and the mutual-auto-approve path inside makeFriendRequest). threadMeta stamps the
   * federation origin/federatedId on the thread when this server is the origin of a federated 1:1.
   */
  private async approveInTx(
    tx: Prisma.TransactionClient,
    f: { id: number; userAId: number; userBId: number },
    threadMeta?: { origin: string; federatedId: string },
  ) {
    const thread = await tx.messageThread.create({
      data: {
        type: MessageThreadType.P2P,
        ...(threadMeta ? { origin: threadMeta.origin, federatedId: threadMeta.federatedId } : {}),
      },
    });
    await tx.threadParticipant.createMany({
      data: [
        { userId: f.userAId, threadId: thread.id },
        { userId: f.userBId, threadId: thread.id },
      ],
    });
    await tx.friendship.update({
      where: { id: f.id },
      data: { status: FriendshipStatus.APPROVED, threadId: thread.id },
    });
  }
}
