import { FederationRelationshipTaskAdmission } from './federation-relationship-task-admission.service.js';
import type { FederationLocalSystemMessage } from './federation-local-system-message-publisher.service.js';
import { FederationReverseRevokeService } from './federation-reverse-revoke.service.js';
import { groupStateSql } from '../group/group-state.js';
import {
  groupState as groupStateTable,
  readGroupState,
  groupStateFields,
} from '../group/group-state.js';
import {
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../user/account-address.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { captureThreadStateUpdatesInTx } from '../client-state-feed/capture-thread-state-updates.js';

import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import {
  assertServerGroupCapacityInTx,
  SERVER_GROUP_FULL_REASON,
} from '../group/group-capacity.js';
import { readCurrentGroupRosterInTx } from '../group-meta/current-group-roster.js';
import { RelationshipService } from '../relationship/relationship.service.js';
import { acquireThreadContentLockInTx } from '../business/shared/locks/thread-content-lock.js';
import { RelationshipIntentService } from '../relationship/relationship-intent.service.js';
import { MessageService } from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationGroupRelationshipService } from './federation-group-relationship.service.js';
import { FederationGroupMetaTaskCoordinator } from './federation-group-meta-task-coordinator.service.js';
import type { FederationThreadAddress } from './federation-message-feed.service.js';
import { FederationRelationshipMutationService } from './federation-relationship-mutation.service.js';
import {
  type FederationStateEventType,
  isFederationStateEventType,
} from './federation-state-event.js';
import { FEDERATION_THREAD_SEQUENCE_MAX } from './federation-thread-round.constants.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import {
  PeerStateFeedService,
  type PeerStateFeedPage,
} from './peer-state-feed.service.js';

type GroupIntentWireStatus = 'REQUESTED' | 'ACCEPTED' | 'REVOKED';

function groupIntentStorageStatus(
  status: GroupIntentWireStatus,
): GroupIntentWireStatus {
  return status;
}

class PermanentFederationItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentFederationItemError';
  }
}

export interface StatePageEffect {
  clientFeedUpdates: PendingClientStateFeedUpdate[];
  statePushDomains: string[];
  localSystemMessages: FederationLocalSystemMessage[];
  threadRoundWakes: Array<{
    threadId: number;
    peerDomain: string;
    namespaceId: number;
    direction: 'forward' | 'both';
  }>;
  profileResolutions: Array<{
    userId: number;
    account: string;
    domain: string;
    rev: number;
  }>;
}

export type StatePageApplyResult = StatePageEffect;

/** Applies validated peer State Feed pages inside the pull worker's transaction. */
@Injectable()
export class FederationStateFeedConsumerService {
  @Inject(FederationReverseRevokeService)
  private readonly reverseRevokes!: FederationReverseRevokeService;

  @Inject(FederationRelationshipTaskAdmission)
  private readonly relationshipTasks!: FederationRelationshipTaskAdmission;

  private readonly config = loadFederationConfig();
  private readonly logger = new Logger(FederationStateFeedConsumerService.name);

  constructor(
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly relationships: RelationshipService,
    private readonly message: MessageService,
    private readonly relationshipMutations: FederationRelationshipMutationService,
    private readonly groupRelationships: FederationGroupRelationshipService,
    private readonly groupMetaTasks: FederationGroupMetaTaskCoordinator,
  ) {}

