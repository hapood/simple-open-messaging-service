import { Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import {
  applyFederatedPendingProfileSnapshot,
  InviteService,
  type FederatedPendingProfileSnapshot,
} from '../invite/invite.service.js';
import { RelationshipIntentService } from '../invite/relationship-intent.service.js';
import { upsertSourceUserInTx } from '../user/source-user.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationGroupRequestProjectionService } from './federation-group-request-projection.service.js';
import { FederationGroupRelationshipService } from './federation-group-relationship.service.js';
import { FederationProfileStatePublisher } from './federation-profile-state-publisher.service.js';
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
}

/**
 * Serializes and applies relationship commands. Transport wake-ups remain an
 * outer orchestration concern and occur only after the caller's transaction
 * commits.
 */
@Injectable()
export class FederationRelationshipCommandService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupRequestProjection: FederationGroupRequestProjectionService,
    private readonly invite: InviteService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly profiles: FederationProfileStatePublisher,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly groupRelationships: FederationGroupRelationshipService,
  ) {}

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
    const { publishGroupState = true, allowOwnerDeactivation } = options;
    await this.lockGroupMutationInTx(tx, threadId, memberUserId);
    const [thread] = await tx
      .select({ groupId: tables.messageThread.groupId })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!thread?.groupId) throw new Error('group join target is invalid');
    const [group, member] = await Promise.all([
      tx.query.group.findFirst({
        where: eq(tables.group.id, thread.groupId),
        columns: {
          account: true,
          domain: true,
          namespaceId: true,
          name: true,
          avatar: true,
          description: true,
          defaultProfileRev: true,
        },
      }),
      tx.query.user.findFirst({
        where: eq(tables.user.id, memberUserId),
        columns: { account: true, domain: true },
      }),
    ]);
    if (!group || !member || member.domain !== 'local')
      throw new Error('group join identities are invalid');
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
        ...(allowOwnerDeactivation ? { allowOwnerDeactivation: true } : {}),
      },
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
      if (status === 'REVOKED' && publishGroupState)
        return this.profiles.writeGroupStateInTx(
          tx,
          threadId,
          clientFeedUpdates,
        );
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
            requestedAt: membership.request.requestedAt,
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
              profileRev: group.defaultProfileRev,
            },
          },
        });
        if (feedId !== null)
          clientFeedUpdates.push({ userId: memberUserId, feedId });
      }
      if (
        !publishGroupState ||
        !membership.shouldBeActive ||
        !membership.pairChanged
      )
        return new Map();
      return this.profiles.writeGroupStateInTx(tx, threadId, clientFeedUpdates);
    }
    const relationship: PeerStateFeedWrite = {
      peerDomain: group.domain,
      namespaceId: group.namespaceId!,
      account: member.account,
      domain: this.config.domain,
      subjectAccount: group.account,
      subjectDomain: group.domain,
      eventType: 'RELATIONSHIP_INTENT',
      forceReindex: status === 'ACCEPTED',
      body: {
        status: membership.request.status,
        profileRev: membership.request.profileRev,
        note: membership.request.note,
        requestedAt: membership.request.requestedAt,
        expiresAt: membership.request.expiresAt,
      },
    };
    if (
      clientFeedUpdates &&
      membership.changed &&
      membership.request.status === 'REQUESTED'
    ) {
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
          status: 'REQUESTED',
          note: membership.request.note,
          requestedAt: membership.request.requestedAt,
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
            profileRev: group.defaultProfileRev,
          },
        },
      });
      if (feedId !== null)
        clientFeedUpdates.push({ userId: memberUserId, feedId });
    }
    if (membership.request.status === 'REVOKED') {
      return this.stateFeed.writeManyInTx(tx, [relationship]);
    }
    return this.writeIdentityRelationshipStateToPeerInTx(
      tx,
      memberUserId,
      relationship,
      membership.request.status === 'REQUESTED',
    );
  }

  async writeGroupRelationshipIntentInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    note: string,
    status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED',
    clientFeedUpdates: PendingClientStateFeedUpdate[],
    requestProjectionDirection?: 'APPLICATION' | 'INVITATION',
    options: GroupRelationshipMutationOptions = {},
  ): Promise<Map<string, bigint>> {
    const { publishGroupState = true, allowOwnerDeactivation } = options;
    await this.lockGroupMutationInTx(tx, threadId, memberUserId);
    const [state] = await tx
      .select({
        groupId: tables.group.id,
        groupAccount: tables.group.account,
        groupName: tables.group.name,
        groupAvatar: tables.group.avatar,
        groupDescription: tables.group.description,
        groupProfileRev: tables.group.defaultProfileRev,
        groupNamespaceId: tables.group.namespaceId,
      })
      .from(tables.messageThread)
      .innerJoin(
        tables.group,
        eq(tables.group.id, tables.messageThread.groupId),
      )
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!state?.groupId) throw new Error('group invite target is invalid');
    const member = await tx.query.user.findFirst({
      where: eq(tables.user.id, memberUserId),
      columns: { account: true, domain: true, namespaceId: true },
    });
    if (!member) throw new Error('group invite identity is invalid');
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
        ...(allowOwnerDeactivation ? { allowOwnerDeactivation: true } : {}),
      },
    );
    if (membership.active) {
      if (membership.pairChanged)
        await tx
          .update(tables.group)
          .set({ updatedAt: new Date() })
          .where(eq(tables.group.id, state.groupId));
      if (member.domain === 'local')
        await tx
          .insert(tables.threadAudience)
          .values({
            targetDomain: 'local',
            localUserId: memberUserId,
            threadId,
          })
          .onConflictDoNothing();
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
      const endpoints = groupIntentEndpoints(
        state.groupAccount,
        member.account,
        'GROUP',
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
        clientFeedUpdates.push({ userId: memberUserId, feedId });
      return publishGroupState &&
        (membership.shouldBeActive || status === 'REVOKED')
        ? this.profiles.writeGroupStateInTx(tx, threadId, clientFeedUpdates)
        : new Map();
    }
    const relationship: PeerStateFeedWrite = {
      peerDomain: member.domain,
      namespaceId: member.namespaceId!,
      account: state.groupAccount,
      domain: this.config.domain,
      subjectAccount: member.account,
      subjectDomain: member.domain,
      eventType: 'RELATIONSHIP_INTENT',
      forceReindex: status === 'ACCEPTED',
      body: {
        status: membership.request.status,
        profileRev: membership.request.profileRev,
        note: membership.request.note,
        requestedAt: membership.request.requestedAt,
        expiresAt: membership.request.expiresAt,
      },
    };
    if (membership.request.status === 'REVOKED') {
      const intent = await this.stateFeed.writeManyInTx(tx, [relationship]);
      const cleanup = await this.profiles.cleanupGroupProjectionInTx(
        tx,
        threadId,
        state.groupId,
        state.groupAccount,
        member.domain,
        member.namespaceId!,
        clientFeedUpdates,
      );
      return new Map([...intent, ...cleanup]);
    }
    const identityState = await this.stateFeed.writeManyInTx(tx, [relationship]);
    if (membership.request.status === 'REQUESTED') return identityState;
    const groupState = await this.profiles.writeGroupStateInTx(
      tx,
      threadId,
      clientFeedUpdates,
    );
    return new Map([...identityState, ...groupState]);
  }

  async writeFriendIntentInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    peerUserId: number,
    wantsFriend: boolean,
    note: string,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
    forceConfirmationReindex = false,
  ): Promise<Map<string, bigint>> {
    const remote = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.id, peerUserId),
        ne(tables.user.domain, 'local'),
      ),
      columns: { account: true, domain: true, namespaceId: true },
    });
    const local = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.id, localUserId),
        eq(tables.user.domain, 'local'),
      ),
      columns: { account: true },
    });
    if (!remote || !local) throw new Error('invalid federated friend intent');
    clientFeedUpdates.push(
      ...(await this.invite.writeLocalFriendIntentInTx(
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
      forceReindex: forceConfirmationReindex && current.status === 'ACCEPTED',
      body: {
        status: current.status,
        profileRev: current.profileRev,
        note: current.note,
        requestedAt: current.requestedAt,
        expiresAt: current.expiresAt,
      },
    };
    if (current.status === 'REVOKED') {
      return this.stateFeed.writeManyInTx(tx, [relationship]);
    }
    return this.writeIdentityRelationshipStateToPeerInTx(
      tx,
      localUserId,
      relationship,
      true,
    );
  }

  async writeAddressedFriendRequestInTx(
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
    const local = await tx.query.user.findFirst({
      where: and(
        eq(tables.user.id, localUserId),
        eq(tables.user.domain, 'local'),
      ),
      columns: { account: true },
    });
    if (!local) throw new Error('invalid local friend requester');
    if (remote.domain === this.config.domain)
      throw new Error('addressed federated request targets the local domain');
    const remoteUserId = await this.materializeFederatedUserInTx(
      tx,
      remote.account,
      remote.domain,
      remote.namespaceId,
    );
    clientFeedUpdates.push(
      ...(await this.invite.writeLocalFriendIntentInTx(
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
    return this.writeIdentityRelationshipStateToPeerInTx(
      tx,
      localUserId,
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
      true,
    );
  }

  private async writeIdentityRelationshipStateToPeerInTx(
    tx: DatabaseTransaction,
    identityUserId: number,
    relationship: PeerStateFeedWrite,
    forceProfileReindex: boolean,
  ): Promise<Map<string, bigint>> {
    void identityUserId;
    void forceProfileReindex;
    return this.stateFeed.writeManyInTx(tx, [relationship]);
  }

  private async materializeFederatedUserInTx(
    tx: DatabaseTransaction,
    account: string,
    domain: string,
    namespaceId: number,
  ): Promise<number> {
    const normalized = normalizeAccount(account);
    if (normalized.startsWith('!'))
      throw new Error('group identity cannot be materialized as User');
    return upsertSourceUserInTx(tx, {
      account: normalized,
      domain,
      sourceDomain: domain,
      namespaceId,
      name: normalized,
      profileRev: 0,
    });
  }

  /**
   * Acquires the GROUP business aggregate lock and the canonical dependent row
   * locks before the caller re-reads mutable command state.
   */
  async lockGroupMutationInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    projectionUserIds: readonly number[] = [],
  ): Promise<void> {
    const [thread] = await tx
      .select({ groupId: tables.messageThread.groupId })
      .from(tables.messageThread)
      .where(eq(tables.messageThread.id, threadId))
      .limit(1);
    if (!thread?.groupId) throw new Error('group relationship thread missing');
    await this.relationshipIntents.lockGroupMutationInTx(tx, {
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
    memberUserId: number,
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
