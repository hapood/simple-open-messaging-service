import { isGroupDissolvedInTx } from '../group/group-state.js';
import {
  groupState as groupStateTable,
  readGroupState,
  groupStateFields,
} from '../group/group-state.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { captureThreadStateUpdatesInTx } from '../client-state-feed/capture-thread-state-updates.js';
import { and, eq } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import * as tables from '../database/schema.js';
import {
  applyFederatedPendingProfileSnapshot,
  RelationshipService,
  type FederatedPendingProfileSnapshot,
} from '../relationship/relationship.service.js';
import { RelationshipIntentService } from '../relationship/relationship-intent.service.js';
import { lockBusinessAccountsInTx } from '../relationship/business-scope-lock.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationGroupRequestProjectionService } from './federation-group-request-projection.service.js';
import { FederationGroupRelationshipService } from './federation-group-relationship.service.js';
import {
  PeerStateFeedService,
  type PeerStateFeedWrite,
} from './peer-state-feed.service.js';

function groupIntentEndpoints(
  groupAccount: string,
  memberAccount: string,
  author: 'GROUP' | 'MEMBER',
): { account: string; subjectAccount: string } {
  return author === 'GROUP'
    ? { account: groupAccount, subjectAccount: memberAccount }
    : { account: memberAccount, subjectAccount: groupAccount };
}

interface GroupRelationshipMutationOptions {
  publishGroupState?: boolean;
  allowOwnerDeactivation?: boolean;
  initialRole?: typeof GroupRole.OWNER;
}

/**
 * Serializes and applies relationship mutations. Transport wake-ups remain an
 * outer orchestration concern and occur only after the caller's transaction
 * commits.
 */
