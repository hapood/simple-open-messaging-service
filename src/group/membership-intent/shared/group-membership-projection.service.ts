import {
  groupState as group,
  readGroupState,
} from '../../shared/group-state.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../../../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../database/database.service.js';
import { GroupRole } from '../../../database/enums.js';
import { accountThreadState, groupMeta } from '../../../database/schema.js';
import { readCurrentGroupMemberInTx } from '../../meta/current-group-roster.js';
import { GroupMetaFeedService } from '../../meta/group-meta-feed.service.js';
import {
  initialGroupManagerProjection,
  transitionGroupManagerProjection,
} from '../../shared/group-manager-projection.js';

export interface GroupMembershipSyncResult {
  canonicalRosterChanged: boolean;
}

/** Applies the local conversation projection and, only for an authoritative group, its canonical
 * Group Meta membership fact. Audience mutation and durable head fan-out admission remain the
 * outer relationship mutation's responsibility. */
@Injectable()
export class GroupMembershipProjectionService {
  constructor(private readonly groupMeta: GroupMetaFeedService) {}

  async syncFromActiveInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      groupId: number;
      memberUserId: AccountTarget;
      active: boolean;
      /** The pair's transition in the owning transaction. */
      pairChanged: boolean;
      hostedLocally: boolean;
      memberProfileRev?: number;
      initialRole?: typeof GroupRole.OWNER;
      allowOwnerDeactivation?: boolean;
      updateCanonicalRoster?: boolean;
    },
  ): Promise<GroupMembershipSyncResult> {
    const identity = await accountAddressInTx(tx, params.memberUserId);
    const [localAccount] = await localAccountsForTargetsInTx(tx, [identity]);
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
        !params.pairChanged ||
        params.updateCanonicalRoster === false
      )
        return { canonicalRosterChanged: false };
      if (current?.role === GroupRole.OWNER && !params.allowOwnerDeactivation)
        throw new Error('owner deactivation requires explicit authorization');
      if (!current)
        throw new Error('departing group member projection is missing');
      await this.groupMeta.appendMemberTransitionInTx(tx, params.groupId, {
        account: identity.account,
        profileNamespaceId: identity.namespaceId,
        operation: 'MEMBER_DEPART',
        body: {
          role: current.role,
          profileNamespaceId: current.namespaceId,
          profileRev: current.profileRev,
        },
      });
      return { canonicalRosterChanged: true };
    }

    const role = params.pairChanged
      ? (params.initialRole ?? GroupRole.MEMBER)
      : (current?.role ?? params.initialRole ?? GroupRole.MEMBER);
    let canonicalRosterChanged = false;
    if (
      params.hostedLocally &&
      params.updateCanonicalRoster !== false &&
      params.pairChanged
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
      const source = await readGroupState(tx, eq(group.id, params.groupId));
      if (!source) throw new Error('authoritative group profile is missing');
      await this.groupMeta.reconcileProfileInTx(
        tx,
        params.groupId,
        source.profileRev,
      );
      await this.groupMeta.appendMemberTransitionInTx(tx, params.groupId, {
        account: identity.account,
        profileNamespaceId: identity.namespaceId,
        operation: 'MEMBER_UPSERT',
        body: { role, profileNamespaceId: identity.namespaceId, profileRev },
      });
      canonicalRosterChanged = true;
    }

    if (localAccount) {
      // Keep manager-head initialization inside the participant upsert. This
      // preserves missing-row repair without a separate GroupMeta round trip.
      const projectionHead = {
        applicationEndId: sql<number>`(SELECT ${groupMeta.applicationEndId} FROM ${groupMeta} WHERE ${groupMeta.threadId} = ${params.threadId})`,
        invitationEndId: sql<number>`(SELECT ${groupMeta.invitationEndId} FROM ${groupMeta} WHERE ${groupMeta.threadId} = ${params.threadId})`,
      };
      // A locally authoritative group creates its first Group Meta facts in
      // this same transaction. Seed the participant cursor with that exact
      // coordinate so the first thread-feed snapshot pulls the owner roster.
      // Mirrors use their replicated cursor and must not read the origin's
      // metaEndId here.
      const groupMetaFeedEndId = params.hostedLocally
        ? sql<number>`(SELECT ${groupMeta.metaEndId} FROM ${groupMeta} WHERE ${groupMeta.threadId} = ${params.threadId})`
        : undefined;
      // Local creation has already committed the group profile to the meta
      // head. Mirrored groups may not have received that head yet.
      const groupProfileRev = sql<number>`(SELECT ${groupMeta.profileRev} FROM ${groupMeta} WHERE ${groupMeta.threadId} = ${params.threadId})`;
      const initialManagerProjection = initialGroupManagerProjection(
        role,
        projectionHead,
      );
      const previousRole = params.pairChanged ? null : (current?.role ?? null);
      const managerProjection = transitionGroupManagerProjection(
        previousRole,
        role,
        projectionHead,
      );
      await tx
        .insert(accountThreadState)
        .values({
          accountId: localAccount.id,
          threadId: params.threadId,
          role,
          threadProfileRev: groupProfileRev,
          ...(groupMetaFeedEndId !== undefined ? { groupMetaFeedEndId } : {}),
          ...initialManagerProjection,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [accountThreadState.accountId, accountThreadState.threadId],
          set: {
            role,
            ...(groupMetaFeedEndId !== undefined
              ? {
                  groupMetaFeedEndId: sql<number>`GREATEST(COALESCE("AccountThreadState"."groupMetaFeedEndId", 0), ${groupMetaFeedEndId})`,
                }
              : {}),
            ...managerProjection,
            messageVisibleThroughSeq: null,
            updatedAt: new Date(),
          },
        });
    }
    return { canonicalRosterChanged };
  }
}
