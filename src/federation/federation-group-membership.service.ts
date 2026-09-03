import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import {
  account,
  group,
  accountThreadState,
  user,
} from '../database/schema.js';
import { readCurrentGroupMemberInTx } from '../group-meta/current-group-roster.js';
import { GroupMetaFeedService } from './group-meta-feed.service.js';

export interface GroupMembershipSyncResult {
  canonicalRosterChanged: boolean;
}

/** Applies the local conversation projection and, only for an authoritative group, its canonical
 * Group Meta membership fact. Audience mutation and durable head fan-out admission remain the
 * outer relationship mutation's responsibility. */
@Injectable()
export class FederationGroupMembershipService {
  constructor(private readonly groupMetaFeed: GroupMetaFeedService) {}

  async syncFromActiveInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: number;
      active: boolean;
      hostedLocally: boolean;
      memberProfileRev?: number;
      initialRole?: typeof GroupRole.OWNER;
      allowOwnerDeactivation?: boolean;
      updateCanonicalRoster?: boolean;
    },
  ): Promise<GroupMembershipSyncResult> {
    const identity = await tx.query.user.findFirst({
      where: eq(user.id, params.memberUserId),
      columns: { id: true, account: true, domain: true },
    });
    const localAccount = await tx.query.account.findFirst({
      where: eq(account.id, params.memberUserId),
      columns: { id: true },
    });
    if (!identity) throw new Error('group member identity is missing');
    const current =
      params.hostedLocally && params.updateCanonicalRoster !== false
        ? await readCurrentGroupMemberInTx(
            tx,
            params.groupId,
            params.memberUserId,
          )
        : undefined;

    if (!params.active) {
      if (
        !params.hostedLocally ||
        !current ||
        (current.role === GroupRole.OWNER && !params.allowOwnerDeactivation)
      )
        return { canonicalRosterChanged: false };
      await this.groupMetaFeed.reconcileMembersInTx(tx, params.groupId, [
        {
          userId: current.userId,
          account: current.account,
          domain: current.domain,
          operation: 'DEPART',
          body: {},
        },
      ]);
      return { canonicalRosterChanged: true };
    }

    const role = current?.role ?? params.initialRole ?? GroupRole.MEMBER;
    let canonicalRosterChanged = false;
    if (
      params.hostedLocally &&
      params.updateCanonicalRoster !== false &&
      !current
    ) {
      const profileRev = params.memberProfileRev;
      if (
        typeof profileRev !== 'number' ||
        !Number.isSafeInteger(profileRev) ||
        profileRev < 0
      )
        throw new Error(
          'active group membership has no valid profile revision',
        );
      const source = await tx.query.group.findFirst({
        where: eq(group.id, params.groupId),
        columns: { defaultProfileRev: true },
      });
      if (!source) throw new Error('authoritative group profile is missing');
      await this.groupMetaFeed.reconcileProfileInTx(
        tx,
        params.groupId,
        source.defaultProfileRev,
      );
      await this.groupMetaFeed.reconcileMembersInTx(tx, params.groupId, [
        {
          userId: identity.id,
          account: identity.account,
          domain: identity.domain,
          operation: 'UPSERT',
          body: { role, profileRev },
        },
      ]);
      canonicalRosterChanged = true;
    }

    if (localAccount)
      await tx
        .insert(accountThreadState)
        .values({
          accountId: localAccount.id,
          threadId: params.threadId,
          role,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [accountThreadState.accountId, accountThreadState.threadId],
          set: {
            role,
            messageVisibleThroughSeq: null,
            updatedAt: new Date(),
          },
        });
    return { canonicalRosterChanged };
  }
}
