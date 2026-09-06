import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  account as accountTable,
  group,
  relationshipPair,
  relationshipIntent,
  messageThread,
  threadAudience,
  accountThreadState,
  user,
} from '../database/schema.js';
import { MessageThreadType } from '../database/enums.js';
import { normalizeAccount } from '../common/account.js';
import { loadFederationConfig } from '../federation/federation.config.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { SystemMessageType } from '../message/system-message.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from '../federation/federation-audience.js';
import { RelationshipIntentService } from './relationship-intent.service.js';
import { FederationNamespaceService } from '../federation/federation-namespace.service.js';
import { lockBusinessAccountsInTx } from './business-scope-lock.js';

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
  private readonly config = loadFederationConfig();

  constructor(
    private readonly database: DatabaseService,
    private readonly participantService: AccountThreadStateService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly namespaces: FederationNamespaceService,
    @Optional() private readonly messages?: MessageService,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<MessageFanoutService, 'dispatch'>,
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
        WHERE pair.active = false
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
        groupId: messageThread.groupId,
        account: group.account,
        domain: group.domain,
        name: group.name,
        avatar: group.avatar,
        description: group.description,
        profileRev: group.defaultProfileRev,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!state?.groupId || state.domain !== 'local') return;
    const request = await tx.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorSide, 'A'),
        sql`EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            JOIN "User" identity ON identity.id = ${memberUserId}
            WHERE pair.id = ${relationshipIntent.pairId}
              AND pair."threadId" = ${threadId}
              AND pair."endpointBAccount" = identity.account
              AND pair."endpointBDomain" = identity.domain
              AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
              AND pair."endpointBNamespaceId" = identity."namespaceId"
          )`,
      ),
    });
    const member = await tx.query.user.findFirst({
      where: eq(user.id, memberUserId),
      columns: { account: true },
    });
    if (!request || !member) return;
    const feedId = await this.clientStateFeed.writeInTx(tx, {
      userId: memberUserId,
      account: state.account,
      domain: this.config.domain,
      namespaceId: 0,
      eventType: 'RELATIONSHIP_INTENT',
      subjectAccount: member.account,
      subjectDomain: this.config.domain,
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
          domain: this.config.domain,
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

  /** Create an outbound federated request by immutable Address. The callback materializes the
   * existing remote User shell and writes the authoritative RelationshipIntent. */
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
      const local = await tx.query.user.findFirst({
        where: and(eq(user.id, localUserId), eq(user.domain, 'local')),
        columns: { account: true, domain: true },
      });
      if (!local) throw new Error('local relationship endpoint does not exist');
      await lockBusinessAccountsInTx(tx, [
        local,
        { account, domain: remoteDomain },
      ]);
      const context = await this.namespaces.captureActiveInTx(tx, remoteDomain);
      const remote = await tx.query.user.findFirst({
        where: and(
          eq(user.account, account),
          eq(user.domain, remoteDomain),
          eq(user.namespaceId, context.namespaceId),
        ),
        columns: { id: true },
      });
      const current = remote
        ? (
            await this.relationshipIntents.readP2PRelationshipInTx(
              tx,
              localUserId,
              remote.id,
            )
          ).firstIntent
        : undefined;
      if (
        current?.status === 'REQUESTED' &&
        current.expiresAt !== null &&
        current.expiresAt > now
      ) {
        return { created: false };
      }
      const requestedAt = now;
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      await afterWrite(tx, {
        namespaceId: context.namespaceId,
        requestedAt,
        expiresAt,
        note: trimmed,
        snapshot,
      });
      return { created: true };
    });
    return result;
  }

  /** Relationship state for an exact federated Address, including requests that intentionally have
   * no User stub yet. */
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
      const local = await tx.query.user.findFirst({
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
          ? await tx.query.user.findFirst({
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
    peerUserId: number,
    wantsFriend: boolean,
    note = '',
    peerSnapshot?: FederatedPendingProfileSnapshot,
  ): Promise<Array<{ userId: number; feedId: number }>> {
    const threadId = wantsFriend
      ? await this.ensureP2PThreadShellInTx(tx, actorUserId, peerUserId)
      : null;
    const peer = await tx.query.user.findFirst({
      where: eq(user.id, peerUserId),
      columns: { domain: true },
    });
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
    return this.writeRelationshipRequestClientStateInTx(
      tx,
      actorUserId,
      peerUserId,
      peerSnapshot,
    );
  }

  async writeRelationshipRequestClientStateInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
    secondUserSnapshot?: FederatedPendingProfileSnapshot,
  ): Promise<Array<{ userId: number; feedId: number }>> {
    const first = await tx.query.user.findFirst({
      where: eq(user.id, firstUserId),
    });
    const second = await tx.query.user.findFirst({
      where: eq(user.id, secondUserId),
    });
    const relationship = await this.relationshipIntents.readP2PRelationshipInTx(
      tx,
      firstUserId,
      secondUserId,
    );
    if (!first || !second) throw new Error('client friend intent user missing');
    const users = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    const pending: Array<{ userId: number; feedId: number }> = [];
    const directions = [
      relationship.firstIntent && {
        ...relationship.firstIntent,
        authorUserId: firstUserId,
        subjectUserId: secondUserId,
      },
      relationship.secondIntent && {
        ...relationship.secondIntent,
        authorUserId: secondUserId,
        subjectUserId: firstUserId,
      },
    ].filter((value) => value !== undefined);
    for (const direction of directions) {
      const actor = users.get(direction.authorUserId)!;
      const subject = users.get(direction.subjectUserId)!;
      const commonBody = {
        status:
          direction.status === 'ACCEPTED'
            ? 'ACCEPTED'
            : direction.status === 'REVOKED'
              ? 'REVOKED'
              : 'REQUESTED',
        note: direction.note,
        requestedAt:
          direction.requestedAt === null
            ? null
            : new Date(direction.requestedAt).getTime(),
        expiresAt:
          direction.expiresAt === null
            ? null
            : new Date(direction.expiresAt).getTime(),
      };
      for (const owner of [actor, subject]) {
        if (owner.domain !== 'local' || owner.availability !== 'AVAILABLE')
          continue;
        const peer = owner.id === actor.id ? subject : actor;
        const projectedPeer = this.clientInviteUser(peer);
        if (peer.id === secondUserId && secondUserSnapshot) {
          Object.assign(
            projectedPeer,
            applyFederatedPendingProfileSnapshot(
              projectedPeer,
              secondUserSnapshot,
            ),
          );
        }
        const body = {
          ...commonBody,
          direction: owner.id === actor.id ? 'OUTGOING' : 'INCOMING',
          localThreadId: relationship.pair.threadId,
          peer: projectedPeer,
        };
        const feedId = await this.clientStateFeed.writeInTx(tx, {
          userId: owner.id,
          account: actor.account,
          domain: actor.domain,
          namespaceId: peer.namespaceId,
          eventType: 'RELATIONSHIP_INTENT',
          subjectAccount: subject.account,
          subjectDomain: subject.domain,
          body,
        });
        if (feedId !== null) pending.push({ userId: owner.id, feedId });
      }
    }
    return pending;
  }

  private clientInviteUser(value: typeof user.$inferSelect) {
    return {
      id: value.id,
      account: value.account,
      name: value.name,
      avatar: value.avatar,
      bio: value.bio,
      domain: value.domain,
      profileRev: value.defaultProfileRev,
    };
  }

  /** Rejection/deletion closes only the actor's direction. The opposite request remains valid and may
   * intentionally reactivate the relationship when this direction is requested again. */
  async closeLocalP2PIntentInTx(
    tx: DatabaseTransaction,
    userAId: number,
    userBId: number,
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
        JOIN "User" self ON self.id = ${me}
        JOIN "User" peer ON peer.id IN (${sql.join(
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
    if (
      result.status === 'auto-accepted' &&
      this.messages &&
      this.messageFanout
    ) {
      const system = await this.messages.tryWriteSystemMessage(
        result.threadId,
        SystemMessageType.FRIEND_ADDED,
      );
      if (system) void this.messageFanout.dispatch(system);
    }
    return result;
  }

  /** Create or refresh one group membership invitation. */
  async createGroupInvite(
    fromUserId: number,
    threadId: number,
    toUserId: number,
    note = '',
    afterWrite?: (tx: DatabaseTransaction) => Promise<void>,
  ): Promise<string> {
    const trimmed = (note ?? '').slice(0, 255);
    return this.database.db.transaction(async (tx) => {
      const target = await tx.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { groupId: true },
      });
      if (!target?.groupId) throw new Error('group invite target is invalid');
      await this.relationshipIntents.lockGroupMutationInTx(tx, {
        groupId: target.groupId,
        memberUserId: toUserId,
        threadId,
        projectionUserIds: [fromUserId],
      });
      if (afterWrite) await afterWrite(tx);
      else
        await this.relationshipIntents.writeGroupAuthoredIntentInTx(tx, {
          groupId: target.groupId,
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
            JOIN "User" member_identity ON member_identity.id = ${toUserId}
            WHERE pair.id = ${relationshipIntent.pairId}
              AND pair."threadId" = ${threadId}
              AND pair."endpointBAccount" = member_identity.account
              AND pair."endpointBDomain" = member_identity.domain
              AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
              AND pair."endpointBNamespaceId" = member_identity."namespaceId"
          )`,
        ),
        columns: {
          id: true,
        },
      });
      if (!request) throw new Error('group request write disappeared');
      const memberIdentity = await tx.query.user.findFirst({
        where: eq(user.id, toUserId),
        columns: { domain: true },
      });
      if (!memberIdentity)
        throw new Error('group invite member identity missing');
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
          const peer = await tx.query.user.findFirst({
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
    if (result.threadId !== undefined && this.messages && this.messageFanout) {
      const system = await this.messages.tryWriteSystemMessage(
        result.threadId,
        SystemMessageType.FRIEND_ADDED,
      );
      if (system) void this.messageFanout.dispatch(system);
    }
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
      peerUserId: number;
      status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
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
        profileRev: params.profileRev,
        note: params.note,
        requestedAt: params.status === 'REVOKED' ? null : params.requestedAt,
        expiresAt: params.status === 'REQUESTED' ? params.expiresAt : null,
      },
    );
    if (!applied.changed)
      return { changed: false, requestCreated: false, clientFeedUpdates: [] };
    const localStateRevision =
      applied.publishAccepted || applied.reverseChanged ? 1 : undefined;
    const pairEffect = await this.reconcileFriendPairInTx(
      tx,
      params.localUserId,
      params.peerUserId,
      applied.shouldBeActive,
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
    const clientFeedUpdates =
      await this.writeRelationshipRequestClientStateInTx(
        tx,
        params.localUserId,
        params.peerUserId,
      );
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
    userAId: number,
    userBId: number,
    desiredActive: boolean,
  ): Promise<{ active: boolean; transitioned: boolean; threadId?: number }> {
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
      return { active: true, transitioned: true, threadId };
    }
    if (!desiredActive && current.active) {
      if (current.threadId !== null) {
        // Relationship-write gate: message creation updates this row before re-checking participant
        // access. This lock is not needed by the audience/feed boundary itself.
        await tx
          .select({ id: messageThread.id })
          .from(messageThread)
          .where(eq(messageThread.id, current.threadId))
          .for('update')
          .limit(1);
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
    userAId: number,
    userBId: number,
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
    const localAccounts = await tx
      .select({ id: accountTable.id })
      .from(accountTable)
      .where(inArray(accountTable.id, [userAId, userBId]));
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
    userAId: number,
    userBId: number,
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
    const participants = await tx
      .select({
        id: user.id,
        domain: user.domain,
      })
      .from(user)
      .where(inArray(user.id, [userAId, userBId]));
    if (participants.length !== 2)
      throw new Error('retained P2P audience participants disappeared');
    const localAudiences = participants
      .filter((participant) => participant.domain === 'local')
      .map((participant) => ({
        targetDomain: 'local',
        localUserId: participant.id,
        threadId,
      }));
    if (localAudiences.length > 0)
      await tx
        .insert(threadAudience)
        .values(localAudiences)
        .onConflictDoNothing();
    const peerDomains = new Set(
      participants
        .map((participant) => participant.domain)
        .filter((domain) => domain !== 'local'),
    );
    for (const peerDomain of peerDomains)
      await openFederatedAudienceInTx(tx, peerDomain, threadId);
    return threadId;
  }

  /** Create the P2P thread, its two roster members, local participant state, and audiences. */
  private async createP2PFriendshipInTx(
    tx: DatabaseTransaction,
    userAId: number,
    userBId: number,
  ): Promise<number> {
    const threadId = await this.ensureP2PThreadShellInTx(tx, userAId, userBId);
    const participants = await tx
      .select({
        id: user.id,
        account: user.account,
        domain: user.domain,
      })
      .from(user)
      .where(inArray(user.id, [userAId, userBId]));
    if (participants.length !== 2) {
      throw new Error('P2P audience participants are missing');
    }

    const localAudience = participants
      .filter((participant) => participant.domain === 'local')
      .map((participant) => ({
        targetDomain: 'local',
        localUserId: participant.id,
        threadId,
      }));
    const peerDomains = [
      ...new Set(
        participants
          .map((participant) => participant.domain)
          .filter((domain) => domain !== 'local'),
      ),
    ];
    if (localAudience.length > 0)
      await tx
        .insert(threadAudience)
        .values(localAudience)
        .onConflictDoNothing();
    for (const peerDomain of peerDomains)
      await openFederatedAudienceInTx(tx, peerDomain, threadId);
    return threadId;
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
