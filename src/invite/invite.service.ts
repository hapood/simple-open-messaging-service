import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  account as accountTable,
  group,
  relationshipPair,
  federatedFriendRequest,
  relationshipIntent,
  groupAuditLog,
  messageThread,
  threadAudience,
  threadMember,
  threadParticipant,
  user,
} from '../database/schema.js';
import { MessageThreadType } from '../database/enums.js';
import { normalizeAccount } from '../common/account.js';
import { loadFederationConfig } from '../federation/federation.config.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { assertServerGroupCapacityInTx } from '../group/group-capacity.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from '../federation/federation-audience.js';
import { RelationshipIntentService } from './relationship-intent.service.js';

/** Friend + group invite TTL: 7 days. Validated at accept time; the background sweep/GC is deferred
 *  (a row stays PENDING past expiry until then — the client renders an "expired" prompt from
 *  `expiresAt`, and accept rejects an expired row with INVITE_EXPIRED as defense-in-depth). */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** One-shot cap for the parameterless incoming/outgoing endpoints. */
const LIST_LIMIT = 200;
const RELATIONSHIP_SHELL_GC_INTERVAL_MS = 60 * 60 * 1000;

export type CreateFriendInviteResult =
  | { status: 'created'; inviteId: string }
  | { status: 'already-pending'; inviteId: string }
  | { status: 'auto-accepted'; threadId: number };

