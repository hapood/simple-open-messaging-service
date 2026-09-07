import {
  groupState as groupStateTable,
  readGroupState,
} from '../group/group-state.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../user/account-address.js';
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

type GroupRequestStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
type GroupRequestDirection = 'APPLICATION' | 'INVITATION';

/** Maintains the manager-facing projection derived from group relationship intents. */
@Injectable()
export class FederationGroupRequestProjectionService {
  constructor(private readonly clientStateFeed: ClientStateFeedService) {}

  async writeEffectsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    groupId: number,
    memberUserId: AccountTarget,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
    status: GroupRequestStatus = 'REQUESTED',
    direction: GroupRequestDirection = 'APPLICATION',
    createIfMissing = true,
    managerUserId?: number,
  ): Promise<void> {
    if (!clientFeedUpdates) return;
    const member = await accountAddressInTx(tx, memberUserId);
    const groupIdentity = await readGroupState(
      tx,
      eq(groupStateTable.id, groupId),
    );
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
        eq(tables.relationshipPair.id, tables.relationshipIntent.pairId),
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
    const managers = await readCurrentLocalGroupManagersInTx(tx, {
      groupId,
      threadId,
      managerUserId,
    });
    if (!groupIdentity || !request || !member) return;
    const [localMember] = await localAccountsForTargetsInTx(tx, [member]);
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
                  eq(
                    tables.groupRequestProjection.memberAccount,
                    member.account,
                  ),
                  eq(tables.groupRequestProjection.memberDomain, member.domain),
                  eq(
                    tables.groupRequestProjection.memberNamespaceId,
                    member.namespaceId,
                  ),
                  eq(tables.groupRequestProjection.direction, direction),
                ),
              )
          ).map((row) => row.managerUserId),
        );
    for (const manager of managers) {
      if (manager.userId === localMember?.id) continue;
      if (!createIfMissing && !existingManagers.has(manager.userId)) continue;
      const feedId = await this.clientStateFeed.writeGroupRequestInTx(tx, {
        managerUserId: manager.userId,
        threadId,
        memberAccount: member.account,
        memberDomain: member.domain,
        memberNamespaceId: member.namespaceId,
        memberProfileRev: memberIntent?.profileRev ?? 0,
        direction,
        requestId: request.id,
        status,
        note: request.note,
        requestedAt: request.requestedAt,
        expiresAt: request.expiresAt,
      });
      if (feedId === null) continue;
      clientFeedUpdates.push({ userId: manager.userId, feedId });
      if (localMember)
        clientFeedUpdates.push(
          ...(await this.clientStateFeed.recordProfileStateInTx(
            tx,
            localMember.id,
            [manager.userId],
          )),
        );
      const headFeedId =
        await this.clientStateFeed.writeGroupJoinRequestHeadInTx(tx, {
          userId: manager.userId,
          account: groupIdentity.account,
          domain: groupIdentity.domain,
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
      columns: { id: true, type: true },
    });
    if (thread?.type !== 'GROUP') return;
    const manager = await readCurrentGroupMemberInTx(
      tx,
      thread.id,
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
          account: tables.groupRequestProjection.memberAccount,
          domain: tables.groupRequestProjection.memberDomain,
          namespaceId: tables.groupRequestProjection.memberNamespaceId,
        });
      for (const request of removed)
        await this.clientStateFeed.cleanupProfileStateIfUnreferencedInTx(
          tx,
          managerUserId,
          request,
        );
      return;
    }
    const requests = await tx
      .selectDistinctOn(
        [
          tables.groupRequestProjection.memberAccount,
          tables.groupRequestProjection.memberDomain,
          tables.groupRequestProjection.memberNamespaceId,
          tables.groupRequestProjection.direction,
        ],
        {
          account: tables.groupRequestProjection.memberAccount,
          domain: tables.groupRequestProjection.memberDomain,
          namespaceId: tables.groupRequestProjection.memberNamespaceId,
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
        tables.groupRequestProjection.memberAccount,
        tables.groupRequestProjection.memberDomain,
        tables.groupRequestProjection.memberNamespaceId,
        tables.groupRequestProjection.direction,
        desc(tables.groupRequestProjection.feedId),
      );
    for (const request of requests)
      await this.writeEffectsInTx(
        tx,
        threadId,
        thread.id,
        request,
        clientFeedUpdates,
        request.status as GroupRequestStatus,
        request.direction as GroupRequestDirection,
        true,
        managerUserId,
      );
  }
}
