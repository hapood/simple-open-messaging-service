import type { FederationLocalSystemMessage } from './federation-local-system-message-publisher.service.js';
import { groupStateSql } from '../group/shared/group-state.js';
import {
  groupState as groupStateTable,
  groupStateFields,
} from '../group/shared/group-state.js';
import { Injectable, Logger } from '@nestjs/common';
import { captureThreadStateUpdatesInTx } from '../client-state-feed/capture-thread-state-updates.js';

import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { acquireThreadContentLockInTx } from '../common/locks/thread-content-lock.js';
import type { FederationThreadAddress } from './federation-message-feed.service.js';
import {
  ProfileLookup,
  type ProfilePrefetchDemand,
} from '../profile-resolution/profile-resolution-demand.js';
import {
  type FederationStateEventType,
  isFederationStateEventType,
} from './federation-state-event.js';
import { FEDERATION_THREAD_SEQUENCE_MAX } from './federation-thread-round.constants.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';
import { ReceivedUserIntentService } from '../user/p2p-intent/received/received-user-intent.service.js';
import { RemoteMemberMembershipIntentService } from '../group/membership-intent/received/remote-member-membership-intent.service.js';
import { MirrorGroupMembershipIntentService } from '../group/membership-intent/received/mirror-group-membership-intent.service.js';
import { mergeMirrorGroupMetaTargetInTx } from '../group/meta/merge-mirror-meta-target-in-tx.js';
import {
  InvalidReceivedIntentError,
  validateReceivedIntentBody,
  type ReceivedIntentBodyShape,
} from '../group/membership-intent/received/received-membership-body.js';

class PermanentFederationItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentFederationItemError';
  }
}

export interface StatePageEffect {
  clientFeedUpdates: PendingClientStateFeedUpdate[];
  statePushNamespaces: number[];
  localSystemMessages: FederationLocalSystemMessage[];
  threadRoundWakes: Array<{
    threadId: number;
    peerDomain: string;
    namespaceId: number;
    direction: 'forward' | 'both' | 'meta';
  }>;
  profileDemands: ProfilePrefetchDemand[];
}

export type StatePageApplyResult = StatePageEffect;

/** Applies validated peer State Feed pages inside the pull worker's transaction. */
@Injectable()
export class FederationStateFeedConsumerService {
  private readonly logger = new Logger(FederationStateFeedConsumerService.name);

  constructor(
    private readonly receivedUserIntents: ReceivedUserIntentService,
    private readonly remoteMemberIntents: RemoteMemberMembershipIntentService,
    private readonly mirrorGroupIntents: MirrorGroupMembershipIntentService,
  ) {}

  /** Shared body assembly for a RELATIONSHIP_INTENT item; the field shapes
   * are envelope-validated before this runs. */
  private receivedBodyOf(body: {
    status?: unknown;
    messageEndSeq?: unknown;
    tombstoneEndSeq?: unknown;
    namespaceId?: unknown;
    profileRev?: unknown;
    note?: unknown;
    requestedAt?: unknown;
    expiresAt?: unknown;
  }): ReceivedIntentBodyShape {
    // The envelope checks above pinned every field's wire type; these casts
    // only restate them.
    return {
      status: body.status as 'REQUESTED' | 'ACCEPTED' | 'REVOKED',
      // State-feed body.namespaceId is the wire profile-subject namespace;
      // the authenticated feed namespace remains the publisher namespace.
      profileNamespaceId: Number(body.namespaceId),
      profileRev: Number(body.profileRev),
      note: body.note as string,
      requestedAt: body.requestedAt as number | null,
      expiresAt: body.expiresAt as number | null,
      ...(body.messageEndSeq === undefined
        ? {}
        : { messageEndSeq: Number(body.messageEndSeq) }),
      ...(body.tombstoneEndSeq === undefined
        ? {}
        : { tombstoneEndSeq: Number(body.tombstoneEndSeq) }),
    };
  }

