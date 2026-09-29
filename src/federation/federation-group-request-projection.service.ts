import type { RequestProjectionStatusValue } from '../../shared/request-projection-status.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';

type GroupRequestStatus = RequestProjectionStatusValue;
type GroupRequestDirection = 'APPLICATION' | 'INVITATION';

/** Maintains the shared request projection derived from group relationship intents. */
@Injectable()
export class FederationGroupRequestProjectionService {
  constructor(private readonly clientStateFeed: ClientStateFeedService) {}

  /** Records the one shared projection row for a request decision. Manager
   * enumeration and notification belong to the projection fan-out task; this
   * only advances group-level state. */
  async writeEffectsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: AccountTarget,
    status: GroupRequestStatus = 'REQUESTED',
    direction: GroupRequestDirection = 'APPLICATION',
    createIfMissing = true,
  ): Promise<void> {
    const member = await accountAddressInTx(tx, memberUserId);
    const [request] = await tx
      .select({
        status: tables.relationshipIntent.status,
        note: tables.relationshipIntent.note,
        requestedAt: tables.relationshipIntent.requestedAt,
        expiresAt: tables.relationshipIntent.expiresAt,
      })
      .from(tables.relationshipIntent)
      .innerJoin(tables.messageThread, eq(tables.messageThread.id, threadId))
      .where(
        direction === 'APPLICATION'
          ? and(
              eq(tables.relationshipIntent.authorAccount, member.account),
              eq(
                tables.relationshipIntent.authorNamespaceId,
                member.namespaceId,
              ),
              eq(
                tables.relationshipIntent.receiverAccount,
                tables.messageThread.groupAccount,
              ),
              eq(tables.relationshipIntent.receiverNamespaceId, 0),
            )
          : and(
              eq(
                tables.relationshipIntent.authorAccount,
                tables.messageThread.groupAccount,
              ),
              eq(tables.relationshipIntent.authorNamespaceId, 0),
              eq(tables.relationshipIntent.receiverAccount, member.account),
              eq(
                tables.relationshipIntent.receiverNamespaceId,
                member.namespaceId,
              ),
            ),
      )
      .limit(1);
    const [memberIntent] = await tx
      .select({ profileRev: tables.relationshipIntent.profileRev })
      .from(tables.relationshipIntent)
      .innerJoin(tables.messageThread, eq(tables.messageThread.id, threadId))
      .where(
        and(
          eq(tables.relationshipIntent.authorAccount, member.account),
          eq(tables.relationshipIntent.authorNamespaceId, member.namespaceId),
          eq(
            tables.relationshipIntent.receiverAccount,
            tables.messageThread.groupAccount,
          ),
          eq(tables.relationshipIntent.receiverNamespaceId, 0),
        ),
      )
      .limit(1);
    if (!request || !member) return;
    if (!createIfMissing) {
      const [existing] = await tx
        .select({ threadId: tables.groupRequestProjection.threadId })
        .from(tables.groupRequestProjection)
        .where(
          and(
            eq(tables.groupRequestProjection.threadId, threadId),
            eq(tables.groupRequestProjection.memberAccount, member.account),
            eq(tables.groupRequestProjection.memberDomain, member.domain),
            eq(
              tables.groupRequestProjection.memberNamespaceId,
              member.namespaceId,
            ),
            eq(tables.groupRequestProjection.direction, direction),
          ),
        )
        .limit(1);
      if (!existing) return;
    }
    await this.clientStateFeed.writeGroupRequestInTx(tx, {
      threadId,
      memberAccount: member.account,
      memberDomain: member.domain,
      memberNamespaceId: member.namespaceId,
      memberProfileRev: memberIntent?.profileRev ?? 0,
      direction,
      status,
      note: request.note,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
    });
  }
}
