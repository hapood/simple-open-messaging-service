import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import * as tables from '../database/schema.js';
import {
  readCurrentGroupMemberInTx,
  readCurrentLocalGroupManagersInTx,
} from '../group-meta/current-group-roster.js';
import { isThreadMutuallyAuthorized } from '../relationship/relationship-authorization.js';
import { loadFederationConfig } from './federation.config.js';

type GroupRequestStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
type GroupRequestDirection = 'APPLICATION' | 'INVITATION';

/** Maintains the manager-facing projection derived from group relationship intents. */
@Injectable()
export class FederationGroupRequestProjectionService {
  private readonly config = loadFederationConfig();

  constructor(private readonly clientStateFeed: ClientStateFeedService) {}

  async writeEffectsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    groupId: number,
    memberUserId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
    status: GroupRequestStatus = 'REQUESTED',
    direction: GroupRequestDirection = 'APPLICATION',
    createIfMissing = true,
    managerUserId?: number,
  ): Promise<void> {
    if (!clientFeedUpdates) return;
    const groupIdentity = await tx.query.group.findFirst({
      where: eq(tables.group.id, groupId),
      columns: { account: true, domain: true },
    });
    const [request] = await tx
      .select({
        id: tables.relationshipIntent.id,
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
      .innerJoin(tables.user, eq(tables.user.id, memberUserId))
      .where(
        and(
          eq(tables.relationshipPair.threadId, threadId),
          eq(tables.relationshipPair.kind, 'GROUP_MEMBER'),
          eq(tables.relationshipPair.endpointBType, 'USER'),
          eq(tables.relationshipPair.endpointBAccount, tables.user.account),
          eq(tables.relationshipPair.endpointBDomain, tables.user.domain),
          eq(
            tables.relationshipIntent.authorSide,
            direction === 'APPLICATION' ? 'B' : 'A',
          ),
        ),
      )
      .limit(1);
    const member = await tx.query.user.findFirst({
      where: eq(tables.user.id, memberUserId),
      columns: {
        id: true,
        account: true,
        domain: true,
        name: true,
        avatar: true,
        bio: true,
        defaultProfileRev: true,
      },
    });
    const managers = await readCurrentLocalGroupManagersInTx(tx, {
      groupId,
      threadId,
      managerUserId,
    });
    if (!groupIdentity || !request || !member) return;
    const existingManagers = createIfMissing
      ? new Set<number>()
      : new Set(
          (
            await tx
              .select({
                managerUserId: tables.groupRequestProjection.managerUserId,
              })
              .from(tables.groupRequestProjection)
              .where(
                and(
                  eq(tables.groupRequestProjection.threadId, threadId),
                  eq(tables.groupRequestProjection.memberUserId, memberUserId),
                  eq(tables.groupRequestProjection.direction, direction),
                ),
              )
          ).map((row) => row.managerUserId),
        );
    for (const manager of managers) {
      if (manager.userId === memberUserId) continue;
      if (!createIfMissing && !existingManagers.has(manager.userId)) continue;
      const feedId = await this.clientStateFeed.writeGroupRequestInTx(tx, {
        managerUserId: manager.userId,
        threadId,
        memberUserId: member.id,
        direction,
        requestId: request.id,
        status,
        note: request.note,
        requestedAt: request.requestedAt,
        expiresAt: request.expiresAt,
      });
      if (feedId === null) continue;
      clientFeedUpdates.push({ userId: manager.userId, feedId });
      clientFeedUpdates.push(
        ...(await this.clientStateFeed.recordProfileStateInTx(tx, member.id, [
          manager.userId,
        ])),
      );
      const headFeedId =
        await this.clientStateFeed.writeGroupJoinRequestHeadInTx(tx, {
          userId: manager.userId,
          account: groupIdentity.account,
          domain: this.config.domain,
          threadId,
          latestFeedId: feedId,
          latestRequestAt: request.requestedAt?.getTime() ?? Date.now(),
        });
      if (headFeedId !== null)
        clientFeedUpdates.push({ userId: manager.userId, feedId: headFeedId });
    }
  }

  async reconcileManagerInTx(
    tx: DatabaseTransaction,
    threadId: number,
    managerUserId: number,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<void> {
    const thread = await tx.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
      columns: { groupId: true },
    });
    if (!thread?.groupId) return;
    const manager = await readCurrentGroupMemberInTx(
      tx,
      thread.groupId,
      managerUserId,
    );
    const isActiveManager =
      manager?.domain === 'local' &&
      (manager.role === GroupRole.OWNER || manager.role === GroupRole.ADMIN) &&
      (await isThreadMutuallyAuthorized(tx, managerUserId, threadId));
    if (!isActiveManager) {
      const removed = await tx
        .delete(tables.groupRequestProjection)
        .where(
          and(
            eq(tables.groupRequestProjection.managerUserId, managerUserId),
            eq(tables.groupRequestProjection.threadId, threadId),
          ),
        )
        .returning({
          memberUserId: tables.groupRequestProjection.memberUserId,
        });
      for (const request of removed)
        await this.clientStateFeed.cleanupProfileStateIfUnreferencedInTx(
          tx,
          managerUserId,
          request.memberUserId,
        );
      return;
    }
    const requests = await tx
      .selectDistinctOn(
        [
          tables.groupRequestProjection.memberUserId,
          tables.groupRequestProjection.direction,
        ],
        {
          memberUserId: tables.groupRequestProjection.memberUserId,
          status: tables.groupRequestProjection.status,
          direction: tables.groupRequestProjection.direction,
        },
      )
      .from(tables.groupRequestProjection)
      .where(
        and(
          eq(tables.groupRequestProjection.threadId, threadId),
          sql`${tables.groupRequestProjection.expiresAt} > CURRENT_TIMESTAMP`,
        ),
      )
      .orderBy(
        tables.groupRequestProjection.memberUserId,
        tables.groupRequestProjection.direction,
        desc(tables.groupRequestProjection.feedId),
      );
    for (const request of requests)
      await this.writeEffectsInTx(
        tx,
        threadId,
        thread.groupId,
        request.memberUserId,
        clientFeedUpdates,
        request.status as GroupRequestStatus,
        request.direction as GroupRequestDirection,
        true,
        managerUserId,
      );
  }
}
