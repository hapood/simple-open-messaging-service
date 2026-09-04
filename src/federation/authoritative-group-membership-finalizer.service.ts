import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  group,
  groupMetaFeed,
  messageThread,
  threadAudience,
  user,
} from '../database/schema.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from './federation-audience.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';

export interface AuthoritativeGroupMembershipFinalization {
  audienceChanged: boolean;
  fanoutTaskCreated: boolean;
}

/** Reconciles the affected audience after canonical membership folding and admits head fan-out as
 * the last operation in the same outer mutation transaction. */
@Injectable()
export class AuthoritativeGroupMembershipFinalizer {
  constructor(
    private readonly tasks: DurableTaskQueueService,
    private readonly threadContentHeads: FederationThreadContentHeadService,
  ) {}

  async finalizeInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: number;
      active: boolean;
      canonicalRosterChanged: boolean;
    },
  ): Promise<AuthoritativeGroupMembershipFinalization> {
    const [state] = await tx
      .select({
        account: group.account,
        domain: group.domain,
        namespaceId: group.namespaceId,
        feedEndId: groupMetaFeed.feedEndId,
        memberDomain: user.domain,
        memberNamespaceId: user.namespaceId,
      })
      .from(group)
      .innerJoin(messageThread, eq(messageThread.groupId, group.id))
      .innerJoin(user, eq(user.id, params.memberUserId))
      .leftJoin(groupMetaFeed, eq(groupMetaFeed.groupId, group.id))
      .where(
        and(
          eq(group.id, params.groupId),
          eq(messageThread.id, params.threadId),
        ),
      )
      .limit(1);
    if (!state) throw new Error('group membership finalization target missing');
    if (state.domain !== 'local' || state.namespaceId !== 0)
      return { audienceChanged: false, fanoutTaskCreated: false };

    const feedEndId = state.feedEndId ?? 0n;
    let audienceChanged: boolean;
    if (state.memberDomain === 'local') {
      audienceChanged = params.active
        ? await this.openLocalAudienceInTx(
            tx,
            params.threadId,
            params.memberUserId,
            feedEndId,
          )
        : await this.closeLocalAudienceInTx(
            tx,
            params.threadId,
            params.memberUserId,
          );
    } else if (params.active) {
      audienceChanged = await openFederatedAudienceInTx(
        tx,
        state.memberDomain,
        params.threadId,
        feedEndId,
      );
      // REQUESTED may have already opened query authorization without publishing a head.
      // Mutual activation must therefore refresh the compacted content head even when the
      // audience insert is an idempotent no-op.
      await this.threadContentHeads.refreshInTx(
        tx,
        state.memberDomain,
        state.memberNamespaceId,
        params.threadId,
      );
    } else {
      const activePeerMembership = await tx.execute<{ active: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM "RelationshipPair" pair
          WHERE pair.kind = 'GROUP_MEMBER'
            AND pair."threadId" = ${params.threadId}
            AND pair.active = true
            AND pair."endpointBDomain" = ${state.memberDomain}
            AND pair."endpointBNamespaceId" = ${state.memberNamespaceId}
        ) AS active
      `);
      audienceChanged = activePeerMembership.rows[0]?.active
        ? false
        : await closeFederatedAudienceInTx(
            tx,
            state.memberDomain,
            params.threadId,
          );
    }

    if (audienceChanged && !params.active)
      await tx
        .update(messageThread)
        .set({
          authorizationEpoch: sql`${messageThread.authorizationEpoch} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(messageThread.id, params.threadId));

    const shouldFanOut =
      params.canonicalRosterChanged || (params.active && audienceChanged);
    if (shouldFanOut)
      await this.tasks.enqueueGroupMetaHeadFanoutInTx(tx, {
        group: { account: state.account, domain: state.domain },
        threadId: params.threadId,
      });
    return { audienceChanged, fanoutTaskCreated: shouldFanOut };
  }

  private async openLocalAudienceInTx(
    tx: DatabaseTransaction,
    threadId: number,
    localUserId: number,
    groupMetaVisibleAfter: bigint,
  ): Promise<boolean> {
    const inserted = await tx
      .insert(threadAudience)
      .values({
        targetDomain: 'local',
        targetNamespaceId: 0,
        localUserId,
        threadId,
        groupMetaVisibleAfter,
      })
      .onConflictDoNothing({
        target: [
          threadAudience.targetDomain,
          threadAudience.localUserId,
          threadAudience.threadId,
        ],
        where: sql`${threadAudience.targetDomain} = 'local'`,
      })
      .returning({ id: threadAudience.id });
    return inserted.length > 0;
  }

  private async closeLocalAudienceInTx(
    tx: DatabaseTransaction,
    threadId: number,
    localUserId: number,
  ): Promise<boolean> {
    const deleted = await tx
      .delete(threadAudience)
      .where(
        and(
          eq(threadAudience.targetDomain, 'local'),
          eq(threadAudience.localUserId, localUserId),
          eq(threadAudience.threadId, threadId),
          eq(threadAudience.targetNamespaceId, 0),
        ),
      )
      .returning({ id: threadAudience.id });
    return deleted.length > 0;
  }
}