@Injectable()
export class FederationRelationshipMutationService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupRequestProjection: FederationGroupRequestProjectionService,
    private readonly relationships: RelationshipService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly groupRelationships: FederationGroupRelationshipService,
  ) {}

  /** Call after the group command lock, before departure messages allocate client state. */
  async lockMemberRelationshipFeedInTx(
    tx: DatabaseTransaction,
    group: { domain: string; namespaceId: number },
  ): Promise<void> {
    if (group.domain === 'local') return;
    await this.stateFeed.lockTargetsInTx(tx, [
      { peerDomain: group.domain, namespaceId: group.namespaceId },
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
  ): Promise<Map<string, bigint>> {
    const {
      publishGroupState = true,
      allowOwnerDeactivation,
      initialRole,
    } = options;
    if (status !== 'REVOKED' && (await isGroupDissolvedInTx(tx, threadId)))
      return new Map<string, bigint>();
    await this.lockGroupMutationInTx(tx, threadId, memberUserId);
    const [thread] = await tx
      .select({ groupId: tables.messageThread.id })
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
      columns: { account: true, domain: true },
    });
    if (!group || !member || member.domain !== 'local')
      throw new Error('group join identities are invalid');
    await this.lockMemberRelationshipFeedInTx(tx, group);
    const projectedGroup = applyFederatedPendingProfileSnapshot(
      { name: group.name, avatar: group.avatar },
      groupSnapshot,
    );
    const membership = await this.groupRelationships.writeAuthoredIntentInTx(
      tx,
      {
        threadId,
        groupId: thread.groupId,
        memberUserId,
        author: 'MEMBER',
        hostedLocally: group.domain === 'local',
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
    const clientRequestedAt =
      membership.request.status === 'REVOKED'
        ? null
        : membership.request.requestedAt;
    if (clientFeedUpdates && membership.pairChanged)
      clientFeedUpdates.push(
        ...(await captureThreadStateUpdatesInTx(tx, [memberUserId])),
      );
    if (group.domain === 'local' && membership.changed)
      await this.writeGroupRequestEffectsInTx(
        tx,
        threadId,
        thread.groupId,
        memberUserId,
        clientFeedUpdates,
        membership.shouldBeActive ? 'ACCEPTED' : membership.request.status,
        membership.request.status === 'ACCEPTED' ? 'INVITATION' : 'APPLICATION',
        membership.request.status === 'REQUESTED',
      );
    if (group.domain === 'local') {
      if (clientFeedUpdates && membership.changed) {
        const endpoints = groupIntentEndpoints(
          group.account,
          member.account,
          'MEMBER',
        );
        const feedId = await this.clientStateFeed.writeInTx(tx, {
          userId: memberUserId,
          account: endpoints.account,
          domain: 'local',
          namespaceId: 0,
          eventType: 'RELATIONSHIP_INTENT',
          subjectAccount: endpoints.subjectAccount,
          subjectDomain: 'local',
          body: {
            status: membership.request.status,
            note: membership.request.note,
            requestedAt: clientRequestedAt,
            expiresAt: membership.request.expiresAt,
            direction: 'OUTGOING',
            threadId,
            group: {
              account: group.account,
              domain: 'local',
              isLocal: true,
              name: projectedGroup.name,
              avatar: projectedGroup.avatar,
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
      peerDomain: group.domain,
      namespaceId: group.namespaceId!,
      account: member.account,
      domain: this.config.domain,
      subjectAccount: group.account,
      subjectDomain: group.domain,
      eventType: 'RELATIONSHIP_INTENT',
      body: {
        status: membership.request.status,
        profileRev: membership.request.profileRev,
        note: membership.request.note,
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
        domain: 'local',
        namespaceId: group.namespaceId,
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: endpoints.subjectAccount,
        subjectDomain: group.domain,
        body: {
          status: membership.request.status,
          note: membership.request.note,
          requestedAt: clientRequestedAt,
          expiresAt: membership.request.expiresAt,
          direction: 'OUTGOING',
          threadId,
          group: {
            account: group.account,
            domain: group.domain,
            isLocal: false,
            name: projectedGroup.name,
            avatar: projectedGroup.avatar,
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
  ): Promise<Map<string, bigint>> {
    const {
      publishGroupState = true,
      allowOwnerDeactivation,
      initialRole,
    } = options;
    if (status !== 'REVOKED' && (await isGroupDissolvedInTx(tx, threadId)))
      return new Map<string, bigint>();
    await this.lockGroupMutationInTx(tx, threadId, memberUserId);
    const [state] = await tx
      .select({
        groupId: groupStateTable.id,
        groupAccount: groupStateFields.account,
        groupName: groupStateFields.name,
        groupAvatar: groupStateFields.avatar,
        groupDescription: groupStateFields.description,
        groupProfileRev: groupStateFields.profileRev,
        groupNamespaceId: groupStateFields.namespaceId,
      })
      .from(tables.messageThread)
      .innerJoin(
        groupStateTable,
        eq(groupStateTable.id, tables.messageThread.id),
      )
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!state?.groupId) throw new Error('group invite target is invalid');
    const member = await accountAddressInTx(tx, memberUserId);
    if (member.domain !== 'local')
      await this.stateFeed.lockTargetsInTx(tx, [
        {
          peerDomain: member.domain,
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
      state.groupId,
      memberUserId,
      clientFeedUpdates,
      membership.request.status,
      requestProjectionDirection ??
        (membership.request.status === 'ACCEPTED'
          ? 'APPLICATION'
          : 'INVITATION'),
      membership.request.status === 'REQUESTED',
    );
    if (member.domain === 'local') {
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
        domain: 'local',
        namespaceId: 0,
        eventType: 'RELATIONSHIP_INTENT',
        subjectAccount: endpoints.subjectAccount,
        subjectDomain: 'local',
        body: {
          status: membership.request.status,
          note: membership.request.note,
          requestedAt: membership.request.requestedAt?.getTime() ?? null,
          expiresAt: membership.request.expiresAt?.getTime() ?? null,
          threadId,
          group: {
            account: state.groupAccount,
            domain: 'local',
            isLocal: true,
            name: state.groupName,
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
      peerDomain: member.domain,
      namespaceId: member.namespaceId!,
      account: state.groupAccount,
      domain: this.config.domain,
      subjectAccount: member.account,
      subjectDomain: member.domain,
      eventType: 'RELATIONSHIP_INTENT',
      body: {
        status: membership.request.status,
        profileRev: membership.request.profileRev,
        note: membership.request.note,
        requestedAt: membership.request.requestedAt,
        expiresAt: membership.request.expiresAt,
      },
    };
    return relationship.body.status === 'ACCEPTED'
      ? this.stateFeed.writeAcceptanceConfirmationsInTx(tx, [relationship])
      : this.stateFeed.writeManyInTx(tx, [relationship]);
  }

  async writeP2PIntentInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    peerUserId: AccountTarget,
    wantsFriend: boolean,
    note: string,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const remote = await accountAddressInTx(tx, peerUserId);
    if (remote.domain === 'local') {
      clientFeedUpdates.push(
        ...(await this.relationships.writeLocalP2PIntentInTx(
          tx,
          localUserId,
          peerUserId,
          wantsFriend,
          note,
        )),
      );
      return new Map();
    }
    const local = await tx.query.account.findFirst({
      where: and(
        eq(tables.account.id, localUserId),
        eq(tables.account.domain, 'local'),
      ),
      columns: { account: true },
    });
    if (!remote || !local) throw new Error('invalid federated friend intent');
    await this.relationshipIntents.lockPairInTx(tx, localUserId, peerUserId);
    await this.stateFeed.lockTargetsInTx(tx, [
      { peerDomain: remote.domain, namespaceId: remote.namespaceId! },
    ]);
    clientFeedUpdates.push(
      ...(await this.relationships.writeLocalP2PIntentInTx(
        tx,
        localUserId,
        peerUserId,
        wantsFriend,
        note,
      )),
    );
    const current = (
      await this.relationshipIntents.readP2PRelationshipInTx(
        tx,
        localUserId,
        peerUserId,
      )
    ).firstIntent;
    if (!current) throw new Error('friend request write disappeared');
    const relationship: PeerStateFeedWrite = {
      peerDomain: remote.domain,
      namespaceId: remote.namespaceId!,
      account: local.account,
      domain: this.config.domain,
      subjectAccount: remote.account,
      subjectDomain: remote.domain,
      eventType: 'RELATIONSHIP_INTENT',
      body: {
        status: current.status,
        profileRev: current.profileRev,
        note: current.note,
        requestedAt: current.requestedAt,
        expiresAt: current.expiresAt,
      },
    };
    return relationship.body.status === 'ACCEPTED'
      ? this.stateFeed.writeAcceptanceConfirmationsInTx(tx, [relationship])
      : this.stateFeed.writeManyInTx(tx, [relationship]);
  }

  async writeAddressedRelationshipRequestInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    remote: { account: string; domain: string; namespaceId: number },
    state: {
      requestedAt: Date;
      expiresAt: Date;
      note: string;
      snapshot: FederatedPendingProfileSnapshot;
    },
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const local = await tx.query.account.findFirst({
      where: and(
        eq(tables.account.id, localUserId),
        eq(tables.account.domain, 'local'),
      ),
      columns: { account: true },
    });
    if (!local) throw new Error('invalid local friend requester');
    if (remote.domain === this.config.domain)
      throw new Error('addressed federated request targets the local domain');
    await lockBusinessAccountsInTx(tx, [
      { account: local.account, domain: 'local' },
      { account: normalizeAccount(remote.account), domain: remote.domain },
    ]);
    const remoteUserId = {
      account: remote.account,
      domain: remote.domain,
      namespaceId: remote.namespaceId,
    };
    await this.relationshipIntents.lockPairInTx(tx, localUserId, remoteUserId);
    await this.stateFeed.lockTargetsInTx(tx, [
      { peerDomain: remote.domain, namespaceId: remote.namespaceId },
    ]);
    clientFeedUpdates.push(
      ...(await this.relationships.writeLocalP2PIntentInTx(
        tx,
        localUserId,
        remoteUserId,
        true,
        state.note,
        state.snapshot,
      )),
    );
    const current = (
      await this.relationshipIntents.readP2PRelationshipInTx(
        tx,
        localUserId,
        remoteUserId,
      )
    ).firstIntent;
    if (!current) throw new Error('addressed friend request write disappeared');
    return this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain: remote.domain,
        namespaceId: remote.namespaceId,
        account: local.account,
        domain: this.config.domain,
        subjectAccount: normalizeAccount(remote.account),
        subjectDomain: remote.domain,
        eventType: 'RELATIONSHIP_INTENT',
        body: {
          status: current.status,
          profileRev: current.profileRev,
          note: current.note,
          requestedAt: current.requestedAt,
          expiresAt: current.expiresAt,
        },
      },
    ]);
  }

  /**
   * Acquires the GROUP business aggregate lock and the canonical dependent row
   * locks before the caller re-reads mutable command state.
   */
  async lockGroupMutationInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: AccountTarget,
    projectionUserIds: readonly number[] = [],
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
    });
  }

  async writeGroupRequestEffectsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    groupId: number,
    memberUserId: AccountTarget,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
    status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' = 'REQUESTED',
    direction: 'APPLICATION' | 'INVITATION' = 'APPLICATION',
    createIfMissing = true,
    managerUserId?: number,
  ): Promise<void> {
    await this.groupRequestProjection.writeEffectsInTx(
      tx,
      threadId,
      groupId,
      memberUserId,
      clientFeedUpdates,
      status,
      direction,
      createIfMissing,
      managerUserId,
    );
  }

  async reconcileGroupJoinRequestManagerInTx(
    tx: DatabaseTransaction,
    threadId: number,
    managerUserId: number,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<void> {
    await this.groupRequestProjection.reconcileManagerInTx(
      tx,
      threadId,
      managerUserId,
      clientFeedUpdates,
    );
  }
}
