import { writeP2PClientRelationshipInTx } from './p2p-client-relationship.js';
import { initializeRelationshipThreadStateInTx } from '../federation/federation-relationship-thread-state.js';
import { groupState as group, groupStateFields } from '../group/group-state.js';
import { isGroupDissolvedInTx } from '../group/group-state.js';
import {
  accountAddressInTx,
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../user/account-address.js';
import type { NamespacedAddress } from '../common/client-identity.js';
import { Inject, Injectable } from '@nestjs/common';
import { ThreadPreviewService } from '../message/thread-preview.service.js';
import { Interval } from '@nestjs/schedule';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  account as accountTable,
  relationshipPair,
  relationshipIntent,
  messageThread,
  threadAudience,
  accountThreadState,
  account as user,
  profileTable,
} from '../database/schema.js';
import { MessageThreadType } from '../database/enums.js';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { MessageService } from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from '../federation/federation-audience.js';
import { RelationshipIntentService } from './relationship-intent.service.js';
import { FederationNamespaceService } from '../federation/federation-namespace.service.js';
import { requireP2PThreadContentLockUnderPairInTx } from './thread-content-lock.js';

/** Relationship-request TTL: 7 days. Validated at accept time; the background sweep/GC is deferred
 *  (a row stays PENDING past expiry until then — the client renders an "expired" prompt from
 *  `expiresAt`, and accept rejects an expired row with INVITE_EXPIRED as defense-in-depth). */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RELATIONSHIP_SHELL_GC_INTERVAL_MS = 60 * 60 * 1000;

export type CreateRelationshipRequestResult =
  | { status: 'created' }
  | { status: 'already-pending' }
  | { status: 'auto-accepted'; threadId: number };

export type AcceptRelationshipRequestResult = {
  threadId?: number;
  fromUserId: number;
};

export type FriendRelationshipState =
  | 'NONE'
  | 'OUTGOING_PENDING'
  | 'INCOMING_PENDING'
  | 'FRIEND';

export interface FederatedPendingProfileSnapshot {
  displayName: string;
  avatar?: string;
}

export function applyFederatedPendingProfileSnapshot(
  profile: { name: string; avatar: string },
  snapshot?: FederatedPendingProfileSnapshot,
): { name: string; avatar: string } {
  if (!snapshot) return profile;
  return {
    name: snapshot.displayName.slice(0, 30),
    avatar: snapshot.avatar ?? '',
  };
}

/**
 * Relationship-request commands and compatibility queries backed by authoritative directed intents.
 */
@Injectable()
export class RelationshipService {
  @Inject(ThreadPreviewService)
  private readonly previews!: ThreadPreviewService;
  constructor(
    private readonly database: DatabaseService,
    private readonly participantService: AccountThreadStateService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly namespaces: FederationNamespaceService,
    private readonly messages: MessageService,
  ) {}

  /** Reap never-activated request shells after every authored request has expired. The transaction
   * rechecks all directional facts under pair locks, so a concurrent accept cannot lose its thread. */
  @Interval(RELATIONSHIP_SHELL_GC_INTERVAL_MS)
  async cleanupExpiredRelationshipShells(): Promise<number> {
    return this.database.db.transaction(async (tx) => {
      const candidates = await tx.execute<{ threadId: number }>(sql`
        SELECT pair."threadId"
        FROM "RelationshipPair" pair
        JOIN "MessageThread" thread ON thread.id = pair."threadId"
        WHERE pair.active = false AND pair.established = false
          AND pair.kind = 'P2P'
          AND pair."threadId" IS NOT NULL
          AND thread.type = 'P2P'
          AND NOT EXISTS (
            SELECT 1 FROM "Message" message
            WHERE message."threadId" = pair."threadId"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "RelationshipIntent" request
            WHERE request."pairId" = pair.id
              AND (request.status = 'ACCEPTED'
                OR (request.status = 'REQUESTED' AND request."expiresAt" > CURRENT_TIMESTAMP))
          )
        FOR UPDATE OF pair, thread SKIP LOCKED
      `);
      const ids = candidates.rows.map((row) => row.threadId);
      if (ids.length > 0) {
        await tx
          .delete(accountThreadState)
          .where(inArray(accountThreadState.threadId, ids));
        await tx.delete(messageThread).where(inArray(messageThread.id, ids));
      }
      return ids.length;
    });
  }

