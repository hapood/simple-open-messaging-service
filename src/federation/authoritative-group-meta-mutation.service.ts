import { localAccountsForTargetsInTx } from '../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import { messageThread, accountThreadState } from '../database/schema.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import type { CurrentGroupRosterMember } from '../group-meta/current-group-roster.js';
import { GroupMetaFeedService } from './group-meta-feed.service.js';

interface GroupRoleChange {
  member: CurrentGroupRosterMember;
  role: GroupRole;
}

/** Applies authoritative Group Meta facts and their local projections in one outer transaction. */
@Injectable()
export class AuthoritativeGroupMetaMutationService {
  constructor(
    private readonly groupMetaFeed: GroupMetaFeedService,
    private readonly tasks: DurableTaskQueueService,
  ) {}

  async applyRoleFactsInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      changes: readonly GroupRoleChange[];
    },
  ): Promise<void> {
    if (params.changes.length === 0)
      throw new Error('authoritative group role mutation is empty');
    for (const change of params.changes) {
      if (change.role !== GroupRole.MEMBER && change.member.domain !== 'local')
        throw new Error('privileged group roles must remain on the origin');
    }

    await this.groupMetaFeed.reconcileMembersInTx(
      tx,
      params.groupId,
      params.changes.map(({ member, role }) => ({
        namespaceId: member.namespaceId,
        account: member.account,
        domain: member.domain,
        operation: 'UPSERT' as const,
        body: { role, profileRev: member.profileRev },
      })),
    );

    const now = new Date();
    for (const change of params.changes) {
      if (change.member.domain !== 'local') continue;
      const [localAccount] = await localAccountsForTargetsInTx(tx, [
        change.member,
      ]);
      if (!localAccount) throw new Error('local group role target is missing');
      await tx
        .update(accountThreadState)
        .set({ role: change.role, updatedAt: now })
        .where(
          and(
            eq(accountThreadState.accountId, localAccount.id),
            eq(accountThreadState.threadId, params.threadId),
          ),
        );
    }
    await tx
      .update(messageThread)
      .set({ updatedAt: now })
      .where(eq(messageThread.id, params.threadId));
  }

  async applyProfileFactInTx(
    tx: DatabaseTransaction,
    groupId: number,
    profileRev: number,
  ): Promise<void> {
    await this.groupMetaFeed.reconcileProfileInTx(tx, groupId, profileRev);
  }

  /** Admits head fan-out after every dependent write in the outer transaction. */
  async finalizeInTx(
    tx: DatabaseTransaction,
    params: { threadId: number; groupAccount: string },
  ): Promise<void> {
    await this.tasks.enqueueGroupMetaHeadFanoutInTx(tx, {
      group: { account: params.groupAccount, domain: 'local' },
      threadId: params.threadId,
    });
  }
}
