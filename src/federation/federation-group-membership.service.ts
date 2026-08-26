import { Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import { threadParticipant } from '../database/schema.js';

/** Materializes the group-member projection from the relationship pair's folded active state. */
@Injectable()
export class FederationGroupMembershipService {
  async syncFromActiveInTx(
    tx: DatabaseTransaction,
    params: { threadId: number; memberUserId: number; active: boolean },
  ): Promise<void> {
    if (params.active) {
      await tx
        .insert(threadParticipant)
        .values({
          threadId: params.threadId,
          userId: params.memberUserId,
          role: GroupRole.MEMBER,
          relationshipRev: 1,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [threadParticipant.userId, threadParticipant.threadId],
        });
      return;
    }

    await tx
      .delete(threadParticipant)
      .where(
        and(
          eq(threadParticipant.threadId, params.threadId),
          eq(threadParticipant.userId, params.memberUserId),
          ne(threadParticipant.role, GroupRole.OWNER),
        ),
      );
  }
}
