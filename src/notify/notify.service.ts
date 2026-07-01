import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { Prisma, NotifyType } from '../prisma/generated/client.js';

/**
 * Notification service.
 *
 * Responsibilities:
 *  - recordFriendRequest: append a Notify row + arm the recipient's
 *    `userNotiBox.hasUrFriendReq` badge, ATOMICALLY inside the caller's
 *    transaction (takes the tx client as a parameter).
 *  - markFriendReqRead: clear the badge once the user has opened the
 *    friend-requests dialog (Notify rows are kept as append-only history).
 *
 * Display info (sender name/avatar) is resolved client-side — only the minimal
 * `{ fromUserId }` is stored in `Notify.content`, matching how the friend-request
 * list already resolves user ids to full profiles.
 */
@Injectable()
export class NotifyService {
  constructor(private prisma: PrismaService) {}

  /**
   * Record a friend-request notification for `toUserId` within the caller's
   * transaction. Appends a Notify row and arms the badge via a nested to-one
   * update (no separate notiBox-id fetch). Errors propagate so the surrounding
   * `$transaction` rolls back — defense-in-depth; the caller pre-validates the
   * recipient exists, so a P2025 here is a genuine inconsistency, not a flow.
   */
  async recordFriendRequest(
    tx: Prisma.TransactionClient,
    fromUserId: number,
    toUserId: number,
  ): Promise<void> {
    await tx.notify.create({
      data: {
        userId: toUserId,
        type: NotifyType.FRIEND_REQUEST,
        content: { fromUserId },
      },
    });
    await tx.user.update({
      where: { id: toUserId },
      data: { userNotiBox: { update: { hasUrFriendReq: true } } },
    });
  }

  /**
   * Clear the friend-request unread badge for the given user. The Notify rows
   * themselves are preserved (audit/history for a future notification list UI).
   */
  async markFriendReqRead(userId: number): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { userNotiBox: { update: { hasUrFriendReq: false } } },
    });
  }
}