  async applyPageInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    page: PeerStateFeedPage,
  ): Promise<StatePageApplyResult> {
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const statePushNamespaces: number[] = [];
    const localSystemMessages: StatePageEffect['localSystemMessages'] = [];
    const threadRoundWakes: StatePageEffect['threadRoundWakes'] = [];
    const profileDemands: StatePageEffect['profileDemands'] = [];
    // Relationship state creates the authorized group shell before a group-meta revision is applied.
    const applyPriority: Record<FederationStateEventType, number> = {
      RELATIONSHIP_INTENT: 0,
      THREAD_CONTENT_HEAD: 1,
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
      const statePushLength = statePushNamespaces.length;
      const systemMessageLength = localSystemMessages.length;
      const threadRoundWakeLength = threadRoundWakes.length;
      const profileDemandLength = profileDemands.length;
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
            namespaceId?: unknown;
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
            !Number.isSafeInteger(body.namespaceId) ||
            Number(body.namespaceId) < 0 ||
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
                  'namespaceId',
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
          // An expired REQUESTED is an ineffective input, not a transition:
          // the applier routes it to a no-op and the cursor still advances.
          const receivedBody = this.receivedBodyOf(body);
          if (validateReceivedIntentBody(receivedBody) === undefined) continue;
          const [localUser] = await tx
            .select({
              id: tables.account.id,
              account: tables.account.account,
            })
            .from(tables.account)
            .where(
              and(
                eq(tables.account.account, normalizeAccount(item.peerAccount)),
                eq(tables.account.namespaceId, 0),
              ),
            )
            .limit(1);
          if (!localUser)
            throw new PermanentFederationItemError(
              'user relationship local subject does not exist',
            );
          const peers = new Set<number>();
          let effect: { routed: string; threadId?: number };
          try {
            effect = await this.receivedUserIntents.applyInTx(
              tx,
              {
                localUserId: localUser.id,
                peer: {
                  account: normalizeAccount(item.account),
                  domain: peerDomain,
                  namespaceId,
                },
                body: receivedBody,
              },
              clientFeedUpdates,
              peers,
            );
          } catch (error) {
            if (error instanceof InvalidReceivedIntentError)
              throw new PermanentFederationItemError(error.message);
            throw error;
          }
          statePushNamespaces.push(...peers);
          if (body.status !== 'REVOKED' && Number(body.profileRev) > 0) {
            profileDemands.push({
              publisherNamespaceId: namespaceId,
              lookup: ProfileLookup.ACCOUNT_PROFILE,
              target: {
                profileNamespaceId: Number(body.namespaceId),
                account: normalizeAccount(item.account),
                rev: Number(body.profileRev),
              },
            });
          }
          if (effect.threadId !== undefined) {
            threadRoundWakes.push({
              threadId: effect.threadId,
              peerDomain,
              namespaceId,
              direction: 'both',
            });
          }
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
            namespaceId?: unknown;
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
            !Number.isSafeInteger(body.namespaceId) ||
            Number(body.namespaceId) < 0 ||
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
                  'namespaceId',
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
          // An expired REQUESTED is an ineffective input, not a transition:
          // the applier routes it to a no-op and the cursor still advances.
          const receivedBody = this.receivedBodyOf(body);
          if (validateReceivedIntentBody(receivedBody) === undefined) continue;
          const peers = new Set<number>();
          let effect: { routed: string; threadId?: number };
          try {
            if (inviteDirection) {
              // The peer group operates on our member: the mirror applier.
              effect = await this.mirrorGroupIntents.applyInTx(
                tx,
                {
                  group: {
                    account: normalizeAccount(item.account),
                    domain: peerDomain,
                    namespaceId,
                  },
                  memberAccount: normalizeAccount(item.peerAccount),
                  body: receivedBody,
                },
                clientFeedUpdates,
                peers,
              );
            } else {
              // Our group receives a remote member's intent: the origin applier.
              const [groupState] = await tx
                .select({ id: groupStateTable.id })
                .from(groupStateTable)
                .where(
                  and(
                    eq(
                      groupStateFields.account,
                      normalizeAccount(item.peerAccount),
                    ),
                    eq(groupStateFields.namespaceId, 0),
                  ),
                )
                .limit(1);
              if (!groupState)
                throw new PermanentFederationItemError(
                  'group relationship has no local group placeholder',
                );
              effect = await this.remoteMemberIntents.applyInTx(
                tx,
                {
                  threadId: groupState.id,
                  member: {
                    account: normalizeAccount(item.account),
                    domain: peerDomain,
                    namespaceId,
                  },
                  body: receivedBody,
                },
                clientFeedUpdates,
                peers,
              );
              if (body.status !== 'REVOKED' && Number(body.profileRev) > 0) {
                profileDemands.push({
                  publisherNamespaceId: namespaceId,
                  lookup: ProfileLookup.ACCOUNT_PROFILE,
                  target: {
                    profileNamespaceId: Number(body.namespaceId),
                    account: normalizeAccount(item.account),
                    rev: Number(body.profileRev),
                  },
                });
              }
            }
          } catch (error) {
            if (error instanceof InvalidReceivedIntentError)
              throw new PermanentFederationItemError(error.message);
            throw error;
          }
          statePushNamespaces.push(...peers);
          if (inviteDirection && Number(body.profileRev) > 0) {
            profileDemands.push({
              publisherNamespaceId: namespaceId,
              lookup: ProfileLookup.ACCOUNT_PROFILE,
              target: {
                profileNamespaceId: Number(body.namespaceId),
                account: normalizeAccount(item.account),
                rev: Number(body.profileRev),
              },
            });
          }
          if (effect.threadId !== undefined) {
            threadRoundWakes.push({
              threadId: effect.threadId,
              peerDomain,
              namespaceId,
              direction: 'both',
            });
          }
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
          // The authoritative group's meta coordinate shares this atomic head
          // with its message and tombstone query coordinates.
          const groupMetaFeedEndId = body.groupMetaFeedEndId;
          if (groupMetaFeedEndId !== undefined && !item.account.startsWith('!'))
            throw new PermanentFederationItemError(
              'invalid THREAD_CONTENT_HEAD key for a Group Meta coordinate',
            );
          if (groupMetaFeedEndId !== undefined) {
            const merged = await mergeMirrorGroupMetaTargetInTx(tx, {
              group: {
                account: item.account,
                domain: peerDomain,
                publisherNamespaceId: namespaceId,
              },
              metaTargetId: Number(groupMetaFeedEndId),
            });
            if (merged)
              threadRoundWakes.push({
                threadId: merged.threadId,
                peerDomain,
                namespaceId,
                direction: 'meta',
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
              `authorized thread ${item.account}@${peerDomain} (${target.threadId}) has no initialized current-epoch synchronization state`,
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
        statePushNamespaces.length = statePushLength;
        localSystemMessages.length = systemMessageLength;
        threadRoundWakes.length = threadRoundWakeLength;
        profileDemands.length = profileDemandLength;
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
      statePushNamespaces,
      localSystemMessages,
      threadRoundWakes,
      profileDemands,
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
          AND pair."endpointAType" = 'USER'
          AND pair."endpointAAccount" = ${normalizeAccount(thread.peerAccount)}
          AND pair."endpointANamespaceId" = 0
          AND pair."endpointBType" = 'USER'
          AND pair."endpointBAccount" = ${normalizeAccount(thread.account)}
          AND pair."endpointBNamespaceId" = ${namespaceId}
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
          (group_user."namespaceId" = 0
            AND EXISTS (
              SELECT 1
              FROM "ThreadAudience" audience
              WHERE audience."threadId" = message_thread.id
                AND audience."targetNamespaceId" = ${namespaceId}
                AND audience."localUserId" IS NULL
            ))
          OR
          (group_user.domain = ${sourceDomain}
            AND group_user."namespaceId" = ${namespaceId}
            AND EXISTS (
              SELECT 1
              -- Retained participant history survives departure. Only an active
              -- local membership authorizes content synchronization; a pending
              -- reapplication must not block the later approval's feed page.
              FROM "RelationshipPair" membership
              WHERE membership."threadId" = message_thread.id
                AND membership.kind = 'GROUP_MEMBER'
                AND membership.active = true
                AND membership."endpointAType" = 'USER'
                AND membership."endpointANamespaceId" = 0
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
