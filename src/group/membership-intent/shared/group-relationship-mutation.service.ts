import { isGroupDissolvedInTx } from '../../shared/group-state.js';
import {
  groupState as groupStateTable,
  readGroupState,
  groupStateFields,
} from '../../shared/group-state.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../../../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import { eq } from 'drizzle-orm';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../../../database/database.service.js';
import type { ThreadContentLock } from '../../../common/locks/thread-content-lock.js';
import { GroupRole } from '../../../database/enums.js';
import * as tables from '../../../database/schema.js';
import {
  RelationshipService,
  type FederatedPendingProfileSnapshot,
} from '../../../relationship/relationship.service.js';
import {
  buildIntentDirection,
  RelationshipIntentService,
} from '../../../relationship/relationship-intent.service.js';
import { FederationGroupRequestProjectionService } from '../../../federation/federation-group-request-projection.service.js';
import { GroupRelationshipFoldService } from './group-relationship-fold.service.js';
import { writeMirrorLocalGroupLeftInTx } from './mirror-local-group-left.js';
import {
  PeerStateFeedService,
  type PeerStateFeedWrite,
} from '../../../federation/peer-state-feed.service.js';
import type {
  RequestRevocationStatus,
  RequestProjectionStatusValue,
} from '../../../../shared/request-projection-status.js';

function groupIntentEndpoints(
  groupAccount: string,
  memberAccount: string,
  author: 'GROUP' | 'MEMBER',
): { account: string; subjectAccount: string } {
  return author === 'GROUP'
    ? { account: groupAccount, subjectAccount: memberAccount }
    : { account: memberAccount, subjectAccount: groupAccount };
}

export interface GroupRelationshipMutationOptions {
  /** Client-visible cause for an authored terminal request transition. */
  clientRequestStatus?: RequestRevocationStatus;
  clientRequestDirection?: 'INCOMING' | 'OUTGOING';
  publishGroupState?: boolean;
  allowOwnerDeactivation?: boolean;
  initialRole?: typeof GroupRole.OWNER;
  /** A positive member intent may reopen a dissolved mirror; local dissolution remains terminal. */
  allowDissolvedPositive?: boolean;
  /** Canonical locks already owned by a composed business transaction. */
  lockedGroupPair?: {
    pairId: bigint;
    threadLock: ThreadContentLock;
  };
  /** Pair fold already authorized by the lock-owning business state read. */
  validatedPairActive?: boolean;
  /** Commit-time fence for work derived from a federation query denial. */
  expectedAuthorization?: {
    epoch: number;
    group: { account: string; namespaceId: number };
  };
}

/**
 * Serializes and applies relationship mutations. Transport wake-ups remain an
 * outer orchestration concern and occur only after the caller's transaction
 * commits.
 */
@Injectable()
export class GroupRelationshipMutationService {
  constructor(
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupRequestProjection: FederationGroupRequestProjectionService,
    private readonly relationships: RelationshipService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly groupRelationships: GroupRelationshipFoldService,
  ) {}

  /** Call after the group command lock, before departure messages allocate client state. */
  async lockMemberRelationshipFeedInTx(
    tx: DatabaseTransaction,
    group: { domain: string; namespaceId: number },
  ): Promise<void> {
    if (group.namespaceId === 0) return;
    await this.stateFeed.lockOutboundStateFeedNamespacesInTx(tx, [
      { namespaceId: group.namespaceId },
    ]);
  }

  async writeMemberRelationshipIntentInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' = 'REQUESTED',
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
    note = '',
    groupSnapshot?: FederatedPendingProfileSnapshot,
    options: GroupRelationshipMutationOptions = {},
  ): Promise<Map<number, bigint>> {
    const {
      publishGroupState = true,
      allowOwnerDeactivation,
      initialRole,
      allowDissolvedPositive = false,
      lockedGroupPair,
      validatedPairActive,
      expectedAuthorization,
      clientRequestStatus,
      clientRequestDirection,
    } = options;
    if (validatedPairActive !== undefined && !lockedGroupPair)
      throw new Error('validated pair fold requires a locked group pair');
    if (
      status !== 'REVOKED' &&
      !allowDissolvedPositive &&
      (await isGroupDissolvedInTx(tx, threadId))
    )
      return new Map<number, bigint>();
    const locked =
      lockedGroupPair ??
      (await this.lockGroupMutationInTx(tx, threadId, memberUserId));
    const [thread] = await tx
      .select({
        groupId: tables.messageThread.id,
        authorizationEpoch: tables.messageThread.authorizationEpoch,
      })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!thread?.groupId) throw new Error('group join target is invalid');
    const group = await readGroupState(
      tx,
      eq(groupStateTable.id, thread.groupId),
    );
    const member = await tx.query.account.findFirst({
      where: eq(tables.account.id, memberUserId),
      columns: { account: true, namespaceId: true },
    });
    if (!group || !member || member.namespaceId !== 0)
      throw new Error('group join identities are invalid');
    if (
      expectedAuthorization &&
      (thread.authorizationEpoch !== expectedAuthorization.epoch ||
        group.account !== expectedAuthorization.group.account ||
        group.namespaceId !== expectedAuthorization.group.namespaceId)
    )
      return new Map<number, bigint>();
    if (!lockedGroupPair) await this.lockMemberRelationshipFeedInTx(tx, group);
    const projectedAvatar = groupSnapshot
      ? (groupSnapshot.avatar ?? '')
      : group.avatar;
    const memberDirection = buildIntentDirection(member, group);
    const membership =
      await this.groupRelationships.writeLockedAuthoredIntentInTx(tx, {
        threadId,
        groupId: thread.groupId,
        memberUserId,
        pairId: 'pairId' in locked ? locked.pairId : locked.id,
        memberLocal: member.namespaceId === 0,
        memberDirection,
        direction: memberDirection,
        threadLock: locked.threadLock,
        author: 'MEMBER',
        hostedLocally: group.namespaceId === 0,
        status,
        note,
        expiresAt:
          status === 'REQUESTED'
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            : null,
        ...(initialRole ? { initialRole } : {}),
        ...(allowOwnerDeactivation ? { allowOwnerDeactivation: true } : {}),
        ...(!publishGroupState ? { updateCanonicalRoster: false } : {}),
        ...(validatedPairActive === undefined ? {} : { validatedPairActive }),
      });
    if (
      group.namespaceId !== 0 &&
      status === 'REVOKED' &&
      membership.pairChanged
    ) {
      await writeMirrorLocalGroupLeftInTx(tx, {
        threadId,
        localMemberId: memberUserId,
        memberAccount: member.account,
        threadLock: locked.threadLock,
      });
    }
    if (allowDissolvedPositive && group.namespaceId !== 0)
      await tx
        .update(tables.messageThread)
        .set({
          groupDissolvedAt: null,
          federationRoundsEnabled: true,
          updatedAt: new Date(),
        })
        .where(eq(tables.messageThread.id, threadId));
    const clientRequestedAt =
      membership.request.status === 'REVOKED'
        ? null
        : membership.request.requestedAt;
    if (clientFeedUpdates && membership.pairChanged)
      clientFeedUpdates.push(
        ...(await captureThreadStateUpdatesInTx(tx, [memberUserId])),
      );
    if (group.namespaceId === 0 && membership.changed)
      await this.writeGroupRequestEffectsInTx(
        tx,
        threadId,
        memberUserId,
        membership.shouldBeActive
          ? 'ACCEPTED'
          : membership.request.status === 'REVOKED'
            ? (clientRequestStatus ?? 'WITHDRAWN')
            : membership.request.status,
        membership.request.status === 'ACCEPTED' ? 'INVITATION' : 'APPLICATION',
        membership.request.status === 'REQUESTED',
      );
    if (group.namespaceId === 0) {
      if (clientFeedUpdates && membership.changed) {
        const endpoints = groupIntentEndpoints(
          group.account,
          member.account,
          'MEMBER',
        );
        const feedId = await this.clientStateFeed.writeInTx(tx, {
          userId: memberUserId,
          account: endpoints.account,
          domain: group.domain,
          namespaceId: 0,
          eventType: 'RELATIONSHIP_INTENT',
          subjectAccount: endpoints.subjectAccount,
          subjectNamespaceId: 0,
          body: {
            status: membership.request.status,
            ...(clientRequestStatus
              ? { requestStatus: clientRequestStatus }
              : {}),
            ...(clientRequestDirection
              ? { requestDirection: clientRequestDirection }
              : {}),
            note: membership.request.note,
            requestedAt: clientRequestedAt,
            expiresAt: membership.request.expiresAt,
            direction: 'OUTGOING',
            threadId,
            group: {
              account: group.account,
              namespaceId: 0,
              avatar: projectedAvatar,
              description: group.description,
              profileRev: group.profileRev,
            },
          },
        });
        if (feedId !== null)
          clientFeedUpdates.push({ userId: memberUserId, feedId });
      }
      return new Map();
    }
    const relationship: PeerStateFeedWrite = {
      namespaceId: group.namespaceId!,
      account: member.account,
      subjectAccount: group.account,
      subjectNamespaceId: group.namespaceId!,
      eventType: 'RELATIONSHIP_INTENT',
      body: {
        status: membership.request.status,
        namespaceId: 0,
        profileRev: membership.request.profileRev,
        note: membership.request.note,
        messageEndSeq: membership.request.messageEndSeq,
        tombstoneEndSeq: membership.request.tombstoneEndSeq,
        requestedAt: membership.request.requestedAt,
        expiresAt: membership.request.expiresAt,
      },
    };
    if (clientFeedUpdates && membership.changed) {
      const endpoints = groupIntentEndpoints(
        group.account,
        member.account,
        'MEMBER',
      );
      const feedId = await this.clientStateFeed.writeInTx(tx, {
        userId: memberUserId,
        account: endpoints.account,
        domain: group.domain,
        namespaceId: group.namespaceId,
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: endpoints.subjectAccount,
        subjectNamespaceId: group.namespaceId!,
        body: {
          status: membership.request.status,
          ...(clientRequestStatus
            ? { requestStatus: clientRequestStatus }
            : {}),
          ...(clientRequestDirection
            ? { requestDirection: clientRequestDirection }
            : {}),
          note: membership.request.note,
          requestedAt: clientRequestedAt,
          expiresAt: membership.request.expiresAt,
          direction: 'OUTGOING',
          threadId,
          group: {
            account: group.account,
            namespaceId: group.namespaceId,
            avatar: projectedAvatar,
            description: group.description,
            profileRev: group.profileRev,
          },
        },
      });
      if (feedId !== null)
        clientFeedUpdates.push({ userId: memberUserId, feedId });
    }
    return relationship.body.status === 'ACCEPTED'
      ? this.stateFeed.writeAcceptanceConfirmationsInTx(tx, [relationship])
      : this.stateFeed.writeManyInTx(tx, [relationship]);
  }

  async writeGroupRelationshipIntentInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: AccountTarget,
    note: string,
    status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED',
    clientFeedUpdates: PendingClientStateFeedUpdate[],
    requestProjectionDirection?: 'APPLICATION' | 'INVITATION',
    options: GroupRelationshipMutationOptions = {},
  ): Promise<Map<number, bigint>> {
    const {
      publishGroupState = true,
      allowOwnerDeactivation,
      initialRole,
      expectedAuthorization,
      clientRequestStatus,
      clientRequestDirection,
    } = options;
    if (status !== 'REVOKED' && (await isGroupDissolvedInTx(tx, threadId)))
      return new Map<number, bigint>();
    await this.lockGroupMutationInTx(tx, threadId, memberUserId);
    const [state] = await tx
      .select({
        groupId: groupStateTable.id,
        groupAccount: groupStateFields.account,
        groupAvatar: groupStateFields.avatar,
        groupDescription: groupStateFields.description,
        groupProfileRev: groupStateFields.profileRev,
        groupNamespaceId: groupStateFields.namespaceId,
        groupDomain: groupStateFields.domain,
        authorizationEpoch: tables.messageThread.authorizationEpoch,
      })
      .from(tables.messageThread)
      .innerJoin(
        groupStateTable,
        eq(groupStateTable.id, tables.messageThread.id),
      )
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!state?.groupId) throw new Error('group invite target is invalid');
    if (
      expectedAuthorization &&
      (state.authorizationEpoch !== expectedAuthorization.epoch ||
        state.groupAccount !== expectedAuthorization.group.account ||
        state.groupNamespaceId !== expectedAuthorization.group.namespaceId)
    )
      return new Map<number, bigint>();
    const member = await accountAddressInTx(tx, memberUserId);
    if (member.namespaceId !== 0)
      await this.stateFeed.lockOutboundStateFeedNamespacesInTx(tx, [
        {
          namespaceId: member.namespaceId!,
        },
      ]);
    const membership = await this.groupRelationships.writeAuthoredIntentInTx(
      tx,
      {
        threadId,
        groupId: state.groupId,
        memberUserId,
        author: 'GROUP',
        hostedLocally: true,
        status,
        note,
        expiresAt:
          status === 'REQUESTED'
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            : null,
        ...(initialRole ? { initialRole } : {}),
        ...(allowOwnerDeactivation ? { allowOwnerDeactivation: true } : {}),
        ...(!publishGroupState ? { updateCanonicalRoster: false } : {}),
      },
    );
    if (membership.active) {
      if (membership.pairChanged)
        await tx
          .update(tables.messageThread)
          .set({ updatedAt: new Date() })
          .where(eq(tables.messageThread.id, threadId));
    }
    await this.writeGroupRequestEffectsInTx(
      tx,
      threadId,
      memberUserId,
      membership.request.status === 'REVOKED'
        ? (clientRequestStatus ??
            (requestProjectionDirection === 'APPLICATION'
              ? 'REJECTED'
              : 'WITHDRAWN'))
        : membership.request.status,
      requestProjectionDirection ??
        (membership.request.status === 'ACCEPTED'
          ? 'APPLICATION'
          : 'INVITATION'),
      membership.request.status === 'REQUESTED',
    );
    if (member.namespaceId === 0) {
      const [localAccount] = await localAccountsForTargetsInTx(tx, [member]);
      if (!localAccount)
        throw new Error('local invitation recipient is missing');
      const endpoints = groupIntentEndpoints(
        state.groupAccount,
        member.account,
        'GROUP',
      );
      const feedId = await this.clientStateFeed.writeInTx(tx, {
        userId: localAccount.id,
        account: endpoints.account,
        domain: state.groupDomain,
        namespaceId: 0,
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: endpoints.subjectAccount,
        subjectNamespaceId: 0,
        body: {
          status: membership.request.status,
          ...(clientRequestStatus
            ? { requestStatus: clientRequestStatus }
            : {}),
          ...(clientRequestDirection
            ? { requestDirection: clientRequestDirection }
            : {}),
          note: membership.request.note,
          requestedAt: membership.request.requestedAt?.getTime() ?? null,
          expiresAt: membership.request.expiresAt?.getTime() ?? null,
          threadId,
          group: {
            account: state.groupAccount,
            namespaceId: 0,
            avatar: state.groupAvatar,
            description: state.groupDescription,
            profileRev: state.groupProfileRev,
          },
        },
      });
      if (feedId !== null)
        clientFeedUpdates.push({ userId: localAccount.id, feedId });
      if (membership.pairChanged)
        clientFeedUpdates.push(
          ...(await captureThreadStateUpdatesInTx(tx, [localAccount.id])),
        );
      return new Map();
    }
    const relationship: PeerStateFeedWrite = {
      namespaceId: member.namespaceId!,
      account: state.groupAccount,
      subjectAccount: member.account,
      subjectNamespaceId: member.namespaceId,
      eventType: 'RELATIONSHIP_INTENT',
      body: {
        status: membership.request.status,
        namespaceId: 0,
        profileRev: membership.request.profileRev,
        note: membership.request.note,
        messageEndSeq: membership.request.messageEndSeq,
        tombstoneEndSeq: membership.request.tombstoneEndSeq,
        requestedAt: membership.request.requestedAt,
        expiresAt: membership.request.expiresAt,
      },
    };
    return relationship.body.status === 'ACCEPTED'
      ? this.stateFeed.writeAcceptanceConfirmationsInTx(tx, [relationship])
      : this.stateFeed.writeManyInTx(tx, [relationship]);
  }

  async lockGroupMutationInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: AccountTarget,
    projectionUserIds: readonly number[] = [],
    feedAllocatorUserIds: readonly number[] = [],
  ) {
    const [thread] = await tx
      .select({ groupId: tables.messageThread.id })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!thread?.groupId) throw new Error('group relationship thread missing');
    return this.relationshipIntents.lockGroupMutationInTx(tx, {
      threadId,
      groupId: thread.groupId,
      memberUserId,
      projectionUserIds,
      feedAllocatorUserIds,
    });
  }

  async writeGroupRequestEffectsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: AccountTarget,
    status: RequestProjectionStatusValue = 'REQUESTED',
    direction: 'APPLICATION' | 'INVITATION' = 'APPLICATION',
    createIfMissing = true,
  ): Promise<void> {
    await this.groupRequestProjection.writeEffectsInTx(
      tx,
      threadId,
      memberUserId,
      status,
      direction,
      createIfMissing,
    );
  }
}
