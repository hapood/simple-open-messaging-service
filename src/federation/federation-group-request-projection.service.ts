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
      .from(tables.relationshipPair)
      .innerJoin(
        tables.relationshipIntent,
        eq(tables.relationshipIntent.pairId, tables.relationshipPair.id),
      )
      .where(
        and(
          eq(tables.relationshipPair.threadId, threadId),
          eq(tables.relationshipPair.kind, 'GROUP_MEMBER'),
          eq(tables.relationshipPair.endpointBType, 'USER'),
          eq(tables.relationshipPair.endpointBAccount, member.account),
          eq(tables.relationshipPair.endpointBDomain, member.domain),
          eq(
            tables.relationshipIntent.authorSide,
            direction === 'APPLICATION' ? 'B' : 'A',
          ),
        ),
      )
      .limit(1);
    const [memberIntent] = await tx
      .select({ profileRev: tables.relationshipIntent.profileRev })
      .from(tables.relationshipIntent)
      .innerJoin(
        tables.relationshipPair,
        eq(tables.relationshipIntent.pairId, tables.relationshipPair.id),
      )
      .where(
        and(
          eq(tables.relationshipPair.threadId, threadId),
          eq(tables.relationshipPair.kind, 'GROUP_MEMBER'),
          eq(tables.relationshipPair.endpointBAccount, member.account),
          eq(tables.relationshipPair.endpointBDomain, member.domain),
          eq(tables.relationshipIntent.authorSide, 'B'),
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
