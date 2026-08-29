import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { and, count, eq, gt, lt, ne, or, sql } from 'drizzle-orm';
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
import { InviteService } from '../invite/invite.service.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
import { RelationshipIntentService } from '../invite/relationship-intent.service.js';
import {
  MessageService,
  type PublicMessage,
} from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { ensureLocalThreadParticipantInTx } from '../thread-participant/local-thread-participant.js';
import { UploadService } from '../upload/upload.service.js';
import { upsertSourceUserInTx } from '../user/source-user.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from './federation-audience.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationGroupRelationshipService } from './federation-group-relationship.service.js';
import { FederationGroupRosterProjectionService } from './federation-group-roster-projection.service.js';
import type { FederationThreadAddress } from './federation-message-feed.service.js';
import { FederationProfileStatePublisher } from './federation-profile-state-publisher.service.js';
import { FederationRelationshipCommandService } from './federation-relationship-command.service.js';
import { FEDERATION_THREAD_SEQUENCE_MAX } from './federation-thread-round.constants.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import type { GroupMetaFeedPage } from './group-meta-feed.service.js';
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
  localSystemMessages: Array<{
    actorUserId: number;
    threadId: number;
    type: SystemMessageType;
    subjectUserId?: number;
    message?: PublicMessage;
    recipientUserIds?: number[];
  }>;
  threadRoundWakes: Array<{
    threadId: number;
    peerDomain: string;
    namespaceId: number;
    direction: 'forward' | 'both';
  }>;
}

/** Applies validated peer State Feed pages inside the pull worker's transaction. */
@Injectable()
export class FederationStateFeedConsumerService {
  private readonly config = loadFederationConfig();
  private readonly logger = new Logger(FederationStateFeedConsumerService.name);

  constructor(
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly upload: UploadService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly invite: InviteService,
    private readonly message: MessageService,
    private readonly relationshipCommands: FederationRelationshipCommandService,
    private readonly groupRelationships: FederationGroupRelationshipService,
    private readonly profileStatePublisher: FederationProfileStatePublisher,
    private readonly groupRosterProjection: FederationGroupRosterProjectionService,
  ) {}

  /** Materialize a stable address-derived identity shell. PROFILE is ordered after the confirming
   * ACCEPTED, so the initial row intentionally contains placeholders and is filled by a later
   * verified PROFILE item in the same or a subsequent drain. */
  async materializeFederatedUserInTx(
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
    let groupState = await tx.query.group.findFirst({
      where: and(
        eq(tables.group.account, normalized),
        eq(tables.group.domain, normalizedDomain),
        eq(tables.group.namespaceId, namespaceId),
      ),
      columns: { id: true },
    });
    if (!groupState) {
      [groupState] = await tx
        .insert(tables.group)
        .values({
          account: normalized,
          domain: normalizedDomain,
          namespaceId,
          name: normalized,
          updatedAt: new Date(),
        })
        .returning({ id: tables.group.id });
    }
    let thread = await tx.query.messageThread.findFirst({
      where: eq(tables.messageThread.groupId, groupState.id),
      columns: { id: true },
    });
    if (!thread) {
      const [created] = await tx
        .insert(tables.messageThread)
        .values({
          type: MessageThreadType.GROUP,
          groupId: groupState.id,
          updatedAt: new Date(),
        })
        .returning({ id: tables.messageThread.id });
      thread = created;
    }
    return { groupId: groupState.id, threadId: thread.id };
  }

