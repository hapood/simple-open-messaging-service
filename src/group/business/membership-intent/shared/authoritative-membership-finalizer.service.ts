import {
  groupState as group,
  groupStateFields,
} from '../../shared/group-state.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../../../../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../../database/database.service.js';
import {
  groupMeta,
  messageThread,
  threadAudience,
} from '../../../../database/schema.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from '../../../../federation/federation-audience.js';
import { FederationThreadContentHeadService } from '../../../../federation/federation-thread-content-head.service.js';
import type { ThreadContentLock } from '../../../../common/business/locks/thread-content-lock.js';
import { enqueueCurrentThreadFanoutsInTx } from '../../../../message/thread-fanout-task.js';

export interface AuthoritativeGroupMembershipFinalization {
  audienceChanged: boolean;
  threadFanoutAdmitted: boolean;
}

/** Reconciles the affected audience after canonical membership folding and admits head fan-out as
 * the last operation in the same outer mutation transaction. */
@Injectable()
export class AuthoritativeMembershipFinalizerService {
  constructor(
    private readonly threadContentHeads: FederationThreadContentHeadService,
  ) {}

  async finalizeInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: AccountTarget;
      active: boolean;
      canonicalRosterChanged: boolean;
      threadLock: ThreadContentLock;
    },
  ): Promise<AuthoritativeGroupMembershipFinalization> {
    const member = await accountAddressInTx(tx, params.memberUserId);
    const [state] = await tx
      .select({
        account: groupStateFields.account,
        domain: groupStateFields.domain,
        namespaceId: groupStateFields.namespaceId,
        metaEndId: groupMeta.metaEndId,
      })
      .from(group)
      .innerJoin(messageThread, eq(messageThread.id, group.id))
      .leftJoin(groupMeta, eq(groupMeta.threadId, group.id))
      .where(
        and(
          eq(group.id, params.groupId),
          eq(messageThread.id, params.threadId),
        ),
      )
      .limit(1);
    if (!state) throw new Error('group membership finalization target missing');
    if (state.domain !== 'local' || state.namespaceId !== 0)
      return { audienceChanged: false, threadFanoutAdmitted: false };

    const metaEndId = state.metaEndId ?? 0;
    let audienceChanged: boolean;
    if (member.domain === 'local') {
      const [localAccount] = await localAccountsForTargetsInTx(tx, [member]);
      if (!localAccount)
        throw new Error('local group member account is missing');
      audienceChanged = params.active
        ? await this.openLocalAudienceInTx(
            tx,
            params.threadId,
            localAccount.id,
            metaEndId,
          )
        : await this.closeLocalAudienceInTx(
            tx,
            params.threadId,
            localAccount.id,
          );
    } else if (params.active) {
      audienceChanged = await openFederatedAudienceInTx(
        tx,
        member.domain,
        params.threadId,
        metaEndId,
      );
      // REQUESTED may have already opened query authorization without publishing a head.
      // Mutual activation must therefore refresh the compacted content head even when the
      // audience insert is an idempotent no-op.
      await this.threadContentHeads.refreshInTx(
        tx,
        member.domain,
        member.namespaceId,
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
            AND pair."endpointBDomain" = ${member.domain}
            AND pair."endpointBNamespaceId" = ${member.namespaceId}
        ) AS active
      `);
      audienceChanged = activePeerMembership.rows[0]?.active
        ? false
        : await closeFederatedAudienceInTx(tx, member.domain, params.threadId);
    }

    // Removing an authoritative audience does not invalidate thread-wide rounds.
    // In-flight commits recheck their own peer audience under the same group/thread locks.

    const shouldFanOut =
      params.canonicalRosterChanged || (params.active && audienceChanged);
    if (shouldFanOut)
      await enqueueCurrentThreadFanoutsInTx(tx, params.threadLock);
    return { audienceChanged, threadFanoutAdmitted: shouldFanOut };
  }

  private async openLocalAudienceInTx(
    tx: DatabaseTransaction,
    threadId: number,
    localUserId: number,
    groupMetaVisibleAfter: number,
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