  async writeGroupRequestClientStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    pendingFeedUpdates: Array<{ userId: number; feedId: number }>,
  ): Promise<void> {
    const [state] = await tx
      .select({
        groupId: messageThread.id,
        account: groupStateFields.account,
        domain: groupStateFields.domain,
        name: groupStateFields.name,
        avatar: groupStateFields.avatar,
        description: groupStateFields.description,
        profileRev: groupStateFields.profileRev,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.id))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!state?.groupId || state.domain !== 'local') return;
    const request = await tx.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorSide, 'A'),
        sql`EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            JOIN "Account" identity ON identity.id = ${memberUserId}
            WHERE pair.id = ${relationshipIntent.pairId}
              AND pair."threadId" = ${threadId}
              AND pair."endpointBAccount" = identity.account
              AND pair."endpointBDomain" = identity.domain
              AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
              AND pair."endpointBNamespaceId" = identity."namespaceId"
          )`,
      ),
    });
    const member = await tx.query.account.findFirst({
      where: eq(user.id, memberUserId),
      columns: { account: true },
    });
    if (!request || !member) return;
    const feedId = await this.clientStateFeed.writeInTx(tx, {
      userId: memberUserId,
      account: state.account,
      domain: 'local',
      namespaceId: 0,
      eventType: 'RELATIONSHIP_INTENT',
      subjectAccount: member.account,
      subjectDomain: 'local',
      body: {
        status:
          request.status === 'ACCEPTED'
            ? 'ACCEPTED'
            : request.status === 'REQUESTED'
              ? 'REQUESTED'
              : 'REVOKED',
        note: request.note,
        requestedAt: request.requestedAt?.getTime() ?? null,
        expiresAt: request.expiresAt?.getTime() ?? null,
        threadId,
        group: {
          account: state.account,
          domain: 'local',
          isLocal: true,
          name: state.name,
          avatar: state.avatar,
          description: state.description,
          profileRev: state.profileRev,
        },
      },
    });
    if (feedId !== null)
      pendingFeedUpdates.push({ userId: memberUserId, feedId });
  }

  /** Create or refresh an outbound federated request by Address. */
  async createFederatedRelationshipRequest(
    localUserId: number,
    remoteAccount: string,
    remoteDomain: string,
    note: string,
    snapshot: FederatedPendingProfileSnapshot,
    afterWrite: (
      tx: DatabaseTransaction,
      state: {
        namespaceId: number;
        created: boolean;
        requestedAt: Date;
        expiresAt: Date;
        note: string;
        snapshot: FederatedPendingProfileSnapshot;
      },
    ) => Promise<void>,
  ): Promise<{ created: boolean }> {
    const account = normalizeAccount(remoteAccount);
    const trimmed = note.slice(0, 255);
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const context = await this.namespaces.captureActiveInTx(tx, remoteDomain);
      const relationship =
        await this.relationshipIntents.readP2PRelationshipByAddressInTx(
          tx,
          localUserId,
          { account, domain: remoteDomain, namespaceId: context.namespaceId },
        );
      const current = relationship?.localIntent;
      const created =
        !current ||
        current.status === 'REVOKED' ||
        (current.expiresAt !== null && current.expiresAt <= now);
      const requestedAt = now;
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      await afterWrite(tx, {
        namespaceId: context.namespaceId,
        created,
        requestedAt,
        expiresAt,
        note: trimmed,
        snapshot,
      });
      return { created };
    });
    return result;
  }

  /** Relationship state for an exact federated Address without a local account row. */
  async federatedRelationshipStatus(
    localUserId: number,
    remoteAccount: string,
    remoteDomain: string,
  ): Promise<FriendRelationshipState> {
    return (
      await this.federatedRelationshipContext(
        localUserId,
        remoteAccount,
        remoteDomain,
      )
    ).status;
  }

  async federatedRelationshipContext(
    localUserId: number,
    remoteAccount: string,
    remoteDomain: string,
  ): Promise<{ namespaceId: number; status: FriendRelationshipState }> {
    const account = normalizeAccount(remoteAccount);
    const { relationship, namespaceId } = await this.database.db.transaction(
      async (tx) => {
        const context = await this.namespaces.captureActiveInTx(
          tx,
          remoteDomain,
        );
        const relationship =
          await this.relationshipIntents.readP2PRelationshipByAddressInTx(
            tx,
            localUserId,
            {
              account,
              domain: remoteDomain,
              namespaceId: context.namespaceId,
            },
          );
        return { relationship, namespaceId: context.namespaceId };
      },
    );
    if (relationship?.pair.active) return { namespaceId, status: 'FRIEND' };
    const now = new Date();
    if (
      relationship?.remoteIntent?.status === 'REQUESTED' &&
      relationship.remoteIntent.expiresAt !== null &&
      relationship.remoteIntent.expiresAt > now
    )
      return { namespaceId, status: 'INCOMING_PENDING' };
    if (
      relationship?.localIntent?.status === 'REQUESTED' &&
      relationship.localIntent.expiresAt !== null &&
      relationship.localIntent.expiresAt > now
    )
      return { namespaceId, status: 'OUTGOING_PENDING' };
    return { namespaceId, status: 'NONE' };
  }

  async resolveP2PRequestCommandScope(
    localUserId: number,
    remoteAccount: string,
    remoteDomain: string,
    direction: 'INCOMING' | 'OUTGOING',
  ): Promise<{
    local: { account: string; domain: string };
    remote: { account: string; domain: string };
    peerUserId: number | null;
  }> {
    const account = normalizeAccount(remoteAccount);
    const domain = remoteDomain.trim().toLowerCase();
    return this.database.db.transaction(async (tx) => {
      const namespaceId =
        domain === 'local'
          ? 0
          : (await this.namespaces.captureActiveInTx(tx, domain)).namespaceId;
      const local = await tx.query.account.findFirst({
        where: eq(user.id, localUserId),
        columns: { account: true, domain: true },
      });
      if (!local) {
        throw new BusinessException(
          BusinessCode.UNAUTHENTICATED,
          'authenticated user does not exist',
        );
      }
      const relationship =
        await this.relationshipIntents.readP2PRelationshipByAddressInTx(
          tx,
          localUserId,
          {
            account,
            domain,
            namespaceId,
          },
        );
      const request =
        direction === 'INCOMING'
          ? relationship?.remoteIntent
          : relationship?.localIntent;
      if (!request) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'request not found',
        );
      }
      if (
        request.status !== 'REQUESTED' ||
        request.expiresAt === null ||
        request.expiresAt <= new Date()
      ) {
        throw new BusinessException(
          BusinessCode.INVITE_EXPIRED,
          'request expired',
        );
      }
      const peer =
        domain === 'local'
          ? await tx.query.account.findFirst({
              where: and(
                eq(user.account, account),
                eq(user.domain, 'local'),
                eq(user.namespaceId, 0),
              ),
              columns: { id: true },
            })
          : null;
      if (domain === 'local' && !peer)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'request author not found',
        );
      return {
        local: { account: local.account, domain: local.domain },
        remote: { account, domain },
        peerUserId: peer?.id ?? null,
      };
    });
  }

  /** Apply one locally-authored direction. Purely local pairs use this same state machine but emit no
   * peer feed. The canonical pair row is locked before either directed request is inspected. */
  async writeLocalP2PIntentInTx(
    tx: DatabaseTransaction,
    actorUserId: number,
    peerUserId: AccountTarget,
    wantsFriend: boolean,
    note = '',
    peerSnapshot?: FederatedPendingProfileSnapshot,
  ): Promise<Array<{ userId: number; feedId: number }>> {
    const threadId = wantsFriend
      ? await this.ensureP2PThreadShellInTx(tx, actorUserId, peerUserId)
      : null;
    const peer = await accountAddressInTx(tx, peerUserId);
    const written = await this.relationshipIntents.writeP2PAuthoredIntentInTx(
      tx,
      {
        authorUserId: actorUserId,
        subjectUserId: peerUserId,
        threadId,
        status: wantsFriend ? 'REQUESTED' : 'REVOKED',
        note,
        confirmReverseRequested: peer?.domain === 'local',
      },
    );
    const pairEffect = await this.reconcileFriendPairInTx(
      tx,
      actorUserId,
      peerUserId,
      written.shouldBeActive,
    );
    if (peer && peer.domain !== 'local' && pairEffect.threadId !== undefined) {
      if (wantsFriend)
        await openFederatedAudienceInTx(tx, peer.domain, pairEffect.threadId);
      else
        await closeFederatedAudienceInTx(tx, peer.domain, pairEffect.threadId);
    }
    return [
      ...(pairEffect.clientFeedUpdates ?? []),
      ...(await this.writeRelationshipRequestClientStateInTx(
        tx,
        actorUserId,
        peerUserId,
        peerSnapshot,
      )),
    ];
  }

  async writeRelationshipRequestClientStateInTx(
    tx: DatabaseTransaction,
    firstTarget: AccountTarget,
    secondTarget: AccountTarget,
    _secondUserSnapshot?: FederatedPendingProfileSnapshot,
  ): Promise<Array<{ userId: number; feedId: number }>> {
    return writeP2PClientRelationshipInTx(
      tx,
      firstTarget,
      secondTarget,
      this.relationshipIntents,
      this.clientStateFeed,
    );
  }

  /** Rejection/deletion closes only the actor's direction. The opposite request remains valid and may
   * intentionally reactivate the relationship when this direction is requested again. */
  async closeLocalP2PIntentInTx(
    tx: DatabaseTransaction,
    userAId: number,
    userBId: AccountTarget,
    reason = '',
  ): Promise<void> {
    await this.writeLocalP2PIntentInTx(tx, userAId, userBId, false, reason);
  }

  /**
   * Authoritative relationship state for discovery UI. FRIEND takes precedence over stale pending
   * rows; only unexpired PENDING requests count. The result contains every requested id so clients do
   * not need to infer missing rows.
   */
  async friendRelationshipStatuses(
    me: number,
    requestedUserIds: number[],
  ): Promise<
    Array<{
      userId: number;
      status: FriendRelationshipState;
    }>
  > {
    const userIds = [...new Set(requestedUserIds)].filter((id) => id !== me);
    if (userIds.length === 0) return [];

    const [friendIds, requestRows] = await Promise.all([
      this.participantService.getActiveP2PPeerUserIds(me),
      this.database.db.execute<{
        peerUserId: number;
        direction: 'INCOMING' | 'OUTGOING';
      }>(sql`
        SELECT peer.id AS "peerUserId",
          CASE
            WHEN (intent."authorSide" = 'A'
              AND pair."endpointAAccount" = self.account
              AND pair."endpointADomain" = self.domain)
              OR (intent."authorSide" = 'B'
                AND pair."endpointBAccount" = self.account
                AND pair."endpointBDomain" = self.domain)
            THEN 'OUTGOING' ELSE 'INCOMING'
          END AS direction
        FROM "RelationshipIntent" intent
        JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
        JOIN "Account" self ON self.id = ${me}
        JOIN "Account" peer ON peer.id IN (${sql.join(
          userIds.map((userId) => sql`${userId}`),
          sql`, `,
        )})
         AND ((peer.account = pair."endpointAAccount" AND peer.domain = pair."endpointADomain")
           OR (peer.account = pair."endpointBAccount" AND peer.domain = pair."endpointBDomain"))
        WHERE pair.kind = 'P2P'
          AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
          AND self."namespaceId" = 0
          AND pair."endpointANamespaceId" = peer."namespaceId"
          AND intent.status = 'REQUESTED'
          AND intent."expiresAt" > CURRENT_TIMESTAMP
          AND ((self.account = pair."endpointAAccount" AND self.domain = pair."endpointADomain")
            OR (self.account = pair."endpointBAccount" AND self.domain = pair."endpointBDomain"))
          AND peer.id <> self.id
      `),
    ]);
    const requests = requestRows.rows;
    const friends = new Set(friendIds);
    const outgoing = new Set(
      requests
        .filter((request) => request.direction === 'OUTGOING')
        .map((request) => request.peerUserId),
    );
    const incoming = new Set(
      requests
        .filter((request) => request.direction === 'INCOMING')
        .map((request) => request.peerUserId),
    );

    return userIds.map((userId) => {
      if (friends.has(userId)) return { userId, status: 'FRIEND' };
      if (outgoing.has(userId)) return { userId, status: 'OUTGOING_PENDING' };
      if (incoming.has(userId)) return { userId, status: 'INCOMING_PENDING' };
      return { userId, status: 'NONE' };
    });
  }

  /** Create or refresh one authored local P2P relationship request. */
  async createRelationshipRequest(
    fromUserId: number,
    toUserId: number,
    note: string,
    afterWrite?: (tx: DatabaseTransaction, created: boolean) => Promise<void>,
  ): Promise<CreateRelationshipRequestResult> {
    const trimmed = (note ?? '').slice(0, 255);
    const pendingFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    const result =
      await this.database.db.transaction<CreateRelationshipRequestResult>(
        async (tx) => {
          const before = (
            await this.relationshipIntents.readP2PRelationshipInTx(
              tx,
              fromUserId,
              toUserId,
            )
          ).firstIntent;
          const created =
            !before ||
            before.status === 'REVOKED' ||
            (before.expiresAt !== null && before.expiresAt <= new Date());
          if (afterWrite) await afterWrite(tx, created);
          else
            pendingFeedUpdates.push(
              ...(await this.writeLocalP2PIntentInTx(
                tx,
                fromUserId,
                toUserId,
                true,
                trimmed,
              )),
            );
          const relationship =
            await this.relationshipIntents.readP2PRelationshipInTx(
              tx,
              fromUserId,
              toUserId,
            );
          const request = relationship.firstIntent;
          if (!request) throw new Error('friend request write disappeared');
          const pair = relationship.pair;
          if (pair?.active && pair.threadId !== null) {
            return { status: 'auto-accepted', threadId: pair.threadId };
          }
          return created
            ? { status: 'created' }
            : { status: 'already-pending' };
        },
      );
    // Notify local devices only after the client-state writes commit.
    this.clientStateFeed.notifyFeedUpdates(pendingFeedUpdates);
    return result;
  }

  /** Create or refresh one group membership invitation. */
  async createGroupInvite(
    fromUserId: number,
    threadId: number,
    toUserId: AccountTarget,
    note = '',
    afterWrite?: (tx: DatabaseTransaction) => Promise<void>,
  ): Promise<string | null> {
    const trimmed = (note ?? '').slice(0, 255);
    return this.database.db.transaction(async (tx) => {
      if (await isGroupDissolvedInTx(tx, threadId)) return null;
      const memberIdentity = await accountAddressInTx(tx, toUserId);
      const target = await tx.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { id: true, type: true },
      });
      if (target?.type !== 'GROUP')
        throw new Error('group invite target is invalid');
      await this.relationshipIntents.lockGroupMutationInTx(tx, {
        groupId: target.id,
        memberUserId: toUserId,
        threadId,
        projectionUserIds: [fromUserId],
      });
      if (afterWrite) await afterWrite(tx);
      else
        await this.relationshipIntents.writeGroupAuthoredIntentInTx(tx, {
          groupId: target.id,
          memberUserId: toUserId,
          threadId,
          author: 'GROUP',
          status: 'REQUESTED',
          note: trimmed,
        });
      const request = await tx.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorSide, 'A'),
          sql`EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            WHERE pair.id = ${relationshipIntent.pairId}
              AND pair."threadId" = ${threadId}
              AND pair."endpointBAccount" = ${memberIdentity.account}
              AND pair."endpointBDomain" = ${memberIdentity.domain}
              AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
              AND pair."endpointBNamespaceId" = ${memberIdentity.namespaceId}
          )`,
        ),
        columns: {
          id: true,
        },
      });
      if (!request) throw new Error('group request write disappeared');
      if (memberIdentity.domain !== 'local')
        await openFederatedAudienceInTx(tx, memberIdentity.domain, threadId);
      return request.id.toString();
    });
  }

  /** Accept a pending P2P relationship request addressed to `byUserId`. */
  async acceptRelationshipRequest(
    peerUserId: number,
    byUserId: number,
    afterAccept?: (
      tx: DatabaseTransaction,
      fromUserId: number,
    ) => Promise<void>,
  ): Promise<AcceptRelationshipRequestResult> {
    const pendingFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    const result = await this.database.db.transaction(
      async (tx): Promise<AcceptRelationshipRequestResult> => {
        const relationship =
          await this.relationshipIntents.readP2PRelationshipInTx(
            tx,
            byUserId,
            peerUserId,
          );
        const request = relationship.secondIntent;
        if (!request)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_FOUND,
            'request not found',
          );
        if (request.status !== 'REQUESTED')
          throw new BusinessException(
            BusinessCode.INVITE_ALREADY_HANDLED,
            'request already handled',
          );
        if (
          request.expiresAt === null ||
          request.expiresAt.getTime() <= Date.now()
        )
          throw new BusinessException(
            BusinessCode.INVITE_EXPIRED,
            'request expired',
          );
        await this.requireCurrentPendingIntentInTx(
          tx,
          request.id,
          relationship.pair.id,
        );
        if (afterAccept) await afterAccept(tx, peerUserId);
        else
          pendingFeedUpdates.push(
            ...(await this.writeLocalP2PIntentInTx(
              tx,
              byUserId,
              peerUserId,
              true,
            )),
          );
        const state = await this.relationshipIntents.readP2PRelationshipInTx(
          tx,
          byUserId,
          peerUserId,
        );
        if (!state.pair.active || state.pair.threadId === null) {
          const peer = await tx.query.account.findFirst({
            where: eq(user.id, peerUserId),
            columns: { domain: true },
          });
          if (peer?.domain === 'local')
            throw new Error(
              'local mutual friend requests did not activate the pair',
            );
          return { fromUserId: peerUserId };
        }
        return {
          threadId: state.pair.threadId,
          fromUserId: peerUserId,
        };
      },
    );
    // Notify local devices only after the client-state writes commit.
    this.clientStateFeed.notifyFeedUpdates(pendingFeedUpdates);
    return result;
  }

  /** Revoke my own outgoing pending relationship request. */
  async revokeRelationshipRequest(
    peerUserId: number,
    byUserId: number,
    afterRevoke?: (tx: DatabaseTransaction, toUserId: number) => Promise<void>,
  ): Promise<void> {
    const pendingFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.database.db.transaction(async (tx) => {
      const relationship =
        await this.relationshipIntents.readP2PRelationshipInTx(
          tx,
          byUserId,
          peerUserId,
        );
      const request = relationship.firstIntent;
      if (!request)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'request not found',
        );
      if (request.status !== 'REQUESTED') {
        throw new BusinessException(
          BusinessCode.INVITE_ALREADY_HANDLED,
          'request already handled',
        );
      }
      if (afterRevoke) await afterRevoke(tx, peerUserId);
      else
        pendingFeedUpdates.push(
          ...(await this.writeLocalP2PIntentInTx(
            tx,
            byUserId,
            peerUserId,
            false,
          )),
        );
    });
    this.clientStateFeed.notifyFeedUpdates(pendingFeedUpdates);
  }

  /** Reject an incoming request by authoring the recipient's REVOKED direction. */
  async rejectRelationshipRequest(
    peerUserId: number,
    byUserId: number,
    afterReject: (tx: DatabaseTransaction, fromUserId: number) => Promise<void>,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const relationship =
        await this.relationshipIntents.readP2PRelationshipInTx(
          tx,
          byUserId,
          peerUserId,
        );
      const request = relationship.secondIntent;
      if (!request)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'request not found',
        );
      if (request.status !== 'REQUESTED')
        throw new BusinessException(
          BusinessCode.INVITE_ALREADY_HANDLED,
          'request already handled',
        );
      await afterReject(tx, peerUserId);
    });
  }

  /** Revision-gated remote intent application. This runs inside the state-feed page transaction;
   * the pair row is also the lock that serializes crossed requests. */
  async applyRemoteP2PIntentInTx(
    tx: DatabaseTransaction,
    params: {
      localUserId: number;
      peerUserId: AccountTarget;
      status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
      messageEndSeq?: number;
      tombstoneEndSeq?: number;
      profileRev: number;
      note: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
      origin: string;
    },
  ): Promise<{
    changed: boolean;
    requestCreated: boolean;
    localStateRevision?: number;
    clientFeedUpdates: Array<{ userId: number; feedId: number }>;
    threadId?: number;
    added?: boolean;
    removed?: boolean;
  }> {
    const before = await this.relationshipIntents.readP2PRelationshipInTx(
      tx,
      params.peerUserId,
      params.localUserId,
    );
    const previous = before.firstIntent;
    const applied = await this.relationshipIntents.applyRemoteP2PIntentInTx(
      tx,
      {
        authorUserId: params.peerUserId,
        subjectUserId: params.localUserId,
        threadId: before.pair.threadId,
        status: params.status,
        messageEndSeq: params.messageEndSeq,
        tombstoneEndSeq: params.tombstoneEndSeq,
        profileRev: params.profileRev,
        note: params.note,
        requestedAt: params.status === 'REVOKED' ? null : params.requestedAt,
        expiresAt: params.status === 'REQUESTED' ? params.expiresAt : null,
      },
    );
    if (!applied.changed)
      return { changed: false, requestCreated: false, clientFeedUpdates: [] };
    const localStateRevision =
      applied.publishAccepted ? 1 : undefined;
    const pairEffect = await this.reconcileFriendPairInTx(
      tx,
      params.localUserId,
      params.peerUserId,
      applied.shouldBeActive,
      { actorUserId: params.peerUserId, subjectUserId: params.peerUserId },
    );
    const localDirection = (
      await this.relationshipIntents.readP2PRelationshipInTx(
        tx,
        params.localUserId,
        params.peerUserId,
      )
    ).firstIntent;
    if (pairEffect.threadId !== undefined) {
      const locallyAuthorized =
        localDirection?.status === 'ACCEPTED' ||
        (localDirection?.status === 'REQUESTED' &&
          localDirection.expiresAt !== null &&
          localDirection.expiresAt > new Date());
      if (locallyAuthorized)
        await openFederatedAudienceInTx(tx, params.origin, pairEffect.threadId);
      else
        await closeFederatedAudienceInTx(
          tx,
          params.origin,
          pairEffect.threadId,
        );
    }
    const clientFeedUpdates = [
      ...(pairEffect.clientFeedUpdates ?? []),
      ...(await this.writeRelationshipRequestClientStateInTx(
        tx,
        params.localUserId,
        params.peerUserId,
      )),
    ];
    if (pairEffect.active) {
      return {
        changed: true,
        requestCreated: false,
        clientFeedUpdates,
        ...(localStateRevision === undefined ? {} : { localStateRevision }),
        threadId: pairEffect.threadId,
        added: pairEffect.transitioned,
      };
    }
    if (params.status === 'REQUESTED') {
      return {
        changed: true,
        ...(localStateRevision === undefined ? {} : { localStateRevision }),
        requestCreated:
          previous?.status !== 'REQUESTED' ||
          previous.expiresAt === null ||
          previous.expiresAt <= new Date(),
        clientFeedUpdates,
      };
    }
    void params.origin;
    return {
      changed: true,
      requestCreated: false,
      clientFeedUpdates,
      ...(localStateRevision === undefined ? {} : { localStateRevision }),
      ...(pairEffect.threadId === undefined
        ? {}
        : {
            threadId: pairEffect.threadId,
            added: false,
            removed: pairEffect.transitioned,
          }),
    };
  }

  // ─── internals ────────────────────────────────────────────────────────────────

  private async reconcileFriendPairInTx(
    tx: DatabaseTransaction,
    userAId: AccountTarget,
    userBId: AccountTarget,
    desiredActive: boolean,
    departure = { actorUserId: userAId, subjectUserId: userBId },
  ): Promise<{
    active: boolean;
    transitioned: boolean;
    threadId?: number;
    clientFeedUpdates?: Array<{ userId: number; feedId: number }>;
  }> {
    const current = (
      await this.relationshipIntents.readP2PRelationshipInTx(
        tx,
        userAId,
        userBId,
      )
    ).pair;
    if (desiredActive && !current.active) {
      const threadId =
        current.threadId === null
          ? await this.createP2PFriendshipInTx(tx, userAId, userBId)
          : await this.reactivateP2PFriendshipInTx(
              tx,
              current.threadId,
              userAId,
              userBId,
            );
      await this.relationshipIntents.setPairActiveInTx(
        tx,
        userAId,
        userBId,
        true,
      );
      // The relationship read already holds the business scopes and pair row. Acquire only
      // its child content lock, then pass the capability through the message writer.
      const threadLock = await requireP2PThreadContentLockUnderPairInTx(
        tx,
        current.id,
        threadId,
      );
      const recipients = (
        await localAccountsForTargetsInTx(tx, [userAId, userBId])
      ).map((row) => ({ userId: row.id }));
      await this.previews.initializeReadWindowsInTx(
        tx,
        threadId,
        recipients.map((row) => row.userId),
      );
      await initializeRelationshipThreadStateInTx(
        tx,
        threadId,
        current.id,
        threadLock,
      );
      await this.messages.writeSystemMessageInTx(
        tx,
        threadId,
        SystemMessageType.FRIEND_ADDED,
        undefined,
        {
          threadLock,
          actorUserId: userAId,
        },
      );
      const clientFeedUpdates = await tx
        .select({
          userId: accountTable.id,
          feedId: accountTable.stateFeedAllocatedThrough,
        })
        .from(accountTable)
        .where(
          inArray(
            accountTable.id,
            recipients.map((row) => row.userId),
          ),
        )
        .orderBy(accountTable.id);
      return { active: true, transitioned: true, threadId, clientFeedUpdates };
    }
    if (!desiredActive && current.active) {
      let clientFeedUpdates: Array<{ userId: number; feedId: number }> = [];
      if (current.threadId !== null) {
        const threadLock = await requireP2PThreadContentLockUnderPairInTx(
          tx,
          current.id,
          current.threadId,
        );
        const recipients = (
          await localAccountsForTargetsInTx(tx, [userAId, userBId])
        ).map((row) => ({ userId: row.id }));
        const recipientUserIds = recipients.map((row) => row.userId);
        const boundary = await this.messages.writeDepartureMessageInTx(
          tx,
          current.threadId,
          SystemMessageType.FRIEND_REMOVED,
          departure.subjectUserId,
          {
            threadLock,
            actorUserId: departure.actorUserId,
          },
        );
        if (recipientUserIds.length > 0)
          await tx
            .update(accountThreadState)
            .set({
              messageVisibleThroughSeq: boundary.message.seq,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(accountThreadState.threadId, current.threadId),
                inArray(accountThreadState.accountId, recipientUserIds),
              ),
            );
        clientFeedUpdates = await tx
          .select({
            userId: accountTable.id,
            feedId: accountTable.stateFeedAllocatedThrough,
          })
          .from(accountTable)
          .where(inArray(accountTable.id, recipientUserIds))
          .orderBy(accountTable.id);
        await this.closeP2PAudiencesInTx(tx, current.threadId);
      }
      await this.relationshipIntents.setPairActiveInTx(
        tx,
        userAId,
        userBId,
        false,
      );
      return {
        active: false,
        transitioned: true,
        clientFeedUpdates,
        ...(current.threadId === null ? {} : { threadId: current.threadId }),
      };
    }
    return {
      active: current.active,
      transitioned: false,
      ...(current.threadId === null ? {} : { threadId: current.threadId }),
    };
  }

  /** Create a structurally complete, non-visible P2P shell. RelationshipPair owns endpoint identity;
   * AccountThreadState is created only for local accounts and owns client conversation state. */
  private async ensureP2PThreadShellInTx(
    tx: DatabaseTransaction,
    userAId: AccountTarget,
    userBId: AccountTarget,
  ): Promise<number> {
    const pair = await this.relationshipIntents.lockPairInTx(
      tx,
      userAId,
      userBId,
    );
    let threadId = pair.threadId;
    if (threadId === null) {
      const remoteEndpoints = [pair.endpointA, pair.endpointB].filter(
        (endpoint) => endpoint.domain !== 'local',
      );
      if (remoteEndpoints.length > 1)
        throw new Error('P2P thread cannot have two remote endpoints');
      const authorityNamespaceId = remoteEndpoints[0]?.namespaceId ?? 0;
      if (remoteEndpoints.length === 1 && authorityNamespaceId === 0)
        throw new Error('federated P2P thread requires a remote namespace');
      const [thread] = await tx
        .insert(messageThread)
        .values({
          type: MessageThreadType.P2P,
          authorityNamespaceId,
          updatedAt: new Date(),
        })
        .returning({ id: messageThread.id });
      threadId = thread.id;
      await tx
        .update(relationshipPair)
        .set({ threadId, updatedAt: new Date() })
        .where(eq(relationshipPair.id, pair.id));
    }
    const localAccounts = await localAccountsForTargetsInTx(tx, [
      userAId,
      userBId,
    ]);
    const participantRows = localAccounts.map((localAccount) => ({
      accountId: localAccount.id,
      threadId,
    }));
    if (participantRows.length > 0)
      await tx
        .insert(accountThreadState)
        .values(
          participantRows as [
            typeof accountThreadState.$inferInsert,
            ...(typeof accountThreadState.$inferInsert)[],
          ],
        )
        .onConflictDoUpdate({
          target: [accountThreadState.accountId, accountThreadState.threadId],
          set: {
            messageVisibleThroughSeq: null,
            updatedAt: new Date(),
          },
        });
    return threadId;
  }

  /** Close every P2P subscription and remove its current discovery projections. */
  private async closeP2PAudiencesInTx(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<void> {
    const peers = await tx
      .select({ domain: threadAudience.targetDomain })
      .from(threadAudience)
      .where(
        and(
          eq(threadAudience.threadId, threadId),
          sql`${threadAudience.targetDomain} <> 'local'`,
        ),
      );
    for (const peer of peers)
      await closeFederatedAudienceInTx(tx, peer.domain, threadId);
    await tx.execute(sql`
      DELETE FROM "ThreadAudience" audience
      WHERE audience."threadId" = ${threadId}
        AND audience."targetDomain" = 'local'
    `);
  }

  /** Re-open the retained relationship on the same thread. The configured federation history-access
   * policy determines whether the recreated peer audience can query retained messages. */
  private async reactivateP2PFriendshipInTx(
    tx: DatabaseTransaction,
    threadId: number,
    userAId: AccountTarget,
    userBId: AccountTarget,
  ): Promise<number> {
    const [locked] = await tx
      .select({ id: messageThread.id, curSeq: messageThread.curSeq })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!locked) throw new Error('retained P2P thread disappeared');
    const restoredThreadId = await this.ensureP2PThreadShellInTx(
      tx,
      userAId,
      userBId,
    );
    if (restoredThreadId !== threadId)
      throw new Error('retained P2P pair changed thread while locked');
    await this.openP2PAudiencesInTx(tx, threadId, [userAId, userBId]);
    return threadId;
  }

  /** Create the P2P thread, its two roster members, local participant state, and audiences. */
  private async createP2PFriendshipInTx(
    tx: DatabaseTransaction,
    userAId: AccountTarget,
    userBId: AccountTarget,
  ): Promise<number> {
    const threadId = await this.ensureP2PThreadShellInTx(tx, userAId, userBId);
    await this.openP2PAudiencesInTx(tx, threadId, [userAId, userBId]);
    return threadId;
  }

  private async openP2PAudiencesInTx(
    tx: DatabaseTransaction,
    threadId: number,
    endpoints: readonly AccountTarget[],
  ): Promise<void> {
    const locals = await localAccountsForTargetsInTx(tx, endpoints);
    if (locals.length)
      await tx
        .insert(threadAudience)
        .values(
          locals.map((local) => ({
            targetDomain: 'local',
            localUserId: local.id,
            threadId,
          })),
        )
        .onConflictDoNothing();
    const identities = await Promise.all(
      endpoints.map((endpoint) => accountAddressInTx(tx, endpoint)),
    );
    for (const domain of new Set(
      identities
        .filter((endpoint) => endpoint.domain !== 'local')
        .map((endpoint) => endpoint.domain),
    ))
      await openFederatedAudienceInTx(tx, domain, threadId);
  }

  private async requireCurrentPendingIntentInTx(
    tx: DatabaseTransaction,
    id: bigint,
    pairId: bigint,
  ): Promise<void> {
    const current = await tx.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.id, id),
        eq(relationshipIntent.pairId, pairId),
      ),
      columns: { status: true, expiresAt: true },
    });
    if (!current)
      throw new BusinessException(
        BusinessCode.INVITE_NOT_FOUND,
        'request not found',
      );
    if (current.status !== 'REQUESTED')
      throw new BusinessException(
        BusinessCode.INVITE_ALREADY_HANDLED,
        'request already handled',
      );
    if (current.expiresAt === null || current.expiresAt <= new Date())
      throw new BusinessException(
        BusinessCode.INVITE_EXPIRED,
        'request expired',
      );
  }
}