  async applyPageInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    page: PeerStateFeedPage,
    groupMetaPages: ReadonlyMap<string, GroupMetaFeedPage> = new Map(),
  ): Promise<StatePageEffect> {
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const statePushDomains: string[] = [];
    const localSystemMessages: StatePageEffect['localSystemMessages'] = [];
    const threadRoundWakes: StatePageEffect['threadRoundWakes'] = [];
    // Relationship state creates the authorized group shell before a group-meta revision is applied.
    // PROFILE then hydrates identity, and the group-meta pull materializes the complete member closure.
    const applyPriority = {
      RELATIONSHIP_INTENT: 0,
      PROFILE: 1,
      GROUP_META_FEED_HEAD: 2,
      THREAD_CONTENT_HEAD: 3,
    } as const;
    for (const [itemIndex, item] of [...page.items]
      .sort((a, b) => applyPriority[a.eventType] - applyPriority[b.eventType])
      .entries()) {
      const savepoint = `federation_state_${itemIndex}`;
      const clientFeedUpdatesLength = clientFeedUpdates.length;
      const statePushLength = statePushDomains.length;
      const systemMessageLength = localSystemMessages.length;
      const threadRoundWakeLength = threadRoundWakes.length;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
        const wireItem = item as unknown as Record<string, unknown>;
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
        if (item.eventType === 'PROFILE') {
          const body = item.body as {
            profileRev?: unknown;
            displayName?: unknown;
            bio?: unknown;
            avatar?: unknown;
          };
          if (
            !Number.isInteger(body.profileRev) ||
            Number(body.profileRev) < 0 ||
            Number(body.profileRev) > 2_147_483_647 ||
            typeof body.displayName !== 'string' ||
            typeof body.bio !== 'string'
          )
            throw new PermanentFederationItemError('invalid PROFILE body');
          const revision = Number(body.profileRev);
          const isGroupProfile = item.account.startsWith('!');
          const currentProfile = isGroupProfile
            ? await tx.query.group.findFirst({
                where: and(
                  eq(tables.group.account, normalizeAccount(item.account)),
                  eq(tables.group.domain, peerDomain),
                  eq(tables.group.namespaceId, namespaceId),
                ),
                columns: { id: true, profileRev: true },
              })
            : await tx.query.user.findFirst({
                where: and(
                  eq(tables.user.account, normalizeAccount(item.account)),
                  eq(tables.user.domain, peerDomain),
                  eq(tables.user.sourceDomain, peerDomain),
                  eq(tables.user.namespaceId, namespaceId),
                ),
                columns: { id: true, profileRev: true },
              });
          const currentRevision = currentProfile?.profileRev;
          if (currentRevision !== undefined && currentRevision >= revision)
            continue;
          const pendingRequests = await tx
            .select({
              localUserId: tables.federatedFriendRequest.localUserId,
              note: tables.federatedFriendRequest.note,
              requestedAt: tables.federatedFriendRequest.requestedAt,
              expiresAt: tables.federatedFriendRequest.expiresAt,
            })
            .from(tables.federatedFriendRequest)
            .where(
              and(
                eq(tables.federatedFriendRequest.remoteAccount, item.account),
                eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                eq(tables.federatedFriendRequest.namespaceId, namespaceId),
                eq(tables.federatedFriendRequest.direction, 'INCOMING'),
                eq(tables.federatedFriendRequest.status, 'REQUESTED'),
              ),
            );
          // A PROFILE is a dependent snapshot, never an unsolicited discovery mechanism. A human
          // profile without either an already-materialized identity or a preceding request is ignored.
          if (!currentProfile && pendingRequests.length === 0) continue;
          let avatar: string | null = null;
          if (body.avatar !== null) {
            const wire = body.avatar as {
              digest?: unknown;
              mimeType?: unknown;
              base64?: unknown;
              width?: unknown;
              height?: unknown;
            };
            if (
              !wire ||
              typeof wire.digest !== 'string' ||
              !/^[a-f0-9]{64}$/.test(wire.digest) ||
              typeof wire.mimeType !== 'string' ||
              typeof wire.base64 !== 'string' ||
              !Number.isSafeInteger(wire.width) ||
              Number(wire.width) < 1 ||
              !Number.isSafeInteger(wire.height) ||
              Number(wire.height) < 1
            )
              throw new PermanentFederationItemError('invalid PROFILE avatar');
            const bytes = Buffer.from(wire.base64, 'base64');
            if (
              bytes.toString('base64') !== wire.base64 ||
              createHash('sha256').update(bytes).digest('hex') !== wire.digest
            )
              throw new PermanentFederationItemError(
                'PROFILE avatar digest mismatch',
              );
            avatar = await this.upload.saveAvatarFromWire({
              b64: wire.base64,
              w: Number(wire.width),
              h: Number(wire.height),
            });
          }
          let profileUserId: number | null = null;
          if (isGroupProfile) {
            if (!currentProfile) continue;
            await tx
              .update(tables.group)
              .set({
                name: body.displayName,
                description: body.bio,
                avatar: avatar ?? '',
                profileRev: revision,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(tables.group.id, currentProfile.id),
                  lt(tables.group.profileRev, revision),
                ),
              );
          } else {
            profileUserId = await upsertSourceUserInTx(tx, {
              account: item.account,
              domain: peerDomain,
              sourceDomain: peerDomain,
              namespaceId,
              name: body.displayName,
              avatar,
              bio: body.bio,
              profileRev: revision,
            });
          }
          if (pendingRequests.length > 0 && !item.account.startsWith('!')) {
            await tx
              .update(tables.federatedFriendRequest)
              .set({
                displayName: body.displayName,
                avatar,
                profileRevision: revision,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(tables.federatedFriendRequest.remoteAccount, item.account),
                  eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                  eq(tables.federatedFriendRequest.namespaceId, namespaceId),
                  eq(tables.federatedFriendRequest.direction, 'INCOMING'),
                  eq(tables.federatedFriendRequest.status, 'REQUESTED'),
                ),
              );
            for (const pending of pendingRequests) {
              const localUser = await tx.query.user.findFirst({
                where: eq(tables.user.id, pending.localUserId),
                columns: { account: true, domain: true },
              });
              if (!localUser) continue;
              const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
                userId: pending.localUserId,
                namespaceId,
                account: normalizeAccount(item.account),
                domain: peerDomain,
                eventType: 'RELATIONSHIP_INTENT',
                subjectAccount: localUser.account,
                subjectDomain: localUser.domain,
                body: {
                  status: 'REQUESTED',
                  note: pending.note,
                  requestedAt: pending.requestedAt?.getTime() ?? null,
                  expiresAt: pending.expiresAt?.getTime() ?? null,
                  direction: 'INCOMING',
                  localThreadId: null,
                  peer: {
                    id: 0,
                    account: normalizeAccount(item.account),
                    name: body.displayName,
                    avatar: avatar ?? '',
                    domain: peerDomain,
                  },
                },
              });
              if (clientFeedId !== null)
                clientFeedUpdates.push({
                  userId: pending.localUserId,
                  feedId: clientFeedId,
                });
            }
          }
          if (isGroupProfile && pendingRequests.length > 0) {
            for (const pending of pendingRequests) {
              const feedId = await this.clientStateFeed.writeInTx(tx, {
                userId: pending.localUserId,
                namespaceId,
                account: normalizeAccount(item.account),
                domain: peerDomain,
                eventType: 'PROFILE',
                subjectAccount: '',
                subjectDomain: 'local',
                body: {
                  profileRev: revision,
                  displayName: body.displayName,
                  bio: body.bio,
                  avatar: avatar ?? null,
                },
              });
              if (feedId !== null)
                clientFeedUpdates.push({
                  userId: pending.localUserId,
                  feedId,
                });
            }
          }
          if (profileUserId === null) continue;
          const consumerCandidates = await tx.execute<{
            userId: number;
            threadId: number;
          }>(sql`
          SELECT DISTINCT local_participant."accountId" AS "userId",
            foreign_member."threadId"
          FROM "ThreadMember" foreign_member
          JOIN "ThreadParticipant" local_participant
            ON local_participant."threadId" = foreign_member."threadId"
          WHERE foreign_member."userId" = ${profileUserId}
        `);
          const consumers = (
            await Promise.all(
              consumerCandidates.rows.map(async (candidate) => ({
                ...candidate,
                authorized:
                  (await isThreadMutuallyAuthorized(
                    tx,
                    profileUserId,
                    candidate.threadId,
                  )) &&
                  (await isThreadMutuallyAuthorized(
                    tx,
                    candidate.userId,
                    candidate.threadId,
                  )),
              })),
            )
          ).filter((candidate) => candidate.authorized);
          clientFeedUpdates.push(
            ...(await this.clientStateFeed.recordProfileStateInTx(
              tx,
              profileUserId,
              consumers.map((row) => row.userId),
            )),
          );
          const published = await this.publishGroupMemberProfileInTx(
            tx,
            profileUserId,
            clientFeedUpdates,
          );
          statePushDomains.push(...published.keys());
        } else if (
          item.eventType === 'RELATIONSHIP_INTENT' &&
          !item.account.startsWith('!') &&
          !item.peerAccount?.startsWith('!')
        ) {
          const body = item.body as {
            status?: unknown;
            note?: unknown;
            requestedAt?: unknown;
            expiresAt?: unknown;
          };
          if (
            !item.peerAccount ||
            !['REQUESTED', 'ACCEPTED', 'REVOKED'].includes(
              String(body.status),
            ) ||
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
                !['status', 'note', 'requestedAt', 'expiresAt'].includes(key),
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
          const [localUser] = await tx
            .select({
              id: tables.user.id,
              account: tables.user.account,
              name: tables.user.name,
              avatar: tables.user.avatar,
              domain: tables.user.domain,
            })
            .from(tables.user)
            .where(
              and(
                eq(tables.user.account, normalizeAccount(item.peerAccount)),
                eq(tables.user.domain, 'local'),
                eq(tables.user.namespaceId, 0),
              ),
            )
            .limit(1);
          let [remoteUser] = await tx
            .select({
              id: tables.user.id,
              account: tables.user.account,
              name: tables.user.name,
              avatar: tables.user.avatar,
              profileRev: tables.user.profileRev,
            })
            .from(tables.user)
            .where(
              and(
                eq(tables.user.account, normalizeAccount(item.account)),
                eq(tables.user.domain, peerDomain),
                eq(tables.user.namespaceId, namespaceId),
                ne(tables.user.domain, 'local'),
              ),
            )
            .limit(1);
          if (!localUser)
            throw new PermanentFederationItemError(
              'user relationship local subject does not exist',
            );
          // Pending federation requests are keyed by immutable Address even when
          // this server happens to have materialized the same remote account for
          // another relationship. Stub existence must not switch persistence to
          // the local numeric-id RelationshipIntent path.
          if (body.status === 'REQUESTED') {
            const pendingName =
              remoteUser?.name ?? normalizeAccount(item.account);
            const pendingAvatar = remoteUser?.avatar ?? null;
            const pendingProfileRevision = remoteUser?.profileRev ?? 0;
            const applied = await tx.execute(sql`
            INSERT INTO "FederatedFriendRequest" (
              "localUserId", "remoteAccount", "remoteDomain", "namespaceId", direction, status,
              note, "requestedAt", "expiresAt", "displayName", avatar,
              "profileRevision", "updatedAt"
            ) VALUES (
              ${localUser.id}, ${normalizeAccount(item.account)}, ${peerDomain}, ${namespaceId},
              'INCOMING', 'REQUESTED', ${body.note}, ${requestedAt},
              ${expiresAt}, ${pendingName}, ${pendingAvatar}, ${pendingProfileRevision},
              CURRENT_TIMESTAMP
            )
            ON CONFLICT ("localUserId", "namespaceId", "remoteAccount", direction)
            DO UPDATE SET status = 'REQUESTED', note = EXCLUDED.note,
              "requestedAt" = EXCLUDED."requestedAt",
              "expiresAt" = EXCLUDED."expiresAt", "displayName" = EXCLUDED."displayName",
              avatar = EXCLUDED.avatar, "profileRevision" = EXCLUDED."profileRevision",
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "FederatedFriendRequest".status IS DISTINCT FROM EXCLUDED.status
               OR "FederatedFriendRequest".note IS DISTINCT FROM EXCLUDED.note
               OR "FederatedFriendRequest"."requestedAt" IS DISTINCT FROM EXCLUDED."requestedAt"
               OR "FederatedFriendRequest"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
            RETURNING 1
          `);
            if (applied.rows[0]) {
              const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
                userId: localUser.id,
                namespaceId,
                account: normalizeAccount(item.account),
                domain: peerDomain,
                eventType: 'RELATIONSHIP_INTENT',
                subjectAccount: localUser.account,
                subjectDomain: localUser.domain,
                body: {
                  status: 'REQUESTED',
                  note: body.note,
                  requestedAt: requestedAt?.getTime() ?? null,
                  expiresAt: expiresAt?.getTime() ?? null,
                  direction: 'INCOMING',
                  localThreadId: null,
                  peer: {
                    id: 0,
                    account: normalizeAccount(item.account),
                    name: pendingName,
                    avatar: pendingAvatar ?? '',
                    domain: peerDomain,
                  },
                },
              });
              if (clientFeedId !== null)
                clientFeedUpdates.push({
                  userId: localUser.id,
                  feedId: clientFeedId,
                });
            }
            const [crossed] = await tx
              .update(tables.federatedFriendRequest)
              .set({
                status: 'ACCEPTED',
                expiresAt: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(tables.federatedFriendRequest.localUserId, localUser.id),
                  eq(
                    tables.federatedFriendRequest.remoteAccount,
                    normalizeAccount(item.account),
                  ),
                  eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                  eq(tables.federatedFriendRequest.namespaceId, namespaceId),
                  eq(tables.federatedFriendRequest.direction, 'OUTGOING'),
                  eq(tables.federatedFriendRequest.status, 'REQUESTED'),
                  gt(tables.federatedFriendRequest.expiresAt, new Date()),
                ),
              )
              .returning({
                note: tables.federatedFriendRequest.note,
                requestedAt: tables.federatedFriendRequest.requestedAt,
              });
            if (crossed) {
              const confirmation = await this.stateFeed.writeManyInTx(tx, [
                {
                  peerDomain,
                  namespaceId,
                  account: localUser.account,
                  domain: this.config.domain,
                  subjectAccount: normalizeAccount(item.account),
                  subjectDomain: peerDomain,
                  eventType: 'RELATIONSHIP_INTENT',
                  forceReindex: true,
                  body: {
                    status: 'ACCEPTED',
                    note: crossed.note,
                    requestedAt: crossed.requestedAt,
                    expiresAt: null,
                  },
                },
              ]);
              statePushDomains.push(...confirmation.keys());
            }
            if (!remoteUser) continue;
            const localDirection = (
              await this.relationshipIntents.readP2PRelationshipInTx(
                tx,
                localUser.id,
                remoteUser.id,
              )
            ).firstIntent;
            // A request with no matching local direction remains address-only.
            // A crossed or already-confirmed pair continues into the shared
            // numeric-id state machine below so promotion and pair activation
            // commit atomically.
            if (!localDirection) continue;
          }
          if (body.status === 'REVOKED') {
            const revoked = await tx.execute<{
              displayName: string | null;
              avatar: string | null;
            }>(sql`
            UPDATE "FederatedFriendRequest"
            SET status = 'REVOKED', "requestedAt" = NULL,
              "expiresAt" = NULL, note = ${body.note}, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "localUserId" = ${localUser.id}
              AND "remoteDomain" = ${peerDomain}
              AND "namespaceId" = ${namespaceId}
              AND "remoteAccount" = ${normalizeAccount(item.account)}
              AND direction = 'INCOMING'
            RETURNING "displayName", avatar
          `);
            if (revoked.rows[0]) {
              const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
                userId: localUser.id,
                namespaceId,
                account: normalizeAccount(item.account),
                domain: peerDomain,
                eventType: 'RELATIONSHIP_INTENT',
                subjectAccount: localUser.account,
                subjectDomain: localUser.domain,
                body: {
                  status: 'REVOKED',
                  note: body.note,
                  requestedAt: null,
                  expiresAt: null,
                  direction: 'INCOMING',
                  localThreadId: null,
                  peer: {
                    id: 0,
                    account: normalizeAccount(item.account),
                    name:
                      revoked.rows[0].displayName ??
                      normalizeAccount(item.account),
                    avatar: revoked.rows[0].avatar ?? '',
                    domain: peerDomain,
                  },
                },
              });
              if (clientFeedId !== null)
                clientFeedUpdates.push({
                  userId: localUser.id,
                  feedId: clientFeedId,
                });
              continue;
            }
            // Without a materialized peer there is no established friendship
            // state for this intent to revoke. A stale/no-op address revocation
            // is complete here.
            if (!remoteUser) continue;
          }
          let addressedOutgoing:
            | typeof tables.federatedFriendRequest.$inferSelect
            | undefined;
          if (body.status === 'ACCEPTED') {
            if (!remoteUser) {
              addressedOutgoing =
                await tx.query.federatedFriendRequest.findFirst({
                  where: and(
                    eq(tables.federatedFriendRequest.localUserId, localUser.id),
                    eq(
                      tables.federatedFriendRequest.remoteAccount,
                      normalizeAccount(item.account),
                    ),
                    eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                    eq(tables.federatedFriendRequest.namespaceId, namespaceId),
                    eq(tables.federatedFriendRequest.direction, 'OUTGOING'),
                    or(
                      eq(tables.federatedFriendRequest.status, 'ACCEPTED'),
                      and(
                        eq(tables.federatedFriendRequest.status, 'REQUESTED'),
                        gt(tables.federatedFriendRequest.expiresAt, new Date()),
                      ),
                    ),
                  ),
                });
              if (!addressedOutgoing) continue;
            }
          }
          if (!remoteUser && body.status === 'ACCEPTED') {
            const remoteUserId = await this.materializeFederatedUserInTx(
              tx,
              item.account,
              peerDomain,
              namespaceId,
            );
            remoteUser = {
              id: remoteUserId,
              account: normalizeAccount(item.account),
              name: normalizeAccount(item.account),
              avatar: '',
              profileRev: 0,
            };
            if (addressedOutgoing!.status === 'ACCEPTED') {
              const incoming = await tx.query.federatedFriendRequest.findFirst({
                where: and(
                  eq(tables.federatedFriendRequest.localUserId, localUser.id),
                  eq(
                    tables.federatedFriendRequest.remoteAccount,
                    normalizeAccount(item.account),
                  ),
                  eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                  eq(tables.federatedFriendRequest.namespaceId, namespaceId),
                  eq(tables.federatedFriendRequest.direction, 'INCOMING'),
                  eq(tables.federatedFriendRequest.status, 'REQUESTED'),
                ),
              });
              if (incoming)
                await this.relationshipIntents.applyRemoteP2PIntentInTx(tx, {
                  authorUserId: remoteUser.id,
                  subjectUserId: localUser.id,
                  threadId: null,
                  status: 'REQUESTED',
                  note: incoming.note,
                  requestedAt: incoming.requestedAt,
                  expiresAt: incoming.expiresAt,
                });
            }
            await this.relationshipIntents.writeP2PAuthoredIntentInTx(tx, {
              authorUserId: localUser.id,
              subjectUserId: remoteUser.id,
              threadId: null,
              status: 'REQUESTED',
              note: addressedOutgoing!.note,
              expiresAt: addressedOutgoing!.expiresAt,
            });
          }
          if (!remoteUser)
            throw new PermanentFederationItemError(
              'user relationship arrived without PROFILE',
            );
          const effect = await this.invite.applyRemoteFriendIntentInTx(tx, {
            localUserId: localUser.id,
            peerUserId: remoteUser.id,
            status:
              body.status === 'ACCEPTED'
                ? 'ACCEPTED'
                : body.status === 'REVOKED'
                  ? 'REVOKED'
                  : 'REQUESTED',
            note: body.note,
            requestedAt,
            expiresAt,
            origin: peerDomain,
          });
          if (
            body.status === 'REQUESTED' ||
            (body.status === 'ACCEPTED' && effect.added === true)
          )
            await tx
              .delete(tables.federatedFriendRequest)
              .where(
                and(
                  eq(tables.federatedFriendRequest.localUserId, localUser.id),
                  eq(
                    tables.federatedFriendRequest.remoteAccount,
                    normalizeAccount(item.account),
                  ),
                  eq(tables.federatedFriendRequest.remoteDomain, peerDomain),
                  eq(tables.federatedFriendRequest.namespaceId, namespaceId),
                ),
              );
          if (effect.localStateRevision !== undefined) {
            const localDirection = (
              await this.relationshipIntents.readP2PRelationshipInTx(
                tx,
                localUser.id,
                remoteUser.id,
              )
            ).firstIntent;
            if (!localDirection)
              throw new Error('local friend state disappeared');
            const confirmation = await this.stateFeed.writeManyInTx(tx, [
              {
                peerDomain,
                namespaceId,
                account: localUser.account,
                domain: this.config.domain,
                subjectAccount: remoteUser.account,
                subjectDomain: peerDomain,
                eventType: 'RELATIONSHIP_INTENT',
                forceReindex: true,
                body: {
                  status: localDirection.status,
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
          if (effect.threadId !== undefined && effect.added === true) {
            localSystemMessages.push({
              actorUserId: localUser.id,
              threadId: effect.threadId,
              type: SystemMessageType.FRIEND_ADDED,
            });
          } else if (effect.threadId !== undefined && effect.removed === true) {
            const boundary = await this.message.writeSystemMessageInTx(
              tx,
              effect.threadId,
              SystemMessageType.FRIEND_REMOVED,
              remoteUser.id,
              {
                actorUserId: remoteUser.id,
                recipientUserIds: [localUser.id],
              },
            );
            await tx
              .update(tables.threadParticipant)
              .set({
                messageVisibleBeforeSeq: boundary.message.seq + 1,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(tables.threadParticipant.accountId, localUser.id),
                  eq(tables.threadParticipant.threadId, effect.threadId),
                ),
              );
            localSystemMessages.push({
              actorUserId: remoteUser.id,
              threadId: effect.threadId,
              type: SystemMessageType.FRIEND_REMOVED,
              subjectUserId: remoteUser.id,
              message: boundary.message,
              recipientUserIds: [localUser.id],
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
            note?: unknown;
            requestedAt?: unknown;
            expiresAt?: unknown;
          };
          if (
            !['REQUESTED', 'ACCEPTED', 'REVOKED'].includes(
              String(body.status),
            ) ||
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
                !['status', 'note', 'requestedAt', 'expiresAt'].includes(key),
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
          if (inviteDirection && storageStatus === 'REQUESTED') {
            const [localMember] = await tx
              .select({ id: tables.user.id, account: tables.user.account })
              .from(tables.user)
              .where(
                and(
                  eq(tables.user.account, normalizeAccount(item.peerAccount)),
                  eq(tables.user.domain, 'local'),
                  eq(tables.user.namespaceId, 0),
                  eq(tables.user.availability, 'AVAILABLE'),
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
            await this.relationshipIntents.applyRemoteGroupIntentInTx(tx, {
              groupId: shell.groupId,
              memberUserId: localMember.id,
              threadId: shell.threadId,
              author: 'GROUP',
              status: storageStatus,
              note: body.note,
              requestedAt,
              expiresAt,
            });
            await tx
              .insert(tables.federatedFriendRequest)
              .values({
                localUserId: localMember.id,
                remoteAccount: groupAccount,
                remoteDomain: peerDomain,
                namespaceId,
                direction: 'INCOMING',
                status: 'REQUESTED',
                note: body.note,
                requestedAt,
                expiresAt,
                displayName: groupAccount,
                avatar: null,
                profileRevision: 0,
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [
                  tables.federatedFriendRequest.localUserId,
                  tables.federatedFriendRequest.namespaceId,
                  tables.federatedFriendRequest.remoteAccount,
                  tables.federatedFriendRequest.direction,
                ],
                set: {
                  status: 'REQUESTED',
                  note: body.note,
                  requestedAt,
                  expiresAt,
                  updatedAt: new Date(),
                },
              });
            const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
              userId: localMember.id,
              namespaceId,
              account: groupAccount,
              domain: peerDomain,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: localMember.account,
              subjectDomain: this.config.domain,
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
                  profileRev: 0,
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
              id: tables.group.id,
              account: tables.group.account,
              name: tables.group.name,
              avatar: tables.group.avatar,
              description: tables.group.description,
              profileRev: tables.group.profileRev,
            })
            .from(tables.group)
            .where(
              and(
                eq(
                  tables.group.account,
                  normalizeAccount(
                    inviteDirection ? item.account : item.peerAccount,
                  ),
                ),
                inviteDirection
                  ? eq(tables.group.domain, peerDomain)
                  : eq(tables.group.domain, 'local'),
                inviteDirection
                  ? eq(tables.group.namespaceId, namespaceId)
                  : eq(tables.group.namespaceId, 0),
              ),
            )
            .limit(1);
          let [member] = await tx
            .select({ id: tables.user.id })
            .from(tables.user)
            .where(
              and(
                eq(
                  tables.user.account,
                  normalizeAccount(
                    inviteDirection ? item.peerAccount : item.account,
                  ),
                ),
                inviteDirection
                  ? eq(tables.user.domain, 'local')
                  : eq(tables.user.domain, peerDomain),
                inviteDirection
                  ? eq(tables.user.sourceDomain, 'local')
                  : eq(tables.user.sourceDomain, peerDomain),
                inviteDirection
                  ? eq(tables.user.namespaceId, 0)
                  : eq(tables.user.namespaceId, namespaceId),
                eq(tables.user.availability, 'AVAILABLE'),
              ),
            )
            .limit(1);
          if (!member && !inviteDirection) {
            const memberUserId = await this.materializeFederatedUserInTx(
              tx,
              item.account,
              peerDomain,
              namespaceId,
            );
            member = { id: memberUserId };
          }
          if (!groupState || !member)
            throw new PermanentFederationItemError(
              'group relationship has no local group placeholder',
            );
          const relationshipThread = await tx.query.messageThread.findFirst({
            where: eq(tables.messageThread.groupId, groupState.id),
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
              note: body.note,
              requestedAt,
              expiresAt,
            });
          if (!inviteDirection && membership.changed) {
            const originThread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.groupId, groupState.id),
              columns: { id: true },
            });
            if (!originThread) throw new Error('origin group thread missing');
            await this.relationshipCommands.writeGroupRequestEffectsInTx(
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
            const thread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.groupId, groupState.id),
              columns: { id: true },
            });
            if (!thread) throw new Error('group relationship thread missing');
            await this.groupRelationships.syncActiveInTx(tx, {
              threadId: thread.id,
              groupId: groupState.id,
              memberUserId: member.id,
              active: true,
              hostedLocally: false,
            });
            if (membership.publishAccepted) {
              const confirmation =
                await this.relationshipCommands.writeMemberRelationshipIntentInTx(
                  tx,
                  thread.id,
                  member.id,
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
            const thread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.groupId, groupState.id),
              columns: { id: true },
            });
            if (!thread)
              throw new PermanentFederationItemError(
                'group relationship placeholder thread is missing',
              );
            await this.groupRelationships.syncActiveInTx(tx, {
              threadId: thread.id,
              groupId: groupState.id,
              memberUserId: member.id,
              active: false,
              hostedLocally: false,
            });
          }
          if (inviteDirection && membership.changed) {
            const thread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.groupId, groupState.id),
              columns: { id: true },
            });
            if (!thread)
              throw new PermanentFederationItemError(
                'group relationship placeholder thread is missing',
              );
            const threadId = thread.id;
            const clientFeedId = await this.clientStateFeed.writeInTx(tx, {
              userId: member.id,
              namespaceId,
              account: groupState.account,
              domain: peerDomain,
              eventType: 'RELATIONSHIP_INTENT',
              subjectAccount: normalizeAccount(item.peerAccount),
              subjectDomain: this.config.domain,
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
                userId: member.id,
                feedId: clientFeedId,
              });
          }
          if (
            !inviteDirection &&
            storageStatus === 'ACCEPTED' &&
            !membership.shouldBeActive
          ) {
            const originThread = await tx.query.messageThread.findFirst({
              where: eq(tables.messageThread.groupId, groupState.id),
              columns: { id: true },
            });
            if (!originThread) throw new Error('origin group thread missing');
            const rejection =
              await this.relationshipCommands.writeGroupRelationshipIntentInTx(
                tx,
                originThread.id,
                member.id,
                '',
                'REVOKED',
                clientFeedUpdates,
              );
            statePushDomains.push(...rejection.keys());
            this.logger.warn(
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
              .where(eq(tables.messageThread.groupId, groupState.id))
              .for('update')
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
                await this.relationshipCommands.writeGroupRelationshipIntentInTx(
                  tx,
                  originThread.id,
                  member.id,
                  SERVER_GROUP_FULL_REASON,
                  'REVOKED',
                  clientFeedUpdates,
                );
              const emittedState =
                await this.profileStatePublisher.writeGroupStateInTx(
                  tx,
                  originThread.id,
                  clientFeedUpdates,
                );
              statePushDomains.push(
                ...rejection.keys(),
                ...emittedState.keys(),
              );
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
            await openFederatedAudienceInTx(tx, peerDomain, originThread.id);
            const owner = await tx.query.threadMember.findFirst({
              where: and(
                eq(tables.threadMember.threadId, originThread.id),
                eq(tables.threadMember.role, GroupRole.OWNER),
                eq(tables.threadMember.left, false),
              ),
              columns: { userId: true },
            });
            if (!owner) throw new Error('origin group owner missing');
            localSystemMessages.push({
              actorUserId: owner.userId,
              threadId: originThread.id,
              type: SystemMessageType.GROUP_JOINED,
              subjectUserId: member.id,
            });
            const confirmation =
              await this.relationshipCommands.writeGroupRelationshipIntentInTx(
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
            const [originThread] = await tx
              .select({ id: tables.messageThread.id })
              .from(tables.messageThread)
              .where(eq(tables.messageThread.groupId, groupState.id))
              .for('update')
              .limit(1);
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
                  const localRecipients = await tx
                    .select({ userId: tables.threadMember.userId })
                    .from(tables.threadMember)
                    .innerJoin(
                      tables.user,
                      eq(tables.user.id, tables.threadMember.userId),
                    )
                    .where(
                      and(
                        eq(tables.threadMember.threadId, originThread.id),
                        eq(tables.threadMember.left, false),
                        eq(tables.user.domain, 'local'),
                        eq(tables.user.namespaceId, 0),
                        eq(tables.user.availability, 'AVAILABLE'),
                      ),
                    );
                  const authorization = await Promise.all(
                    localRecipients.map((recipient) =>
                      isThreadMutuallyAuthorized(
                        tx,
                        recipient.userId,
                        originThread.id,
                      ),
                    ),
                  );
                  const recipientUserIds = localRecipients
                    .filter((_, index) => authorization[index])
                    .map((recipient) => recipient.userId);
                  const boundary = await this.message.writeSystemMessageInTx(
                    tx,
                    originThread.id,
                    SystemMessageType.GROUP_LEFT,
                    member.id,
                    { actorUserId: member.id, recipientUserIds },
                  );
                  return { boundary, recipientUserIds };
                },
              });
            if (!deactivation.pairChanged || !deactivation.effect) continue;
            const { boundary, recipientUserIds } = deactivation.effect;
            localSystemMessages.push({
              actorUserId: member.id,
              threadId: originThread.id,
              type: SystemMessageType.GROUP_LEFT,
              subjectUserId: member.id,
              message: boundary.message,
              recipientUserIds,
            });
            await tx
              .update(tables.group)
              .set({
                updatedAt: new Date(),
              })
              .where(eq(tables.group.id, groupState.id));
            const peerMembers = await tx
              .select({ userId: tables.threadMember.userId })
              .from(tables.threadMember)
              .innerJoin(
                tables.user,
                eq(tables.user.id, tables.threadMember.userId),
              )
              .where(
                and(
                  eq(tables.threadMember.threadId, originThread.id),
                  eq(tables.threadMember.left, false),
                  eq(tables.user.domain, peerDomain),
                  eq(tables.user.namespaceId, namespaceId),
                ),
              );
            const peerAuthorization = await Promise.all(
              peerMembers.map((peerMember) =>
                isThreadMutuallyAuthorized(
                  tx,
                  peerMember.userId,
                  originThread.id,
                ),
              ),
            );
            const hasPeerMembers = peerAuthorization.some(Boolean);
            if (!hasPeerMembers)
              await closeFederatedAudienceInTx(tx, peerDomain, originThread.id);
            const emittedGroupState = hasPeerMembers
              ? await this.profileStatePublisher.writeGroupStateInTx(
                  tx,
                  originThread.id,
                  clientFeedUpdates,
                )
              : await this.profileStatePublisher.cleanupGroupProjectionInTx(
                  tx,
                  originThread.id,
                  groupState.id,
                  groupState.account,
                  peerDomain,
                  namespaceId,
                  clientFeedUpdates,
                );
            statePushDomains.push(...emittedGroupState.keys());
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
          const groupPage = groupMetaPages.get(item.account);
          if (!groupPage) continue;
          if (BigInt(groupPage.scannedThrough) < BigInt(groupMetaFeedEndId))
            throw new Error(
              'group-meta page did not reach advertised revision',
            );
          const groupEffect = await this.applyGroupMetaFeedPageInTx(
            tx,
            peerDomain,
            namespaceId,
            item.account,
            groupPage,
          );
          if (groupEffect.threadId > 0)
            clientFeedUpdates.push(
              ...(await this.clientStateFeed.recordGroupStateInTx(
                tx,
                groupEffect.threadId,
              )),
            );
          statePushDomains.push(...groupEffect.statePushDomains);
          localSystemMessages.push(...groupEffect.systemMessages);
          // A newly active local member's profile must enter the outbound state
          // feed in the same transaction as the mirror roster. Otherwise a crash
          // after applying GROUP_META could permanently lose the profile publication.
          for (const userId of new Set(
            groupEffect.users
              .filter((effect) => effect.active)
              .map((effect) => effect.userId),
          )) {
            const profiles =
              await this.profileStatePublisher.writeProfileStateInTx(
                tx,
                userId,
                clientFeedUpdates,
              );
            statePushDomains.push(...profiles.keys());
          }
        } else if (item.eventType === 'THREAD_CONTENT_HEAD') {
          const body = item.body as {
            messageEndSeq?: unknown;
            tombstoneEndSeq?: unknown;
          };
          if (
            !Number.isSafeInteger(body.messageEndSeq) ||
            Number(body.messageEndSeq) < 1 ||
            Number(body.messageEndSeq) > FEDERATION_THREAD_SEQUENCE_MAX ||
            !Number.isSafeInteger(body.tombstoneEndSeq) ||
            Number(body.tombstoneEndSeq) < 0 ||
            Number(body.tombstoneEndSeq) > FEDERATION_THREAD_SEQUENCE_MAX
          )
            throw new PermanentFederationItemError(
              'invalid THREAD_CONTENT_HEAD body',
            );
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
          const lockedThread = await tx
            .select({ id: tables.messageThread.id })
            .from(tables.messageThread)
            .where(eq(tables.messageThread.id, target.threadId))
            .for('update')
            .limit(1);
          if (!lockedThread[0]) continue;
          target = await this.resolveStateFeedTargetInTransaction(
            tx,
            peerDomain,
            namespaceId,
            threadAddress,
          );
          if (target === null || target.threadId !== lockedThread[0].id)
            continue;
          const merged =
            await FederationThreadSyncStateService.reconcileThreadHeadInTx(tx, {
              threadId: target.threadId,
              peerDomain,
              namespaceId,
              messageTargetSeq: Number(body.messageEndSeq),
              deletionTargetSeq: Number(body.tombstoneEndSeq),
              reverseEnabled: target.reverseEnabled,
            });
          threadRoundWakes.push({
            threadId: target.threadId,
            peerDomain,
            namespaceId,
            direction: merged.reverseRequired ? 'both' : 'forward',
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
        if (!(error instanceof PermanentFederationItemError)) throw error;
        this.logger.error(
          `ignored invalid state-feed item from ${peerDomain} at ${item.feedId}: ${error.message}`,
        );
      } finally {
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      }
    }
    return {
      clientFeedUpdates,
      statePushDomains,
      localSystemMessages,
      threadRoundWakes,
    };
  }

  /** Refresh every local-origin group source that exposes this member. */
  private async publishGroupMemberProfileInTx(
    tx: DatabaseTransaction,
    userId: number,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const groups = await tx.execute<{ threadId: number }>(sql`
      SELECT DISTINCT member."threadId"
      FROM "ThreadMember" member
      JOIN "MessageThread" thread ON thread.id = member."threadId" AND thread.type = 'GROUP'
      JOIN "Group" group_profile ON group_profile.id = thread."groupId" AND group_profile.domain = 'local'
      WHERE member."userId" = ${userId} AND member."left" = false
    `);
    const result = new Map<string, bigint>();
    for (const group of groups.rows) {
      if (!(await isThreadMutuallyAuthorized(tx, userId, group.threadId)))
        continue;
      const state = await this.refreshGroupMemberProjectionInTx(
        tx,
        group.threadId,
        clientFeedUpdates,
      );
      for (const entry of state) result.set(...entry);
    }
    return result;
  }

  /** A member profile change is a group-meta semantic change and therefore advances the same group
   * revision used by roster mutations before publishing the compacted member projection. */
  private async refreshGroupMemberProjectionInTx(
    tx: DatabaseTransaction,
    threadId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    return this.profileStatePublisher.writeGroupStateInTx(
      tx,
      threadId,
      clientFeedUpdates,
    );
  }

  private async applyGroupMetaFeedPageInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    account: string,
    page: GroupMetaFeedPage,
  ) {
    if (
      page.account !== account ||
      (page.mode !== 'full' && page.mode !== 'delta') ||
      !/^(0|[1-9]\d*)$/.test(page.scannedThrough) ||
      !/^(0|[1-9]\d*)$/.test(page.groupMetaFeedEndId) ||
      page.hasMore !== false ||
      !Array.isArray(page.items)
    )
      throw new Error('invalid group-meta page');
    const groupAccount = normalizeAccount(account);
    const revision = BigInt(page.scannedThrough);
    const [mirror] = await tx
      .select({ threadId: tables.messageThread.id })
      .from(tables.group)
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.groupId, tables.group.id),
      )
      .where(
        and(
          eq(tables.group.account, groupAccount),
          eq(tables.group.domain, peerDomain),
          eq(tables.group.namespaceId, namespaceId),
        ),
      )
      .limit(1);
    if (!mirror) throw new Error('group-meta mirror thread is missing');
    const changes = new Map<
      string,
      {
        account: string;
        domain: string;
        beforeRole: GroupRole | null;
        afterRole: GroupRole | null;
      }
    >();
    const fullRosterKeys = new Set<string>();
    let previousFeedId = 0n;
    for (const member of page.items) {
      if (!/^[1-9]\d*$/.test(member.feedId))
        throw new Error('invalid group-meta feed id');
      const feedId = BigInt(member.feedId);
      if (
        feedId <= previousFeedId ||
        feedId > BigInt(page.scannedThrough) ||
        typeof member.account !== 'string' ||
        typeof member.domain !== 'string' ||
        (member.operation !== 'UPSERT' && member.operation !== 'DEPART')
      )
        throw new Error('invalid group-meta member');
      previousFeedId = feedId;
      const memberAccount = normalizeAccount(member.account);
      const key = `${member.domain}\u0000${memberAccount}`;
      if (page.mode === 'full') {
        if (member.operation !== 'UPSERT' || fullRosterKeys.has(key))
          throw new Error('invalid full group-meta roster item');
        fullRosterKeys.add(key);
      }
      if (!changes.has(key)) {
        const [previous] = await tx
          .select({
            role: tables.threadMember.role,
            left: tables.threadMember.left,
          })
          .from(tables.threadMember)
          .innerJoin(
            tables.user,
            eq(tables.user.id, tables.threadMember.userId),
          )
          .where(
            and(
              eq(tables.threadMember.threadId, mirror.threadId),
              eq(tables.user.account, memberAccount),
              eq(tables.user.domain, member.domain),
              eq(tables.user.namespaceId, namespaceId),
              eq(tables.user.sourceDomain, peerDomain),
            ),
          )
          .limit(1);
        changes.set(key, {
          account: memberAccount,
          domain: member.domain,
          beforeRole: previous && !previous.left ? previous.role : null,
          afterRole: previous && !previous.left ? previous.role : null,
        });
      }
      const body = member.body as {
        role?: unknown;
        profileRev?: unknown;
        displayName?: unknown;
        avatar?: unknown;
      };
      if (
        !Object.values(GroupRole).includes(body.role as GroupRole) ||
        !Number.isSafeInteger(body.profileRev) ||
        Number(body.profileRev) < 0 ||
        typeof body.displayName !== 'string' ||
        body.displayName.length < 1
      )
        throw new Error('invalid group-meta member body');
      let avatar: string | null = null;
      if (body.avatar !== null) {
        const wire = body.avatar as {
          digest?: unknown;
          base64?: unknown;
          width?: unknown;
          height?: unknown;
        };
        if (
          !wire ||
          typeof wire.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(wire.digest) ||
          typeof wire.base64 !== 'string' ||
          !Number.isSafeInteger(wire.width) ||
          Number(wire.width) < 1 ||
          !Number.isSafeInteger(wire.height) ||
          Number(wire.height) < 1
        )
          throw new Error('invalid group-meta member avatar');
        const bytes = Buffer.from(wire.base64, 'base64');
        if (
          bytes.toString('base64') !== wire.base64 ||
          createHash('sha256').update(bytes).digest('hex') !== wire.digest
        )
          throw new Error('group-meta member avatar digest mismatch');
        avatar = await this.upload.saveAvatarFromWire({
          b64: wire.base64,
          w: Number(wire.width),
          h: Number(wire.height),
        });
      }
      const sourceUserId = await upsertSourceUserInTx(tx, {
        account: memberAccount,
        domain: member.domain,
        sourceDomain: peerDomain,
        namespaceId,
        name: body.displayName,
        avatar,
        profileRev: Number(body.profileRev),
      });
      await tx
        .insert(tables.threadMember)
        .values({
          threadId: mirror.threadId,
          userId: sourceUserId,
          role: body.role as GroupRole,
          left: member.operation === 'DEPART',
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [tables.threadMember.threadId, tables.threadMember.userId],
          set: {
            role: body.role as GroupRole,
            joinedAt: sql`CASE WHEN ${member.operation === 'UPSERT'} AND ${tables.threadMember.left}
                          THEN CURRENT_TIMESTAMP
                          ELSE ${tables.threadMember.joinedAt} END`,
            left: member.operation === 'DEPART',
            updatedAt: new Date(),
          },
        });
      if (
        member.operation === 'UPSERT' &&
        member.domain === this.config.domain
      ) {
        const localIdentity = await tx.query.user.findFirst({
          where: and(
            eq(tables.user.account, memberAccount),
            eq(tables.user.domain, 'local'),
            eq(tables.user.sourceDomain, 'local'),
            eq(tables.user.namespaceId, 0),
          ),
          columns: { id: true },
        });
        if (localIdentity)
          await ensureLocalThreadParticipantInTx(tx, {
            threadId: mirror.threadId,
            localUserId: localIdentity.id,
            role: body.role as GroupRole,
          });
      }
      changes.get(key)!.afterRole =
        member.operation === 'UPSERT' ? (body.role as GroupRole) : null;
    }
    if (page.mode === 'full') {
      const absentMembers = await tx
        .select({
          userId: tables.threadMember.userId,
          account: tables.user.account,
          domain: tables.user.domain,
          role: tables.threadMember.role,
        })
        .from(tables.threadMember)
        .innerJoin(tables.user, eq(tables.user.id, tables.threadMember.userId))
        .where(
          and(
            eq(tables.threadMember.threadId, mirror.threadId),
            eq(tables.threadMember.left, false),
            eq(tables.user.sourceDomain, peerDomain),
            eq(tables.user.namespaceId, namespaceId),
          ),
        );
      for (const member of absentMembers) {
        const key = `${member.domain}\u0000${member.account}`;
        if (fullRosterKeys.has(key)) continue;
        changes.set(key, {
          account: member.account,
          domain: member.domain,
          beforeRole: member.role,
          afterRole: null,
        });
        await tx
          .update(tables.threadMember)
          .set({ left: true, updatedAt: new Date() })
          .where(
            and(
              eq(tables.threadMember.threadId, mirror.threadId),
              eq(tables.threadMember.userId, member.userId),
            ),
          );
      }
    }
    const [memberCountRow, owners, activeMember] = await Promise.all([
      tx
        .select({ value: count() })
        .from(tables.threadMember)
        .where(
          and(
            eq(tables.threadMember.threadId, mirror.threadId),
            eq(tables.threadMember.left, false),
          ),
        )
        .then((rows) => rows[0]),
      tx
        .select({
          account: tables.user.account,
          domain: tables.user.domain,
        })
        .from(tables.threadMember)
        .innerJoin(tables.user, eq(tables.user.id, tables.threadMember.userId))
        .where(
          and(
            eq(tables.threadMember.threadId, mirror.threadId),
            eq(tables.threadMember.role, GroupRole.OWNER),
            eq(tables.threadMember.left, false),
            eq(tables.user.sourceDomain, peerDomain),
            eq(tables.user.namespaceId, namespaceId),
          ),
        )
        .limit(2),
      tx
        .select({ memberAccount: tables.user.account })
        .from(tables.threadMember)
        .innerJoin(tables.user, eq(tables.user.id, tables.threadMember.userId))
        .where(
          and(
            eq(tables.threadMember.threadId, mirror.threadId),
            eq(tables.user.domain, this.config.domain),
            eq(tables.user.sourceDomain, peerDomain),
            eq(tables.user.namespaceId, namespaceId),
            eq(tables.threadMember.left, false),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    const memberCount = memberCountRow?.value ?? 0;
    if (memberCount > 0 && owners.length !== 1)
      throw new Error('group-meta roster must have exactly one owner');
    const owner = owners[0];
    const effect = await this.groupRosterProjection.applyInTx(tx, {
      peerDomain,
      namespaceId,
      groupAccount: account,
      revision,
      active: activeMember !== undefined,
      dissolved: memberCount === 0,
      owner: owner ?? null,
      changes: [...changes.values()],
    });
    return effect;
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
      JOIN "Group" group_user ON group_user.id = message_thread."groupId"
      JOIN "ThreadAudience" audience
        ON audience."threadId" = message_thread.id
       AND audience."targetDomain" = ${sourceDomain}
       AND audience."targetNamespaceId" = ${namespaceId}
       AND audience."localUserId" IS NULL
      WHERE message_thread.type = 'GROUP'
        AND group_user.account = ${normalizeAccount(thread.account)}
        AND (group_user.domain = 'local'
          OR group_user."namespaceId" = ${namespaceId})
        AND group_user.domain IN (${sourceDomain}, 'local')
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
