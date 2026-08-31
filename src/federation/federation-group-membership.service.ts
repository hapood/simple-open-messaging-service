import { Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import {
  account,
  threadMember,
  threadParticipant,
} from '../database/schema.js';

/** Materializes independent projections derived from a folded group relationship. Hosted groups
 * own their roster ThreadMember; every local Account owns its ThreadParticipant immediately. */
@Injectable()
export class FederationGroupMembershipService {
  async syncFromActiveInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      memberUserId: number;
      active: boolean;
      hostedLocally: boolean;
      allowOwnerDeactivation?: boolean;
    },
  ): Promise<void> {
    const localAccount = await tx.query.account.findFirst({
      where: eq(account.id, params.memberUserId),
      columns: { id: true },
    });
    let localRole: GroupRole = GroupRole.MEMBER;
    if (params.active) {
      if (params.hostedLocally) {
        const [membership] = await tx
          .insert(threadMember)
          .values({
            threadId: params.threadId,
            userId: params.memberUserId,
            role: GroupRole.MEMBER,
            left: false,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [threadMember.threadId, threadMember.userId],
            set: {
              role: sql`CASE WHEN ${threadMember.left}
                        THEN 'MEMBER'::"GroupRole"
                        ELSE ${threadMember.role} END`,
              joinedAt: sql`CASE WHEN ${threadMember.left}
                            THEN CURRENT_TIMESTAMP
                            ELSE ${threadMember.joinedAt} END`,
              left: false,
              updatedAt: new Date(),
            },
          })
          .returning({ role: threadMember.role });
        if (!membership)
          throw new Error('active group membership upsert disappeared');
        localRole = membership.role ?? GroupRole.MEMBER;
      }
      if (localAccount)
        await tx
          .insert(threadParticipant)
          .values({
            accountId: localAccount.id,
            threadId: params.threadId,
            role: localRole,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [threadParticipant.accountId, threadParticipant.threadId],
            set: {
              role: localRole,
              messageVisibleBeforeSeq: null,
              updatedAt: new Date(),
            },
          });
      return;
    }

    if (!params.hostedLocally) return;
    await tx
      .update(threadMember)
      .set({ left: true, updatedAt: new Date() })
      .where(
        params.allowOwnerDeactivation
          ? and(
              eq(threadMember.threadId, params.threadId),
              eq(threadMember.userId, params.memberUserId),
            )
          : and(
              eq(threadMember.threadId, params.threadId),
              eq(threadMember.userId, params.memberUserId),
              ne(threadMember.role, GroupRole.OWNER),
            ),
      );
  }
}