  /** Ensure an incoming federated group request has a structurally complete retained conversation.
   * RelationshipIntent remains the sole authorization source, and no client state entry is published
   * until the user accepts the request. */
  async ensureFederatedGroupRequestShellInTx(
    tx: DatabaseTransaction,
    groupAccount: string,
    groupDomain: string,
    namespaceId: number,
  ): Promise<{ groupId: number; threadId: number }> {
    const normalized = normalizeAccount(groupAccount);
    const normalizedDomain = groupDomain.trim().toLowerCase();
    await this.relationshipIntents.lockGroupBusinessScopeInTx(tx, {
      account: normalized,
      domain: normalizedDomain,
    });
    const existing = await readGroupState(
      tx,
      and(
        eq(groupStateFields.account, normalized),
        eq(groupStateFields.domain, normalizedDomain),
        eq(groupStateFields.namespaceId, namespaceId),
      ),
    );
    if (existing) return { groupId: existing.id, threadId: existing.id };
    const [thread] = await tx
      .insert(tables.messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupAccount: normalized,
        groupDomain: normalizedDomain,
        authorityNamespaceId: namespaceId,
        updatedAt: new Date(),
      })
      .returning({ id: tables.messageThread.id });
    return { groupId: thread.id, threadId: thread.id };
  }

  async applyPageInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    page: PeerStateFeedPage,
    execution: 'FEED' | 'TASK' = 'FEED',
  ): Promise<StatePageApplyResult> {
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const statePushDomains: string[] = [];
    const localSystemMessages: StatePageEffect['localSystemMessages'] = [];
    const threadRoundWakes: StatePageEffect['threadRoundWakes'] = [];
    const profileResolutions: StatePageEffect['profileResolutions'] = [];
    // Relationship state creates the authorized group shell before a group-meta revision is applied.
    const applyPriority: Record<FederationStateEventType, number> = {
      RELATIONSHIP_INTENT: 0,
      GROUP_META_FEED_HEAD: 1,
      THREAD_CONTENT_HEAD: 2,
    };
    const priorityOf = (eventType: unknown): number =>
      isFederationStateEventType(eventType)
        ? applyPriority[eventType]
        : Number.MAX_SAFE_INTEGER;
    for (const [itemIndex, item] of [...page.items]
      .sort((a, b) => priorityOf(a.eventType) - priorityOf(b.eventType))
      .entries()) {
      const savepoint = `federation_state_${itemIndex}`;
      const clientFeedUpdatesLength = clientFeedUpdates.length;
      const statePushLength = statePushDomains.length;
      const systemMessageLength = localSystemMessages.length;
      const threadRoundWakeLength = threadRoundWakes.length;
      const profileResolutionLength = profileResolutions.length;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
        const wireItem = item as unknown as Record<string, unknown>;
        if (!isFederationStateEventType(wireItem.eventType))
          throw new PermanentFederationItemError(
            'unknown state feed event type',
          );
        const allowedKeys = new Set([
          'account',
          'eventType',
          'feedId',
          'body',
          ...(item.eventType === 'RELATIONSHIP_INTENT' ||
          (item.eventType === 'THREAD_CONTENT_HEAD' &&
            !item.account.startsWith('!'))
            ? ['peerAccount']
            : []),
        ]);
        if (
          Object.keys(wireItem).length !== allowedKeys.size ||
          Object.keys(wireItem).some((key) => !allowedKeys.has(key))
        )
          throw new PermanentFederationItemError(
            'state feed item contains invalid fields',
          );
        if (!item.body || typeof item.body !== 'object')
          throw new PermanentFederationItemError('invalid state feed body');
        if (
          item.eventType === 'RELATIONSHIP_INTENT' &&
          !item.account.startsWith('!') &&
          !item.peerAccount?.startsWith('!')
        ) {
          const body = item.body as {
            status?: unknown;
            messageEndSeq?: unknown;
            tombstoneEndSeq?: unknown;
            profileRev?: unknown;
            note?: unknown;
            requestedAt?: unknown;
            expiresAt?: unknown;
          };
          if (
            !item.peerAccount ||
            !['REQUESTED', 'ACCEPTED', 'REVOKED'].includes(
              String(body.status),
            ) ||
            (body.status !== 'REVOKED' &&
              (!Number.isSafeInteger(body.messageEndSeq) ||
                Number(body.messageEndSeq) < 0 ||
                Number(body.messageEndSeq) > FEDERATION_THREAD_SEQUENCE_MAX ||
                !Number.isSafeInteger(body.tombstoneEndSeq) ||
                Number(body.tombstoneEndSeq) < 0 ||
                Number(body.tombstoneEndSeq) >
                  FEDERATION_THREAD_SEQUENCE_MAX)) ||
            !Number.isSafeInteger(body.profileRev) ||
            Number(body.profileRev) < 0 ||
            Number(body.profileRev) > 2_147_483_647 ||
            typeof body.note !== 'string' ||
            body.note.length > 255 ||
            (body.requestedAt !== null &&
              (!Number.isSafeInteger(body.requestedAt) ||
                Number(body.requestedAt) < 0)) ||
            (body.expiresAt !== null &&
              (!Number.isSafeInteger(body.expiresAt) ||
                Number(body.expiresAt) < 0)) ||
            (body.status === 'REQUESTED' &&
              (typeof body.requestedAt !== 'number' ||
                typeof body.expiresAt !== 'number')) ||
            (body.status === 'ACCEPTED' &&
              typeof body.requestedAt !== 'number') ||
            (body.status !== 'REQUESTED' && body.expiresAt !== null) ||
            Object.keys(body).some(
              (key) =>
                ![
                  'status',
                  'profileRev',
                  'messageEndSeq',
                  'tombstoneEndSeq',
                  'note',
                  'requestedAt',
                  'expiresAt',
                ].includes(key),
            )
          )
            throw new PermanentFederationItemError(
              'invalid user RELATIONSHIP_INTENT body',
            );
          const requestedAt =
            typeof body.requestedAt === 'number'
              ? new Date(body.requestedAt)
              : null;
          const expiresAt =
            typeof body.expiresAt === 'number'
              ? new Date(body.expiresAt)
              : null;
          if (
            (requestedAt && Number.isNaN(requestedAt.getTime())) ||
            (expiresAt && Number.isNaN(expiresAt.getTime())) ||
            (requestedAt !== null &&
              expiresAt !== null &&
              (expiresAt <= requestedAt ||
                expiresAt.getTime() - requestedAt.getTime() >
                  7 * 24 * 60 * 60 * 1000))
          )
            throw new PermanentFederationItemError(
              'invalid user relationship request timestamps',
            );
          // Expired requests are ineffective inputs, not revocations and not a new
          // relationship transition. Advancing the feed cursor is sufficient.
          if (
            body.status === 'REQUESTED' &&
            expiresAt !== null &&
            expiresAt <= new Date()
          )
            continue;
          if (
            execution === 'FEED' &&
            (await this.relationshipTasks.deferInTx(
              tx,
              peerDomain,
              namespaceId,
              item,
            ))
          )
            continue;
          const [localUser] = await tx
            .select({
              id: tables.account.id,
              account: tables.account.account,
              domain: tables.account.domain,
            })
            .from(tables.account)
            .where(
              and(
                eq(tables.account.account, normalizeAccount(item.peerAccount)),
                eq(tables.account.domain, 'local'),
                eq(tables.account.namespaceId, 0),
              ),
            )
            .limit(1);
          const remoteIdentity = {
            account: normalizeAccount(item.account),
            domain: peerDomain,
            namespaceId,
          };
          if (!localUser)
            throw new PermanentFederationItemError(
              'user relationship local subject does not exist',
            );
          if (body.status !== 'REVOKED' && Number(body.profileRev) > 0) {
            profileResolutions.push({
              userId: localUser.id,
              account: normalizeAccount(item.account),
              domain: peerDomain,
              rev: Number(body.profileRev),
            });
          }
          await this.relationshipIntents.lockPairInTx(
            tx,
            localUser.id,
            remoteIdentity,
          );
          await this.stateFeed.lockOutboundStateFeedNamespacesInTx(tx, [
            { peerDomain, namespaceId },
          ]);
          const effect = await this.relationships.applyRemoteP2PIntentInTx(tx, {
            localUserId: localUser.id,
            peerUserId: remoteIdentity,
            status:
              body.status === 'ACCEPTED'
                ? 'ACCEPTED'
                : body.status === 'REVOKED'
                  ? 'REVOKED'
                  : 'REQUESTED',
            messageEndSeq:
              body.status === 'REVOKED'
                ? undefined
                : Number(body.messageEndSeq),
            tombstoneEndSeq:
              body.status === 'REVOKED'
                ? undefined
                : Number(body.tombstoneEndSeq),
            profileRev: Number(body.profileRev),
            note: body.note,
            requestedAt,
            expiresAt,
            origin: peerDomain,
          });
          if (body.status === 'REVOKED' && effect.removed)
            await this.reverseRevokes.enqueueP2PInTx(
              tx,
              localUser,
              remoteIdentity,
            );
          if (effect.threadId !== undefined && body.status !== 'REVOKED') {
            threadRoundWakes.push({
              threadId: effect.threadId,
              peerDomain,
              namespaceId,
              direction: 'both',
            });
          }
          if (effect.localStateRevision !== undefined) {
            const localDirection = (
              await this.relationshipIntents.readP2PRelationshipInTx(
                tx,
                localUser.id,
                remoteIdentity,
              )
            ).firstIntent;
            if (!localDirection)
              throw new Error('local friend state disappeared');
            const confirmation =
              await this.stateFeed.writeAcceptanceConfirmationsInTx(tx, [
                {
                  peerDomain,
                  namespaceId,
                  account: localUser.account,
                  domain: this.config.domain,
                  subjectAccount: remoteIdentity.account,
                  subjectDomain: peerDomain,
                  eventType: 'RELATIONSHIP_INTENT',
                  body: {
                    status: localDirection.status,
                    profileRev: localDirection.profileRev,
                    note: localDirection.note,
                    requestedAt: localDirection.requestedAt,
                    expiresAt: localDirection.expiresAt,
                  },
                },
              ]);
            statePushDomains.push(...confirmation.keys());
          }
          void effect.requestCreated;
          clientFeedUpdates.push(...effect.clientFeedUpdates);
        } else if (
          item.eventType === 'RELATIONSHIP_INTENT' &&
          (item.account.startsWith('!') || item.peerAccount?.startsWith('!'))
        ) {
          const inviteDirection = item.account.startsWith('!');
          if (
            !item.peerAccount ||
            inviteDirection === item.peerAccount.startsWith('!')
          )
            throw new PermanentFederationItemError(
              'invalid group membership state key',
            );
          const body = item.body as {
            status?: unknown;
            messageEndSeq?: unknown;
            tombstoneEndSeq?: unknown;
            profileRev?: unknown;
            note?: unknown;
            requestedAt?: unknown;
            expiresAt?: unknown;
          };
          if (
            !['REQUESTED', 'ACCEPTED', 'REVOKED'].includes(
              String(body.status),
            ) ||
            (body.status !== 'REVOKED' &&
              (!Number.isSafeInteger(body.messageEndSeq) ||
                Number(body.messageEndSeq) < 0 ||
                Number(body.messageEndSeq) > FEDERATION_THREAD_SEQUENCE_MAX ||
                !Number.isSafeInteger(body.tombstoneEndSeq) ||
                Number(body.tombstoneEndSeq) < 0 ||
                Number(body.tombstoneEndSeq) >
                  FEDERATION_THREAD_SEQUENCE_MAX)) ||
            !Number.isSafeInteger(body.profileRev) ||
            Number(body.profileRev) < 0 ||
            Number(body.profileRev) > 2_147_483_647 ||
            typeof body.note !== 'string' ||
            body.note.length > 255 ||
            (body.requestedAt !== null &&
              (!Number.isSafeInteger(body.requestedAt) ||
                Number(body.requestedAt) < 0)) ||
            (body.expiresAt !== null &&
              (!Number.isSafeInteger(body.expiresAt) ||
                Number(body.expiresAt) < 0)) ||
            Object.keys(body).some(
              (key) =>
                ![
                  'status',
                  'profileRev',
                  'messageEndSeq',
                  'tombstoneEndSeq',
                  'note',
                  'requestedAt',
                  'expiresAt',
                ].includes(key),
            )
          )
            throw new PermanentFederationItemError(
              'invalid group membership state body',
            );
          const storageStatus = groupIntentStorageStatus(
            body.status as GroupIntentWireStatus,
          );
          const requestedAt =
            typeof body.requestedAt === 'number'
              ? new Date(body.requestedAt)
              : null;
          const expiresAt =
            typeof body.expiresAt === 'number'
              ? new Date(body.expiresAt)
              : null;
          if (
            (requestedAt !== null && Number.isNaN(requestedAt.getTime())) ||
            (expiresAt !== null && Number.isNaN(expiresAt.getTime())) ||
            (storageStatus === 'REQUESTED' &&
              (!requestedAt ||
                !expiresAt ||
                expiresAt <= requestedAt ||
                expiresAt.getTime() - requestedAt.getTime() >
                  7 * 24 * 60 * 60 * 1000)) ||
            (storageStatus === 'ACCEPTED' && requestedAt === null) ||
            (storageStatus !== 'REQUESTED' && expiresAt !== null)
          )
            throw new PermanentFederationItemError(
              'invalid group membership request timestamps',
            );
          // A delayed or replayed request that has already expired is a no-op.
          // Only an explicit REVOKED fact may drive revocation projections.
          if (
            storageStatus === 'REQUESTED' &&
            expiresAt !== null &&
            expiresAt <= new Date()
          )
            continue;
          if (
            execution === 'FEED' &&
            (await this.relationshipTasks.deferInTx(
              tx,
              peerDomain,
              namespaceId,
              item,
            ))
          )
            continue;
          if (inviteDirection && storageStatus === 'REQUESTED') {
            const [localMember] = await tx
              .select({
                id: tables.account.id,
                account: tables.account.account,
              })
              .from(tables.account)
              .where(
                and(
                  eq(
                    tables.account.account,
                    normalizeAccount(item.peerAccount),
                  ),
                  eq(tables.account.domain, 'local'),
                  eq(tables.account.namespaceId, 0),
                  eq(tables.account.availability, 'AVAILABLE'),
                ),
              )
              .limit(1);
            if (!localMember)
              throw new PermanentFederationItemError(
                'group relationship local subject does not exist',
              );
            const groupAccount = normalizeAccount(item.account);
            const shell = await this.ensureFederatedGroupRequestShellInTx(
              tx,
              groupAccount,
              peerDomain,
              namespaceId,
            );
            const membership =
              await this.relationshipIntents.applyRemoteGroupIntentInTx(tx, {
                groupId: shell.groupId,
                memberUserId: localMember.id,
                threadId: shell.threadId,
                author: 'GROUP',
                status: storageStatus,
                messageEndSeq:
                  body.status === 'REVOKED'
                    ? undefined
                    : Number(body.messageEndSeq),
                tombstoneEndSeq:
                  body.status === 'REVOKED'
                    ? undefined
                    : Number(body.tombstoneEndSeq),
                profileRev: Number(body.profileRev),
                note: body.note,
                requestedAt,
                expiresAt,
              });
            await this.stateFeed.lockOutboundStateFeedNamespacesInTx(tx, [
              { peerDomain, namespaceId },
            ]);
            if (membership.shouldBeActive) {
              await this.groupRelationships.syncActiveInTx(tx, {
                threadId: shell.threadId,
                groupId: shell.groupId,
                memberUserId: localMember.id,
                active: true,
                hostedLocally: false,
              });
              if (membership.publishAccepted) {
                const confirmation =
                  await this.relationshipMutations.writeMemberRelationshipIntentInTx(
                    tx,
                    shell.threadId,
                    localMember.id,
                    'ACCEPTED',
                    clientFeedUpdates,
                  );
                statePushDomains.push(...confirmation.keys());
              }
              threadRoundWakes.push({
                threadId: shell.threadId,
                peerDomain,
                namespaceId,
                direction: 'both',
              });
            }
            if (Number(body.profileRev) > 0) {
              profileResolutions.push({
                userId: localMember.id,
                account: groupAccount,
                domain: peerDomain,
                rev: Number(body.profileRev),
              });
            }
            const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
              userId: localMember.id,
              namespaceId,
              account: groupAccount,
              domain: peerDomain,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: localMember.account,
              subjectDomain: 'local',
              body: {
                status: body.status,
                note: body.note,
                requestedAt: body.requestedAt,
                expiresAt: body.expiresAt,
                threadId: shell.threadId,
                group: {
                  account: groupAccount,
                  domain: peerDomain,
                  isLocal: false,
                  name: groupAccount,
                  avatar: '',
                  description: '',
                  profileRev: Number(body.profileRev),
                },
              },
            });
            if (clientFeedId !== null)
              clientFeedUpdates.push({
                userId: localMember.id,
                feedId: clientFeedId,
              });
            continue;
          }
          const [groupState] = await tx
            .select({
              id: groupStateTable.id,
              account: groupStateFields.account,
              name: groupStateFields.name,
              avatar: groupStateFields.avatar,
              description: groupStateFields.description,
              profileRev: groupStateFields.profileRev,
            })
            .from(groupStateTable)
            .where(
              and(
                eq(
                  groupStateFields.account,
                  normalizeAccount(
                    inviteDirection ? item.account : item.peerAccount,
                  ),
                ),
                inviteDirection
                  ? eq(groupStateFields.domain, peerDomain)
                  : eq(groupStateFields.domain, 'local'),
                inviteDirection
                  ? eq(groupStateFields.namespaceId, namespaceId)
                  : eq(groupStateFields.namespaceId, 0),
              ),
            )
            .limit(1);
          const memberAddress = {
            account: normalizeAccount(
              inviteDirection ? item.peerAccount : item.account,
            ),
            domain: inviteDirection ? 'local' : peerDomain,
            namespaceId: inviteDirection ? 0 : namespaceId,
          };
          const [localMember] = inviteDirection
            ? await localAccountsForTargetsInTx(tx, [memberAddress])
            : [];
          const member: { id: AccountTarget } | undefined = inviteDirection
            ? localMember
              ? { id: localMember.id }
              : undefined
            : { id: memberAddress };
          if (!groupState || !member)
            throw new PermanentFederationItemError(
              'group relationship has no local group placeholder',
            );
          const relationshipThread = await tx.query.messageThread.findFirst({
            where: eq(tables.messageThread.id, groupState.id),
            columns: { id: true },
          });
          if (!relationshipThread)
            throw new PermanentFederationItemError(
              'group relationship placeholder thread is missing',
            );
          const membership =
            await this.relationshipIntents.applyRemoteGroupIntentInTx(tx, {
              groupId: groupState.id,
              memberUserId: member.id,
              threadId: relationshipThread.id,
              author: inviteDirection ? 'GROUP' : 'MEMBER',
              status: storageStatus,
              messageEndSeq:
                body.status === 'REVOKED'
                  ? undefined
                  : Number(body.messageEndSeq),
              tombstoneEndSeq:
                body.status === 'REVOKED'
                  ? undefined
                  : Number(body.tombstoneEndSeq),
              profileRev: Number(body.profileRev),
              note: body.note,
              requestedAt,
              expiresAt,
            });
          if (storageStatus === 'REVOKED' && membership.wasActive)
            await this.reverseRevokes.enqueueGroupInTx(tx, {
              threadId: relationshipThread.id,
              group: {
                account: groupState.account,
                domain: inviteDirection ? peerDomain : 'local',
              },
              memberUserId: member.id,
              author: inviteDirection ? 'MEMBER' : 'GROUP',
            });
          // The group mutation has acquired its business scope. Reserve the peer
          // allocator before request projections or system messages touch Account;
          // activation/confirmation can publish peer state later in this transaction.
          await this.stateFeed.lockOutboundStateFeedNamespacesInTx(tx, [
            { peerDomain, namespaceId },
          ]);
          if (
            !inviteDirection &&
            storageStatus !== 'REVOKED' &&
            Number(body.profileRev) > 0
          ) {
            const managers = (
              await readCurrentGroupRosterInTx(tx, groupState.id)
            ).filter(
              (candidate) =>
                candidate.domain === 'local' &&
                (candidate.role === GroupRole.OWNER ||
                  candidate.role === GroupRole.ADMIN),
            );
            for (const manager of await localAccountsForTargetsInTx(
              tx,
              managers,
            )) {
              profileResolutions.push({
                userId: manager.id,
                account: normalizeAccount(item.account),
                domain: peerDomain,
                rev: Number(body.profileRev),
              });
            }
          }
          if (!inviteDirection && membership.changed) {
            const originThread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.id, groupState.id),
              columns: { id: true },
            });
            if (!originThread) throw new Error('origin group thread missing');
            await this.relationshipMutations.writeGroupRequestEffectsInTx(
              tx,
              originThread.id,
              groupState.id,
              member.id,
              clientFeedUpdates,
              membership.shouldBeActive ? 'ACCEPTED' : storageStatus,
              storageStatus === 'ACCEPTED'
                ? inviteDirection
                  ? 'APPLICATION'
                  : 'INVITATION'
                : inviteDirection
                  ? 'INVITATION'
                  : 'APPLICATION',
              storageStatus === 'REQUESTED',
            );
          }
          if (inviteDirection && membership.shouldBeActive) {
            if (!localMember)
              throw new Error('local group invite recipient missing');
            const thread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.id, groupState.id),
              columns: { id: true },
            });
            if (!thread) throw new Error('group relationship thread missing');
            await this.groupRelationships.syncActiveInTx(tx, {
              threadId: thread.id,
              groupId: groupState.id,
              memberUserId: localMember.id,
              active: true,
              hostedLocally: false,
            });
            threadRoundWakes.push({
              threadId: thread.id,
              peerDomain,
              namespaceId,
              direction: 'both',
            });
            if (membership.publishAccepted) {
              const confirmation =
                await this.relationshipMutations.writeMemberRelationshipIntentInTx(
                  tx,
                  thread.id,
                  localMember.id,
                  'ACCEPTED',
                  clientFeedUpdates,
                );
              statePushDomains.push(...confirmation.keys());
            }
          }
          if (
            inviteDirection &&
            membership.changed &&
            storageStatus === 'REVOKED'
          ) {
            if (!localMember)
              throw new Error('local group invite recipient missing');
            const thread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.id, groupState.id),
              columns: { id: true },
            });
            if (!thread)
              throw new PermanentFederationItemError(
                'group relationship placeholder thread is missing',
              );
            if (membership.wasActive) {
              const boundary = await this.message.writeSystemMessageInTx(
                tx,
                thread.id,
                { type: SystemMessageType.GROUP_LEFT, member: localMember.id },
                {
                  threadLock: membership.threadLock,
                },
              );
              await tx
                .update(tables.accountThreadState)
                .set({
                  messageVisibleThroughSeq: boundary.message.seq,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(tables.accountThreadState.threadId, thread.id),
                    eq(tables.accountThreadState.accountId, localMember.id),
                  ),
                );
              localSystemMessages.push({
                threadId: thread.id,
                event: {
                  type: SystemMessageType.GROUP_LEFT,
                  member: localMember.id,
                },
                message: boundary.message,
              });
            }
            await this.groupRelationships.syncActiveInTx(tx, {
              threadId: thread.id,
              groupId: groupState.id,
              memberUserId: localMember.id,
              active: false,
              hostedLocally: false,
            });
          }
          if (inviteDirection && membership.changed) {
            if (!localMember)
              throw new Error('local group invite recipient missing');
            const thread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.id, groupState.id),
              columns: { id: true },
            });
            if (!thread)
              throw new PermanentFederationItemError(
                'group relationship placeholder thread is missing',
              );
            const threadId = thread.id;
            const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
              userId: localMember.id,
              namespaceId,
              account: groupState.account,
              domain: peerDomain,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: normalizeAccount(item.peerAccount),
              subjectDomain: 'local',
              body: {
                status: body.status,
                note: body.note,
                requestedAt: body.requestedAt,
                expiresAt: body.expiresAt,
                threadId,
                group: {
                  account: groupState.account,
                  domain: peerDomain,
                  isLocal: false,
                  name: groupState.name,
                  avatar: groupState.avatar,
                  description: groupState.description,
                  profileRev: groupState.profileRev,
                },
              },
            });
            if (clientFeedId !== null)
              clientFeedUpdates.push({
                userId: localMember.id,
                feedId: clientFeedId,
              });
          }
          if (
            !inviteDirection &&
            storageStatus === 'ACCEPTED' &&
            !membership.shouldBeActive
          ) {
            const originThread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.id, groupState.id),
              columns: { id: true },
            });
            if (!originThread) throw new Error('origin group thread missing');
            const rejection =
              await this.relationshipMutations.writeGroupRelationshipIntentInTx(
                tx,
                originThread.id,
                member.id,
                '',
                'REVOKED',
                clientFeedUpdates,
              );
            statePushDomains.push(...rejection.keys());
            this.logger.debug(
              `Rejected unsupported federated group acceptance for ${item.account}@${peerDomain}`,
            );
            continue;
          }
          if (
            !inviteDirection &&
            membership.changed &&
            membership.shouldBeActive
          ) {
            const [originThread] = await tx
              .select({
                id: tables.messageThread.id,
              })
              .from(tables.messageThread)
              .where(eq(tables.messageThread.id, groupState.id))
              .for('no key update')
              .limit(1);
            if (!originThread) throw new Error('origin group thread missing');
            try {
              await assertServerGroupCapacityInTx(
                tx,
                originThread.id,
                member.id,
              );
            } catch (error) {
              if (
                !(error instanceof BusinessException) ||
                error.bizCode !== BusinessCode.GROUP_FULL
              )
                throw error;

              // Capacity is an origin-server policy, not a federation protocol
              // constant. Reject the request using the existing authoritative
              // membership state so older peers converge without learning about
              // this server's numerical limit.
              const rejection =
                await this.relationshipMutations.writeGroupRelationshipIntentInTx(
                  tx,
                  originThread.id,
                  member.id,
                  SERVER_GROUP_FULL_REASON,
                  'REVOKED',
                  clientFeedUpdates,
                );
              statePushDomains.push(...rejection.keys());
              this.logger.warn(
                `Rejected federated group join for ${item.peerAccount}@${peerDomain}: origin group is full`,
              );
              continue;
            }
            // The origin may still consider this member active when a mirror
            // compacts an unobserved leave followed immediately by a rejoin.
            // Re-emit the authoritative roster for every new member-authored revision even
            // when the pair itself needs no transition, otherwise that mirror
            // would wait forever for confirmation.
            await this.groupRelationships.syncActiveInTx(tx, {
              threadId: originThread.id,
              groupId: groupState.id,
              memberUserId: member.id,
              active: true,
              hostedLocally: true,
            });
            localSystemMessages.push({
              threadId: originThread.id,
              event: {
                type: SystemMessageType.GROUP_JOINED,
                member: member.id,
              },
            });
            const confirmation =
              await this.relationshipMutations.writeGroupRelationshipIntentInTx(
                tx,
                originThread.id,
                member.id,
                '',
                'ACCEPTED',
                clientFeedUpdates,
              );
            statePushDomains.push(...confirmation.keys());
          } else if (
            !inviteDirection &&
            membership.changed &&
            storageStatus === 'REVOKED'
          ) {
            const originThread = relationshipThread;
            if (!originThread) throw new Error('origin group thread missing');
            // A rejected or otherwise pending applicant may revoke their authored
            // request while the relationship pair is already inactive. The request
            // projection was updated above; only an active member departure changes
            // the roster and produces a GROUP_LEFT boundary.
            const deactivation =
              await this.groupRelationships.deactivateAfterInTx(tx, {
                threadId: originThread.id,
                groupId: groupState.id,
                memberUserId: member.id,
                hostedLocally: true,
                afterPairDeactivated: async () => {
                  const boundary = await this.message.writeSystemMessageInTx(
                    tx,
                    originThread.id,
                    { type: SystemMessageType.GROUP_LEFT, member: member.id },
                    {
                      threadLock: membership.threadLock,
                    },
                  );
                  return { boundary };
                },
              });
            if (!deactivation.pairChanged || !deactivation.effect) continue;
            const { boundary } = deactivation.effect;
            localSystemMessages.push({
              threadId: originThread.id,
              event: { type: SystemMessageType.GROUP_LEFT, member: member.id },
              message: boundary.message,
            });
            await tx
              .update(tables.messageThread)
              .set({
                updatedAt: new Date(),
              })
              .where(eq(tables.messageThread.id, groupState.id));
          }
        } else if (item.eventType === 'GROUP_META_FEED_HEAD') {
          if (!item.account.startsWith('!'))
            throw new PermanentFederationItemError(
              'invalid GROUP_META_FEED_HEAD key',
            );
          const groupMetaFeedEndId = (
            item.body as { groupMetaFeedEndId?: unknown }
          ).groupMetaFeedEndId;
          if (
            typeof groupMetaFeedEndId !== 'string' ||
            !/^(0|[1-9]\d*)$/.test(groupMetaFeedEndId)
          )
            throw new PermanentFederationItemError(
              'invalid GROUP_META_FEED_HEAD body',
            );
          const [mirror] = await tx
            .select({ groupId: groupStateTable.id })
            .from(groupStateTable)
            .where(
              and(
                eq(groupStateFields.account, item.account),
                eq(groupStateFields.domain, peerDomain),
                eq(groupStateFields.namespaceId, namespaceId),
              ),
            )
            .limit(1);
          if (!mirror) continue;
          await this.groupMetaTasks.ensureInTx(tx, {
            groupId: mirror.groupId,
            groupAccount: item.account,
            peerDomain,
            namespaceId,
            through: BigInt(groupMetaFeedEndId),
          });
        } else if (item.eventType === 'THREAD_CONTENT_HEAD') {
          const body = item.body as {
            messageEndSeq?: unknown;
            tombstoneEndSeq?: unknown;
            groupMetaFeedEndId?: unknown;
          };
          if (
            !Number.isSafeInteger(body.messageEndSeq) ||
            Number(body.messageEndSeq) < 0 ||
            Number(body.messageEndSeq) > FEDERATION_THREAD_SEQUENCE_MAX ||
            !Number.isSafeInteger(body.tombstoneEndSeq) ||
            Number(body.tombstoneEndSeq) < 0 ||
            Number(body.tombstoneEndSeq) > FEDERATION_THREAD_SEQUENCE_MAX
          )
            throw new PermanentFederationItemError(
              'invalid THREAD_CONTENT_HEAD body',
            );
          // The meta head rides group-authored heads only. Its presence makes
          // this item also a meta-sync trigger, like the legacy
          // GROUP_META_FEED_HEAD item it retires.
          const groupMetaFeedEndId = body.groupMetaFeedEndId;
          if (groupMetaFeedEndId !== undefined && !item.account.startsWith('!'))
            throw new PermanentFederationItemError(
              'invalid THREAD_CONTENT_HEAD key for a meta head',
            );
          if (
            groupMetaFeedEndId !== undefined &&
            (typeof groupMetaFeedEndId !== 'string' ||
              !/^(0|[1-9]\d*)$/.test(groupMetaFeedEndId))
          )
            throw new PermanentFederationItemError(
              'invalid THREAD_CONTENT_HEAD body',
            );
          if (typeof groupMetaFeedEndId === 'string') {
            const [mirror] = await tx
              .select({ groupId: groupStateTable.id })
              .from(groupStateTable)
              .where(
                and(
                  eq(groupStateFields.account, item.account),
                  eq(groupStateFields.domain, peerDomain),
                  eq(groupStateFields.namespaceId, namespaceId),
                ),
              )
              .limit(1);
            if (mirror)
              await this.groupMetaTasks.ensureInTx(tx, {
                groupId: mirror.groupId,
                groupAccount: item.account,
                peerDomain,
                namespaceId,
                through: BigInt(groupMetaFeedEndId),
              });
          }
          let threadAddress: FederationThreadAddress;
          if (item.account.startsWith('!')) {
            if (item.peerAccount !== undefined)
              throw new PermanentFederationItemError(
                'invalid THREAD_CONTENT_HEAD key',
              );
            threadAddress = { account: item.account };
          } else {
            if (typeof item.peerAccount !== 'string' || !item.peerAccount)
              throw new PermanentFederationItemError(
                'invalid THREAD_CONTENT_HEAD key',
              );
            threadAddress = {
              account: item.account,
              peerAccount: item.peerAccount,
            };
          }
          let target = await this.resolveStateFeedTargetInTransaction(
            tx,
            peerDomain,
            namespaceId,
            threadAddress,
          );
          if (target === null) continue;
          const threadLock = await acquireThreadContentLockInTx(
            tx,
            target.threadId,
          );
          if (!threadLock) continue;
          target = await this.resolveStateFeedTargetInTransaction(
            tx,
            peerDomain,
            namespaceId,
            threadAddress,
          );
          if (target === null || target.threadId !== threadLock.threadId)
            continue;
          const updated =
            await FederationThreadSyncStateService.updateThreadHeadInTx(tx, {
              threadId: target.threadId,
              namespaceId,
              messageTargetSeq: Number(body.messageEndSeq),
              deletionTargetSeq: Number(body.tombstoneEndSeq),
              threadLock,
            });
          if (!updated) {
            throw new Error(
              'authorized thread has no initialized current-epoch synchronization state',
            );
          }
          threadRoundWakes.push({
            threadId: target.threadId,
            peerDomain,
            namespaceId,
            direction: 'forward',
          });
        } else
          throw new PermanentFederationItemError(
            'unknown state feed event type',
          );
      } catch (error) {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
        clientFeedUpdates.length = clientFeedUpdatesLength;
        statePushDomains.length = statePushLength;
        localSystemMessages.length = systemMessageLength;
        threadRoundWakes.length = threadRoundWakeLength;
        profileResolutions.length = profileResolutionLength;
        if (!(error instanceof PermanentFederationItemError)) throw error;
        this.logger.error(
          `ignored invalid state-feed item from ${peerDomain} at ${item.feedId}: ${error.message}`,
        );
      } finally {
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      }
    }
    clientFeedUpdates.push(
      ...(await captureThreadStateUpdatesInTx(
        tx,
        clientFeedUpdates.map(({ userId }) => userId),
      )),
    );
    return {
      clientFeedUpdates,
      statePushDomains,
      localSystemMessages,
      threadRoundWakes,
      profileResolutions,
    };
  }

  private async resolveStateFeedTargetInTransaction(
    tx: DatabaseTransaction,
    sourceDomain: string,
    namespaceId: number,
    thread: FederationThreadAddress,
  ): Promise<{ threadId: number; reverseEnabled: boolean } | null> {
    if ('peerAccount' in thread) {
      const result = await tx.execute<{ threadId: number }>(sql`
        SELECT pair."threadId"
        FROM "RelationshipPair" pair
        JOIN "MessageThread" message_thread
          ON message_thread.id = pair."threadId"
        WHERE pair.kind = 'P2P'
          AND pair.active = true
          AND message_thread."federationRoundsEnabled" = true
          AND pair."threadId" IS NOT NULL
          AND (pair."endpointANamespaceId" = ${namespaceId}
            OR pair."endpointBNamespaceId" = ${namespaceId})
          AND (((pair."endpointAAccount", pair."endpointADomain") =
                (${normalizeAccount(thread.peerAccount)}, 'local')
                AND (pair."endpointBAccount", pair."endpointBDomain") =
                (${normalizeAccount(thread.account)}, ${sourceDomain}))
            OR ((pair."endpointBAccount", pair."endpointBDomain") =
                (${normalizeAccount(thread.peerAccount)}, 'local')
                AND (pair."endpointAAccount", pair."endpointADomain") =
                (${normalizeAccount(thread.account)}, ${sourceDomain})))
        LIMIT 1
      `);
      const threadId = result.rows[0]?.threadId;
      return threadId === undefined ? null : { threadId, reverseEnabled: true };
    }
    const result = await tx.execute<{
      threadId: number;
      groupDomain: string;
    }>(sql`
      SELECT message_thread.id AS "threadId",
             group_user.domain AS "groupDomain"
      FROM "MessageThread" message_thread
      JOIN ${groupStateSql} group_user ON group_user.id = message_thread.id
      WHERE message_thread.type = 'GROUP'
        AND message_thread."federationRoundsEnabled" = true
        AND group_user.account = ${normalizeAccount(thread.account)}
        AND (
          (group_user.domain = 'local'
            AND group_user."namespaceId" = 0
            AND EXISTS (
              SELECT 1
              FROM "ThreadAudience" audience
              WHERE audience."threadId" = message_thread.id
                AND audience."targetDomain" = ${sourceDomain}
                AND audience."targetNamespaceId" = ${namespaceId}
                AND audience."localUserId" IS NULL
            ))
          OR
          (group_user.domain = ${sourceDomain}
            AND group_user."namespaceId" = ${namespaceId}
            AND EXISTS (
              SELECT 1
              FROM "AccountThreadState" local_state
              WHERE local_state."threadId" = message_thread.id
            ))
        )
      LIMIT 1
    `);
    const resolved = result.rows[0];
    return resolved
      ? {
          threadId: resolved.threadId,
          reverseEnabled: resolved.groupDomain === sourceDomain,
        }
      : null;
  }
}