export type AcceptInviteResult =
  | { kind: 'FRIEND'; threadId?: number; fromUserId: number }
  | {
      kind: 'GROUP';
      threadId: number;
      fedGroupAccount: string | null; // non-null ⇒ a cross-server group mirror
      originDomain: string | null; // the group's home domain (origin-propagation target)
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

/** Fields selected for the embedded inviter/recipient profile on list queries (never hashPwd — it is
 *  sensitive). */
const USER_SELECT = {
  id: true,
  account: true,
  name: true,
  avatar: true,
  domain: true,
} as const;

/**
 * Invite domain — the single home for friend-add and group-invite requests (unified). An invite is
 * a server-stored entity with an expiry, delivered to `toUserId` and accepted by sending its id back.
 *
 * Duplicate = new overwrites old: a PENDING re-create hits the migration's partial unique index
 * (FRIEND on (from,to); GROUP on (to,thread)) and we refresh the existing row in place rather than
 * erroring. Rows are never hard-deleted (kept as history; a future GC sweep flips stale PENDING →
 * EXPIRED). Expiry is validated at accept time only.
 *
 * New incoming requests are recorded in the recipient's unified client-state revision. The service remains
 * decoupled from federation + SSE; the controller owns S2S delivery and live signals after commit.
 */
@Injectable()
export class InviteService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly database: DatabaseService,
    private readonly participantService: ThreadParticipantService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly relationshipIntents: RelationshipIntentService,
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
          AND NOT EXISTS (
            SELECT 1 FROM "FederatedFriendRequest" request
            WHERE request.status IN ('REQUESTED', 'ACCEPTED')
              AND (request.status = 'ACCEPTED' OR request."expiresAt" > CURRENT_TIMESTAMP)
              AND (
                EXISTS (
                  SELECT 1 FROM "User" local_identity
                  WHERE local_identity.id = request."localUserId"
                    AND ((local_identity.account = pair."endpointAAccount"
                      AND local_identity.domain = pair."endpointADomain"
                      AND request."remoteAccount" = pair."endpointBAccount"
                      AND request."remoteDomain" = pair."endpointBDomain")
                    OR (local_identity.account = pair."endpointBAccount"
                      AND local_identity.domain = pair."endpointBDomain"
                      AND request."remoteAccount" = pair."endpointAAccount"
                      AND request."remoteDomain" = pair."endpointADomain"))
                )
              )
          )
        FOR UPDATE OF pair, thread SKIP LOCKED
      `);
      const ids = candidates.rows.map((row) => row.threadId);
      if (ids.length > 0) {
        await tx
          .delete(threadParticipant)
          .where(inArray(threadParticipant.threadId, ids));
        await tx
          .delete(threadMember)
          .where(inArray(threadMember.threadId, ids));
        await tx.delete(messageThread).where(inArray(messageThread.id, ids));
      }
      await tx.execute(sql`
        DELETE FROM "FederatedFriendRequest"
        WHERE status = 'REQUESTED' AND "expiresAt" <= CURRENT_TIMESTAMP
      `);
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
        profileRev: group.profileRev,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!state?.groupId || state.domain !== 'local') return;
    const [request, member] = await Promise.all([
      tx.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorSide, 'A'),
          sql`EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            JOIN "User" identity ON identity.id = ${memberUserId}
            WHERE pair.id = ${relationshipIntent.pairId}
              AND pair."threadId" = ${threadId}
              AND pair."endpointBAccount" = identity.account
              AND pair."endpointBDomain" = identity.domain
          )`,
        ),
      }),
      tx.query.user.findFirst({
        where: eq(user.id, memberUserId),
        columns: { account: true },
      }),
    ]);
    if (!request || !member) return;
    const feedId = await this.clientStateFeed.writeInTx(tx, {
      userId: memberUserId,
      account: state.account,
      domain: this.config.domain,
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

  /** Create an outbound federated request by immutable Address without materializing a User stub.
   * The optional display snapshot came from the caller's temporary resolve stream and is deliberately
   * presentation-only. FederationService owns the authoritative state-feed write in the callback. */
  async createFederatedFriendInvite(
    localUserId: number,
    remoteAccount: string,
    remoteDomain: string,
    note: string,
    snapshot: FederatedPendingProfileSnapshot,
    afterWrite: (
      tx: DatabaseTransaction,
      state: {
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
      const [current] = await tx
        .select({
          status: federatedFriendRequest.status,
          expiresAt: federatedFriendRequest.expiresAt,
        })
        .from(federatedFriendRequest)
        .where(
          and(
            eq(federatedFriendRequest.localUserId, localUserId),
            eq(federatedFriendRequest.remoteAccount, account),
            eq(federatedFriendRequest.remoteDomain, remoteDomain),
            eq(federatedFriendRequest.direction, 'OUTGOING'),
          ),
        )
        .for('update')
        .limit(1);
      if (
        current?.status === 'REQUESTED' &&
        current.expiresAt !== null &&
        current.expiresAt > now
      ) {
        return { created: false };
      }
      const requestedAt = now;
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      await tx
        .insert(federatedFriendRequest)
        .values({
          localUserId,
          remoteAccount: account,
          remoteDomain,
          direction: 'OUTGOING',
          status: 'REQUESTED',
          note: trimmed,
          requestedAt,
          expiresAt,
          displayName: snapshot.displayName?.slice(0, 30) || null,
          avatar: snapshot.avatar || null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            federatedFriendRequest.localUserId,
            federatedFriendRequest.remoteDomain,
            federatedFriendRequest.remoteAccount,
            federatedFriendRequest.direction,
          ],
          set: {
            status: 'REQUESTED',
            note: trimmed,
            requestedAt,
            expiresAt,
            displayName: snapshot.displayName?.slice(0, 30) || null,
            avatar: snapshot.avatar || null,
            updatedAt: now,
          },
        });
      await afterWrite(tx, {
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
    const account = normalizeAccount(remoteAccount);
    const stub = await this.database.db.query.user.findFirst({
      where: and(eq(user.account, account), eq(user.domain, remoteDomain)),
      columns: { id: true },
    });
    if (
      stub &&
      (await this.participantService.areFriends(localUserId, stub.id))
    )
      return 'FRIEND';
    const rows = await this.database.db
      .select({
        direction: federatedFriendRequest.direction,
        status: federatedFriendRequest.status,
        expiresAt: federatedFriendRequest.expiresAt,
      })
      .from(federatedFriendRequest)
      .where(
        and(
          eq(federatedFriendRequest.localUserId, localUserId),
          eq(federatedFriendRequest.remoteAccount, account),
          eq(federatedFriendRequest.remoteDomain, remoteDomain),
        ),
      );
    const active = rows.filter(
      (row) =>
        row.status === 'REQUESTED' &&
        row.expiresAt !== null &&
        row.expiresAt > new Date(),
    );
    if (active.some((row) => row.direction === 'INCOMING'))
      return 'INCOMING_PENDING';
    if (active.some((row) => row.direction === 'OUTGOING'))
      return 'OUTGOING_PENDING';
    return 'NONE';
  }

  /** Apply one locally-authored direction. Purely local pairs use this same state machine but emit no
   * peer feed. The canonical pair row is locked before either directed request is inspected. */
  async writeLocalFriendIntentInTx(
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
    return this.writeFriendRequestClientStateInTx(
      tx,
      actorUserId,
      peerUserId,
      peerSnapshot,
    );
  }

  async writeFriendRequestClientStateInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
    secondUserSnapshot?: FederatedPendingProfileSnapshot,
  ): Promise<Array<{ userId: number; feedId: number }>> {
    const [first, second, relationship] = await Promise.all([
      tx.query.user.findFirst({ where: eq(user.id, firstUserId) }),
      tx.query.user.findFirst({ where: eq(user.id, secondUserId) }),
      this.relationshipIntents.readP2PRelationshipInTx(
        tx,
        firstUserId,
        secondUserId,
      ),
    ]);
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
        inviteId: direction.id.toString(),
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
    };
  }

  /** Rejection/deletion closes only the actor's direction. The opposite request remains valid and may
   * intentionally reactivate the relationship when this direction is requested again. */
  async closeLocalFriendIntentInTx(
    tx: DatabaseTransaction,
    userAId: number,
    userBId: number,
    reason = '',
  ): Promise<void> {
    await this.writeLocalFriendIntentInTx(tx, userAId, userBId, false, reason);
  }

  /**
   * Authoritative relationship state for discovery UI. FRIEND takes precedence over stale pending
   * rows; only unexpired PENDING invites count. The result contains every requested id so clients do
   * not need to infer missing rows.
   */
  async friendRelationshipStatuses(
    me: number,
    requestedUserIds: number[],
  ): Promise<
    Array<{
      userId: number;
      status: FriendRelationshipState;
      inviteId?: string;
    }>
  > {
    const userIds = [...new Set(requestedUserIds)].filter((id) => id !== me);
    if (userIds.length === 0) return [];

    const [friendIds, requestRows] = await Promise.all([
      this.participantService.getActiveP2PPeerUserIds(me),
      this.database.db.execute<{
        id: bigint;
        peerUserId: number;
        direction: 'INCOMING' | 'OUTGOING';
      }>(sql`
        SELECT intent.id, peer.id AS "peerUserId",
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
        JOIN "User" peer ON peer.id = ANY(${userIds}::int[])
         AND ((peer.account = pair."endpointAAccount" AND peer.domain = pair."endpointADomain")
           OR (peer.account = pair."endpointBAccount" AND peer.domain = pair."endpointBDomain"))
        WHERE pair.kind = 'P2P'
          AND intent.status = 'REQUESTED'
          AND intent."expiresAt" > CURRENT_TIMESTAMP
          AND ((self.account = pair."endpointAAccount" AND self.domain = pair."endpointADomain")
            OR (self.account = pair."endpointBAccount" AND self.domain = pair."endpointBDomain"))
          AND peer.id <> self.id
      `),
    ]);
    const requests = requestRows.rows;
    const friends = new Set(friendIds);
    const outgoing = new Map(
      requests
        .filter((request) => request.direction === 'OUTGOING')
        .map((request) => [request.peerUserId, request.id.toString()]),
    );
    const incoming = new Map(
      requests
        .filter((request) => request.direction === 'INCOMING')
        .map((request) => [request.peerUserId, request.id.toString()]),
    );

    return userIds.map((userId) => {
      if (friends.has(userId)) return { userId, status: 'FRIEND' };
      const outgoingId = outgoing.get(userId);
      if (outgoingId)
        return { userId, status: 'OUTGOING_PENDING', inviteId: outgoingId };
      const incomingId = incoming.get(userId);
      if (incomingId)
        return { userId, status: 'INCOMING_PENDING', inviteId: incomingId };
      return { userId, status: 'NONE' };
    });
  }

  /**
   * Create (or refresh) a friend invite from→to. Local-only mutual auto-accept: when allowed and the
   * target already has a PENDING friend invite back to the caller, skip creating and form the
   * friendship immediately. Federated targets pass allowAutoAccept=false (cross-server accept needs
   * an S2S round-trip; the recipient accepts the delivered invite explicitly instead).
   */
  async createFriendInvite(
    fromUserId: number,
    toUserId: number,
    note: string,
    allowAutoAccept: boolean,
    originIdOverride?: string,
    afterInviteWrite?: (
      tx: DatabaseTransaction,
      created: boolean,
    ) => Promise<void>,
  ): Promise<CreateFriendInviteResult> {
    const trimmed = (note ?? '').slice(0, 255);
    const pendingFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    const result = await this.database.db.transaction<CreateFriendInviteResult>(
      async (tx) => {
        void allowAutoAccept;
        void originIdOverride;
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
        if (afterInviteWrite) await afterInviteWrite(tx, created);
        else
          pendingFeedUpdates.push(
            ...(await this.writeLocalFriendIntentInTx(
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
          ? { status: 'created', inviteId: request.id.toString() }
          : { status: 'already-pending', inviteId: request.id.toString() };
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

  /** Create or refresh one group membership invitation and its append-only origin audit entry. */
  async createGroupInvite(
    fromUserId: number,
    threadId: number,
    toUserId: number,
    note = '',
    originOverride?: { origin: string; originId: string },
    afterWrite?: (tx: DatabaseTransaction) => Promise<void>,
  ): Promise<string> {
    const trimmed = (note ?? '').slice(0, 255);
    void originOverride;
    return this.database.db.transaction(async (tx) => {
      const target = await tx.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { groupId: true },
      });
      if (!target?.groupId) throw new Error('group invite target is invalid');
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
          )`,
        ),
        columns: {
          id: true,
          requestedAt: true,
          expiresAt: true,
        },
      });
      if (!request) throw new Error('group request write disappeared');
      const [groupIdentity, memberIdentity, actorIdentity] = await Promise.all([
        tx.query.group.findFirst({
          where: eq(group.id, target.groupId),
          columns: { account: true, domain: true },
        }),
        tx.query.user.findFirst({
          where: eq(user.id, toUserId),
          columns: { account: true, domain: true },
        }),
        tx.query.user.findFirst({
          where: eq(user.id, fromUserId),
          columns: { account: true, domain: true },
        }),
      ]);
      if (!groupIdentity || !memberIdentity || !actorIdentity)
        throw new Error('group invite audit identity missing');
      const groupDomain =
        groupIdentity.domain === 'local'
          ? this.config.domain
          : groupIdentity.domain;
      const memberDomain =
        memberIdentity.domain === 'local'
          ? this.config.domain
          : memberIdentity.domain;
      const actorDomain =
        actorIdentity.domain === 'local'
          ? this.config.domain
          : actorIdentity.domain;
      await tx
        .insert(groupAuditLog)
        .values({
          eventKey: `invite:${groupDomain}:${groupIdentity.account}:${memberDomain}:${memberIdentity.account}:${request.requestedAt?.getTime() ?? 0}:requested`,
          groupId: target.groupId,
          groupAccount: groupIdentity.account,
          groupDomain,
          actorType: 'USER',
          actorUserId: fromUserId,
          actorAccount: actorIdentity.account,
          actorDomain,
          action: 'group.invite.requested',
          targetType: 'group_member',
          targetId: `${memberIdentity.account}@${memberDomain}`,
          meta: {
            memberAccount: memberIdentity.account,
            memberDomain,
            requestedAt: request.requestedAt?.getTime() ?? null,
            expiresAt: request.expiresAt?.getTime() ?? null,
            note: trimmed,
          },
        })
        .onConflictDoNothing({ target: groupAuditLog.eventKey });
      if (memberIdentity.domain !== 'local')
        await openFederatedAudienceInTx(tx, memberIdentity.domain, threadId);
      return request.id.toString();
    });
  }

  /**
   * Accept a pending invite addressed to `byUserId`. FRIEND → mint the P2P thread + both
   * participants + mark this invite ACCEPTED, and mark every OTHER pending friend invite between the
   * pair (both directions) ACCEPTED (symmetric cleanup). GROUP → add/reactivate the caller as a
   * MEMBER + mark ACCEPTED. Validates PENDING, ownership, and expiry.
   */
  async acceptInvite(
    inviteIdOrGroup: string,
    byUserId: number,
    afterFriendAccept?: (
      tx: DatabaseTransaction,
      fromUserId: number,
    ) => Promise<void>,
    afterGroupJoin?: (
      tx: DatabaseTransaction,
      threadId: number,
    ) => Promise<void>,
  ): Promise<AcceptInviteResult> {
    const id = await this.resolveInviteId(inviteIdOrGroup, byUserId, true);
    const pendingFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    const result = await this.database.db.transaction(
      async (tx): Promise<AcceptInviteResult> => {
        const [invite] = await tx
          .select({ intent: relationshipIntent, pair: relationshipPair })
          .from(relationshipIntent)
          .innerJoin(
            relationshipPair,
            eq(relationshipPair.id, relationshipIntent.pairId),
          )
          .where(eq(relationshipIntent.id, id))
          .limit(1);
        if (!invite)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_FOUND,
            'request not found',
          );
        if (invite.intent.status !== 'REQUESTED')
          throw new BusinessException(
            BusinessCode.INVITE_ALREADY_HANDLED,
            'request already handled',
          );
        if (
          invite.intent.expiresAt &&
          invite.intent.expiresAt.getTime() <= Date.now()
        )
          throw new BusinessException(
            BusinessCode.INVITE_EXPIRED,
            'request expired',
          );
        const recipient = await tx.query.user.findFirst({
          where: eq(user.id, byUserId),
          columns: { account: true, domain: true },
        });
        if (!recipient)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_YOURS,
            'request recipient missing',
          );
        const recipientSide =
          invite.pair.endpointAType === 'USER' &&
          invite.pair.endpointAAccount === recipient.account &&
          invite.pair.endpointADomain === recipient.domain
            ? 'A'
            : invite.pair.endpointBType === 'USER' &&
                invite.pair.endpointBAccount === recipient.account &&
                invite.pair.endpointBDomain === recipient.domain
              ? 'B'
              : null;
        if (!recipientSide || invite.intent.authorSide === recipientSide)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_YOURS,
            'this request is not yours to accept',
          );

        if (invite.pair.kind === 'P2P') {
          const requesterAddress =
            invite.intent.authorSide === 'A'
              ? {
                  account: invite.pair.endpointAAccount,
                  domain: invite.pair.endpointADomain,
                }
              : {
                  account: invite.pair.endpointBAccount,
                  domain: invite.pair.endpointBDomain,
                };
          const requester = await tx.query.user.findFirst({
            where: and(
              eq(user.account, requesterAddress.account),
              eq(user.domain, requesterAddress.domain),
              eq(user.sourceDomain, requesterAddress.domain),
            ),
          });
          if (!requester)
            throw new BusinessException(
              BusinessCode.INVITE_NOT_FOUND,
              'requester profile missing',
            );
          if (afterFriendAccept) await afterFriendAccept(tx, requester.id);
          else
            pendingFeedUpdates.push(
              ...(await this.writeLocalFriendIntentInTx(
                tx,
                byUserId,
                requester.id,
                true,
              )),
            );
          const state = await this.relationshipIntents.readP2PRelationshipInTx(
            tx,
            byUserId,
            requester.id,
          );
          if (!state.pair.active || state.pair.threadId === null) {
            if (requester.domain === 'local')
              throw new Error(
                'local mutual friend requests did not activate the pair',
              );
            return { kind: 'FRIEND', fromUserId: requester.id };
          }
          return {
            kind: 'FRIEND',
            threadId: state.pair.threadId,
            fromUserId: requester.id,
          };
        }

        const threadId = invite.pair.threadId;
        if (invite.pair.kind !== 'GROUP_MEMBER' || threadId === null)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_FOUND,
            'group mirror missing',
          );
        const [groupState] = await tx
          .select({
            dissolvedAt: group.dissolvedAt,
            account: group.account,
            domain: group.domain,
          })
          .from(messageThread)
          .innerJoin(group, eq(group.id, messageThread.groupId))
          .where(eq(messageThread.id, threadId))
          .limit(1);
        if (groupState?.dissolvedAt != null)
          throw new BusinessException(
            BusinessCode.GROUP_DISSOLVED,
            'group dissolved',
          );
        const isMirror = !!groupState?.domain && groupState.domain !== 'local';
        if (!isMirror) {
          await assertServerGroupCapacityInTx(tx, threadId, byUserId);
        }
        if (afterGroupJoin) await afterGroupJoin(tx, threadId);
        await tx
          .insert(threadAudience)
          .values({
            targetDomain: 'local',
            localUserId: byUserId,
            threadId,
          })
          .onConflictDoNothing();
        const groupAccount = groupState?.account ?? null;
        const groupDomain = groupState?.domain ?? null;
        if (groupDomain && groupDomain !== 'local') {
          await openFederatedAudienceInTx(tx, groupDomain, threadId);
        }
        return {
          kind: 'GROUP',
          threadId,
          fedGroupAccount: groupAccount, // the group `!account` (S2S 'to'); non-null for any group
          originDomain:
            groupDomain && groupDomain !== 'local' ? groupDomain : null, // non-null = federated mirror
        };
      },
    );
    // Notify local devices only after the client-state writes commit.
    this.clientStateFeed.notifyFeedUpdates(pendingFeedUpdates);
    if (
      result.kind === 'FRIEND' &&
      result.threadId !== undefined &&
      this.messages &&
      this.messageFanout
    ) {
      const system = await this.messages.tryWriteSystemMessage(
        result.threadId,
        SystemMessageType.FRIEND_ADDED,
      );
      if (system) void this.messageFanout.dispatch(system);
    }
    if (this.messages && this.messageFanout) {
      if (result.kind === 'GROUP') {
        // System messages are server-local timeline decorations. Membership itself is maintained by
        // the host relationship state machine or by an authoritative remote GROUP_META roster.
        const joined = await this.messages.tryWriteSystemMessage(
          result.threadId,
          SystemMessageType.GROUP_JOINED,
          byUserId,
        );
        if (joined) void this.messageFanout.dispatch(joined);
      }
    }
    return result;
  }

  /** Revoke my own outgoing pending invite. */
  async revokeInvite(
    inviteId: string,
    byUserId: number,
    afterRevoke?: (tx: DatabaseTransaction, toUserId: number) => Promise<void>,
  ): Promise<void> {
    const id = this.parseInviteId(inviteId);
    const pendingFeedUpdates: Array<{ userId: number; feedId: number }> = [];
    await this.database.db.transaction(async (tx) => {
      const relationship = await this.loadP2PIntentPartiesInTx(tx, id);
      const request = relationship?.intent;
      if (!request || request.status !== 'REQUESTED') {
        throw new BusinessException(
          !request
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          !request ? 'request not found' : 'request already handled',
        );
      }
      if (relationship.authorUserId !== byUserId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this request is not yours to revoke',
        );
      }
      if (afterRevoke) await afterRevoke(tx, relationship.subjectUserId);
      else
        pendingFeedUpdates.push(
          ...(await this.writeLocalFriendIntentInTx(
            tx,
            byUserId,
            relationship.subjectUserId,
            false,
          )),
        );
    });
    this.clientStateFeed.notifyFeedUpdates(pendingFeedUpdates);
  }

  /** Reject an incoming pending invite by authoring the recipient's REVOKED direction. */
  async rejectInvite(
    inviteId: string,
    byUserId: number,
    afterReject: (tx: DatabaseTransaction, fromUserId: number) => Promise<void>,
  ): Promise<void> {
    const id = this.parseInviteId(inviteId);
    await this.database.db.transaction(async (tx) => {
      const relationship = await this.loadP2PIntentPartiesInTx(tx, id);
      const request = relationship?.intent;
      if (!request || request.status !== 'REQUESTED')
        throw new BusinessException(
          !request
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          !request ? 'request not found' : 'request already handled',
        );
      if (relationship.subjectUserId !== byUserId)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this request is not yours to reject',
        );
      await afterReject(tx, relationship.authorUserId);
    });
  }

  /**
   * Incoming PENDING friend invites for `userId`, newest first, last-7-days, ≤200. No client params.
   * The caller (controller) filters out any whose inviter is already a friend.
   */
  async listIncoming(userId: number) {
    const since = new Date(Date.now() - INVITE_TTL_MS);
    const [local, federated] = await Promise.all([
      this.listFriendInvites(userId, 'INCOMING', since),
      this.listFederatedFriendInvites(userId, 'INCOMING'),
    ]);
    return [...local, ...federated]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, LIST_LIMIT);
  }

  /** Outgoing PENDING friend invites from `userId`, newest first, last-7-days, ≤200. */
  async listOutgoing(userId: number) {
    const since = new Date(Date.now() - INVITE_TTL_MS);
    const [local, federated] = await Promise.all([
      this.listFriendInvites(userId, 'OUTGOING', since),
      this.listFederatedFriendInvites(userId, 'OUTGOING'),
    ]);
    return [...local, ...federated]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, LIST_LIMIT);
  }

  private async listFederatedFriendInvites(
    localUserId: number,
    direction: 'INCOMING' | 'OUTGOING',
  ) {
    const local = await this.database.db.query.user.findFirst({
      where: eq(user.id, localUserId),
      columns: USER_SELECT,
    });
    if (!local) return [];
    const rows = await this.database.db
      .select()
      .from(federatedFriendRequest)
      .where(
        and(
          eq(federatedFriendRequest.localUserId, localUserId),
          eq(federatedFriendRequest.direction, direction),
          eq(federatedFriendRequest.status, 'REQUESTED'),
          gt(federatedFriendRequest.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(federatedFriendRequest.requestedAt))
      .limit(LIST_LIMIT);
    return rows.map((row) => {
      const remote = {
        id: 0,
        account: row.remoteAccount,
        name: row.displayName ?? row.remoteAccount,
        avatar: row.avatar ?? '',
        domain: row.remoteDomain,
      };
      return {
        // List identity only. Mutations select this request by the explicit peer Address.
        id: `${row.remoteDomain}\u0000${row.remoteAccount}`,
        kind: 'FRIEND' as const,
        fromUserId: direction === 'INCOMING' ? 0 : localUserId,
        toUserId: direction === 'INCOMING' ? localUserId : 0,
        threadId: null,
        note: row.note,
        status: 'PENDING' as const,
        expiresAt: row.expiresAt ?? new Date(0),
        createdAt: row.requestedAt ?? row.createdAt,
        updatedAt: row.updatedAt,
        fromUser: direction === 'INCOMING' ? remote : local,
        toUser: direction === 'INCOMING' ? local : remote,
      };
    });
  }

  private async listFriendInvites(
    userId: number,
    direction: 'INCOMING' | 'OUTGOING',
    since: Date,
  ) {
    const result = await this.database.db.execute<{
      id: bigint;
      note: string;
      requestedAt: Date;
      expiresAt: Date;
      updatedAt: Date;
      peerId: number;
      peerAccount: string;
      peerName: string;
      peerAvatar: string;
      peerDomain: string;
      selfAccount: string;
      selfName: string;
      selfAvatar: string;
      selfDomain: string;
      actualDirection: 'INCOMING' | 'OUTGOING';
    }>(sql`
      SELECT intent.id, intent.note, intent."requestedAt", intent."expiresAt",
        intent."updatedAt", peer.id AS "peerId", peer.account AS "peerAccount",
        peer.name AS "peerName", peer.avatar AS "peerAvatar", peer.domain AS "peerDomain",
        self.account AS "selfAccount", self.name AS "selfName",
        self.avatar AS "selfAvatar", self.domain AS "selfDomain",
        CASE WHEN (intent."authorSide" = 'A' AND pair."endpointAAccount" = self.account
              AND pair."endpointADomain" = self.domain)
            OR (intent."authorSide" = 'B' AND pair."endpointBAccount" = self.account
              AND pair."endpointBDomain" = self.domain)
          THEN 'OUTGOING' ELSE 'INCOMING' END AS "actualDirection"
      FROM "RelationshipIntent" intent
      JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
      JOIN "User" self ON self.id = ${userId}
      JOIN "User" peer ON peer.id <> self.id
        AND peer."sourceDomain" = peer.domain
        AND (((self.account = pair."endpointAAccount" AND self.domain = pair."endpointADomain")
          AND peer.account = pair."endpointBAccount" AND peer.domain = pair."endpointBDomain")
        OR ((self.account = pair."endpointBAccount" AND self.domain = pair."endpointBDomain")
          AND peer.account = pair."endpointAAccount" AND peer.domain = pair."endpointADomain"))
      WHERE pair.kind = 'P2P' AND intent.status = 'REQUESTED'
        AND intent."expiresAt" > CURRENT_TIMESTAMP
        AND intent."requestedAt" > ${since}
      ORDER BY intent."requestedAt" DESC
      LIMIT ${LIST_LIMIT}
    `);
    const self = await this.database.db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: USER_SELECT,
    });
    if (!self) return [];
    return result.rows
      .filter((row) => row.actualDirection === direction)
      .map((row) => {
        const peer = {
          id: row.peerId,
          account: row.peerAccount,
          name: row.peerName,
          avatar: row.peerAvatar,
          domain: row.peerDomain,
        };
        return {
          id: row.id.toString(),
          kind: 'FRIEND' as const,
          fromUserId: direction === 'INCOMING' ? peer.id : self.id,
          toUserId: direction === 'INCOMING' ? self.id : peer.id,
          threadId: null,
          note: row.note,
          status: 'PENDING' as const,
          expiresAt: row.expiresAt,
          createdAt: row.requestedAt,
          updatedAt: row.updatedAt,
          fromUser: direction === 'INCOMING' ? peer : self,
          toUser: direction === 'INCOMING' ? self : peer,
        };
      });
  }

  /** Revision-gated remote intent application. This runs inside the state-feed page transaction;
   * the pair row is also the lock that serializes crossed requests. */
  async applyRemoteFriendIntentInTx(
    tx: DatabaseTransaction,
    params: {
      localUserId: number;
      peerUserId: number;
      status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
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
    const clientFeedUpdates = await this.writeFriendRequestClientStateInTx(
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

  /** Create a structurally complete, non-visible P2P shell. Directional federation authorization
   * remains governed by RELATIONSHIP_INTENT rather than these participant rows. */
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
      const [thread] = await tx
        .insert(messageThread)
        .values({ type: MessageThreadType.P2P, updatedAt: new Date() })
        .returning({ id: messageThread.id });
      threadId = thread.id;
      await tx
        .update(relationshipPair)
        .set({ threadId, updatedAt: new Date() })
        .where(eq(relationshipPair.id, pair.id));
    }
    const members = await tx
      .insert(threadMember)
      .values(
        [userAId, userBId].map((userId) => ({
          userId,
          threadId,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [threadMember.threadId, threadMember.userId],
        set: {
          left: false,
          updatedAt: new Date(),
        },
      })
      .returning({ id: threadMember.id, userId: threadMember.userId });
    const localAccounts = await tx
      .select({ id: accountTable.id })
      .from(accountTable)
      .where(inArray(accountTable.id, [userAId, userBId]));
    const localIds = new Set(localAccounts.map((row) => row.id));
    const participantRows = members
      .filter((member) => localIds.has(member.userId))
      .map((member) => ({ accountId: member.userId, threadId }));
    if (participantRows.length > 0)
      await tx
        .insert(threadParticipant)
        .values(
          participantRows as [
            typeof threadParticipant.$inferInsert,
            ...(typeof threadParticipant.$inferInsert)[],
          ],
        )
        .onConflictDoUpdate({
          target: [threadParticipant.accountId, threadParticipant.threadId],
          set: {
            messageVisibleBeforeSeq: null,
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

  /** Re-open the retained relationship. History stays on the same thread; only messages committed
   * after this transition enter the peer feed. */
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

  private async loadP2PIntentPartiesInTx(tx: DatabaseTransaction, id: bigint) {
    const [row] = await tx
      .select({ intent: relationshipIntent, pair: relationshipPair })
      .from(relationshipIntent)
      .innerJoin(
        relationshipPair,
        eq(relationshipPair.id, relationshipIntent.pairId),
      )
      .where(
        and(eq(relationshipIntent.id, id), eq(relationshipPair.kind, 'P2P')),
      )
      .limit(1);
    if (!row) return null;
    const identities = await tx
      .select({
        id: user.id,
        account: user.account,
        domain: user.domain,
      })
      .from(user)
      .where(
        and(
          eq(user.sourceDomain, user.domain),
          or(
            and(
              eq(user.account, row.pair.endpointAAccount),
              eq(user.domain, row.pair.endpointADomain),
            ),
            and(
              eq(user.account, row.pair.endpointBAccount),
              eq(user.domain, row.pair.endpointBDomain),
            ),
          ),
        ),
      );
    const endpointA = identities.find(
      (identity) =>
        identity.account === row.pair.endpointAAccount &&
        identity.domain === row.pair.endpointADomain,
    );
    const endpointB = identities.find(
      (identity) =>
        identity.account === row.pair.endpointBAccount &&
        identity.domain === row.pair.endpointBDomain,
    );
    if (!endpointA || !endpointB)
      throw new Error('relationship endpoint profile missing');
    return {
      intent: row.intent,
      pair: row.pair,
      authorUserId: row.intent.authorSide === 'A' ? endpointA.id : endpointB.id,
      subjectUserId:
        row.intent.authorSide === 'A' ? endpointB.id : endpointA.id,
    };
  }

  private parseInviteId(s: string): bigint {
    try {
      const n = BigInt(s);
      if (n <= 0n) throw new Error('non-positive');
      return n;
    } catch {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        `invalid inviteId [${s}]`,
      );
    }
  }

  /** Find the caller's group membership invitation by the group's stable `!account`. */
  private async findInviteIdByGroup(
    groupAccount: string,
    callerId: number,
    pendingOnly: boolean,
  ): Promise<bigint | null> {
    const [row] = await this.database.db
      .select({ id: relationshipIntent.id })
      .from(relationshipIntent)
      .innerJoin(
        relationshipPair,
        eq(relationshipPair.id, relationshipIntent.pairId),
      )
      .innerJoin(
        group,
        and(
          eq(group.account, relationshipPair.endpointAAccount),
          eq(group.domain, relationshipPair.endpointADomain),
        ),
      )
      .innerJoin(user, eq(user.id, callerId))
      .where(
        and(
          eq(relationshipPair.kind, 'GROUP_MEMBER'),
          eq(relationshipIntent.authorSide, 'A'),
          eq(relationshipPair.endpointBAccount, user.account),
          eq(relationshipPair.endpointBDomain, user.domain),
          pendingOnly ? eq(relationshipIntent.status, 'REQUESTED') : undefined,
          eq(group.account, normalizeAccount(groupAccount)),
        ),
      )
      .orderBy(desc(relationshipIntent.requestedAt))
      .limit(1);
    return row?.id ?? null;
  }

  /** Resolve the concrete invite id from a card identity: a group `!account` (lookup) or a BigInt id. */
  private async resolveInviteId(
    groupAccountOrId: string,
    callerId: number,
    pendingOnly: boolean,
  ): Promise<bigint> {
    if (groupAccountOrId.startsWith('!')) {
      const id = await this.findInviteIdByGroup(
        groupAccountOrId,
        callerId,
        pendingOnly,
      );
      if (id === null) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'invite not found',
        );
      }
      return id;
    }
    return this.parseInviteId(groupAccountOrId);
  }
}
