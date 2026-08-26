import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, desc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  group,
  relationshipPair,
  federatedFriendRequest,
  relationshipIntent,
  groupAuditLog,
  messageThread,
  threadAudience,
  threadParticipant,
  user,
} from '../database/schema.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
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
import { mutuallyAuthorizedSql } from './relationship-authorization.js';

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
    @Optional() private readonly messages?: MessageService,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<MessageFanoutService, 'dispatch'>,
    @Optional()
    private readonly relationshipIntents?: RelationshipIntentService,
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
        JOIN "User" low_user ON low_user.id = pair."userLowId"
        JOIN "User" high_user ON high_user.id = pair."userHighId"
        WHERE pair.active = false
          AND pair."threadId" IS NOT NULL
          AND thread.type = 'P2P'
          AND NOT EXISTS (
            SELECT 1 FROM "Message" message
            WHERE message."threadId" = pair."threadId"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "RelationshipIntent" request
            WHERE ((request."authorUserId" = pair."userLowId" AND request."subjectUserId" = pair."userHighId")
                OR (request."authorUserId" = pair."userHighId" AND request."subjectUserId" = pair."userLowId"))
              AND (request.status = 'ACCEPTED'
                OR (request.status = 'REQUESTED' AND request."expiresAt" > CURRENT_TIMESTAMP))
          )
          AND NOT EXISTS (
            SELECT 1 FROM "FederatedFriendRequest" request
            WHERE request.status IN ('REQUESTED', 'ACCEPTED')
              AND (request.status = 'ACCEPTED' OR request."expiresAt" > CURRENT_TIMESTAMP)
              AND (
                (request."localUserId" = pair."userLowId"
                  AND request."remoteAccount" = high_user.account
                  AND request."remoteDomain" = high_user.domain)
                OR
                (request."localUserId" = pair."userHighId"
                  AND request."remoteAccount" = low_user.account
                  AND request."remoteDomain" = low_user.domain)
              )
          )
        FOR UPDATE OF pair, thread SKIP LOCKED
      `);
      const groupCandidates = await tx.execute<{ threadId: number }>(sql`
        SELECT thread.id AS "threadId"
        FROM "MessageThread" thread
        JOIN "User" group_user ON group_user.id = thread."groupUserId"
        WHERE thread.type = 'GROUP'
          AND group_user.domain <> 'local'
          AND NOT EXISTS (
            SELECT 1 FROM "Message" message WHERE message."threadId" = thread.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM "RelationshipIntent" request
            WHERE (request."authorUserId" = thread."groupUserId"
                OR request."subjectUserId" = thread."groupUserId")
              AND (request.status = 'ACCEPTED'
                OR (request.status = 'REQUESTED' AND request."expiresAt" > CURRENT_TIMESTAMP))
          )
        FOR UPDATE OF thread SKIP LOCKED
      `);
      const ids = [
        ...candidates.rows.map((row) => row.threadId),
        ...groupCandidates.rows.map((row) => row.threadId),
      ];
      if (ids.length > 0) {
        await tx
          .delete(threadParticipant)
          .where(inArray(threadParticipant.threadId, ids));
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
        groupUserId: messageThread.groupUserId,
        account: user.account,
        domain: user.domain,
        name: user.name,
        avatar: user.avatar,
        description: user.bio,
        profileRev: user.profileRev,
      })
      .from(messageThread)
      .innerJoin(user, eq(user.id, messageThread.groupUserId))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!state?.groupUserId || state.domain !== 'local') return;
    const [request, member] = await Promise.all([
      tx.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorUserId, state.groupUserId),
          eq(relationshipIntent.subjectUserId, memberUserId),
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
    await this.lockFriendPairInTx(tx, actorUserId, peerUserId);
    if (wantsFriend)
      await this.ensureP2PThreadShellInTx(tx, actorUserId, peerUserId);
    const [opposite, peer] = await Promise.all([
      tx.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorUserId, peerUserId),
          eq(relationshipIntent.subjectUserId, actorUserId),
        ),
        columns: { status: true, expiresAt: true },
      }),
      tx.query.user.findFirst({
        where: eq(user.id, peerUserId),
        columns: { domain: true },
      }),
    ]);
    // A federated pair is always locally total: the direction authored here is the requested grant,
    // while an as-yet-unseen peer-authored direction is represented as REVOKED. This cached reverse
    // fact is never published to the peer because this server is not its author; a later peer state
    // item replaces it through the normal inbound merge path.
    if (wantsFriend && peer?.domain !== 'local' && !opposite) {
      await tx
        .insert(relationshipIntent)
        .values({
          authorUserId: peerUserId,
          subjectUserId: actorUserId,
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
        })
        .onConflictDoNothing();
    }
    const oppositeEffective =
      opposite?.status === 'ACCEPTED' ||
      (opposite?.status === 'REQUESTED' &&
        opposite.expiresAt !== null &&
        opposite.expiresAt > new Date());
    const desired = wantsFriend
      ? oppositeEffective
        ? 'ACCEPTED'
        : 'REQUESTED'
      : 'REVOKED';
    const requestedAt = wantsFriend ? new Date() : null;
    const expiresAt =
      desired === 'REQUESTED' && requestedAt
        ? new Date(requestedAt.getTime() + INVITE_TTL_MS)
        : null;
    await tx.execute(sql`
      INSERT INTO "RelationshipIntent" (
        "authorUserId", "subjectUserId", status, note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${actorUserId}, ${peerUserId}, ${desired}::"RelationshipIntentStatus",
        ${note.slice(0, 255)},
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("authorUserId", "subjectUserId") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        "requestedAt" = CASE WHEN EXCLUDED.status IN ('REQUESTED', 'ACCEPTED') THEN EXCLUDED."requestedAt"
                             ELSE "RelationshipIntent"."requestedAt" END,
        "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
         OR (EXCLUDED.status = 'REQUESTED'
             AND "RelationshipIntent"."expiresAt" <= CURRENT_TIMESTAMP)
    `);
    // A purely local mutual request has no wire acknowledgement to wait for;
    // confirm the opposite direction inside this same transaction. Federated
    // pairs must receive the peer's explicit FRIEND state before activation.
    if (desired === 'ACCEPTED' && peer?.domain === 'local') {
      await tx.execute(sql`
        UPDATE "RelationshipIntent" SET status = 'ACCEPTED', "expiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "authorUserId" = ${peerUserId}
          AND "subjectUserId" = ${actorUserId}
          AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
      `);
    }
    const pairEffect = await this.reconcileFriendPairInTx(
      tx,
      actorUserId,
      peerUserId,
    );
    if (peer && peer.domain !== 'local' && pairEffect.threadId !== undefined) {
      if (desired === 'REQUESTED' || desired === 'ACCEPTED')
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
    const [first, second, directions, pair] = await Promise.all([
      tx.query.user.findFirst({ where: eq(user.id, firstUserId) }),
      tx.query.user.findFirst({ where: eq(user.id, secondUserId) }),
      tx.query.relationshipIntent.findMany({
        where: or(
          and(
            eq(relationshipIntent.authorUserId, firstUserId),
            eq(relationshipIntent.subjectUserId, secondUserId),
          ),
          and(
            eq(relationshipIntent.authorUserId, secondUserId),
            eq(relationshipIntent.subjectUserId, firstUserId),
          ),
        ),
      }),
      tx.query.relationshipPair.findFirst({
        where: and(
          eq(relationshipPair.userLowId, Math.min(firstUserId, secondUserId)),
          eq(relationshipPair.userHighId, Math.max(firstUserId, secondUserId)),
        ),
        columns: { threadId: true },
      }),
    ]);
    if (!first || !second) throw new Error('client friend intent user missing');
    const users = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    const pending: Array<{ userId: number; feedId: number }> = [];
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
        requestedAt: direction.requestedAt?.getTime() ?? null,
        expiresAt: direction.expiresAt?.getTime() ?? null,
      };
      for (const owner of [actor, subject]) {
        if (owner.domain !== 'local' || owner.isDeleted) continue;
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
          localThreadId: pair?.threadId ?? null,
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

    const [friendIds, requests] = await Promise.all([
      this.participantService.getActiveP2PPeerUserIds(me),
      this.database.db
        .select({
          id: relationshipIntent.id,
          fromUserId: relationshipIntent.authorUserId,
          toUserId: relationshipIntent.subjectUserId,
        })
        .from(relationshipIntent)
        .where(
          and(
            eq(relationshipIntent.status, 'REQUESTED'),
            gt(relationshipIntent.expiresAt, new Date()),
            or(
              and(
                eq(relationshipIntent.authorUserId, me),
                inArray(relationshipIntent.subjectUserId, userIds),
              ),
              and(
                eq(relationshipIntent.subjectUserId, me),
                inArray(relationshipIntent.authorUserId, userIds),
              ),
            ),
          ),
        ),
    ]);
    const friends = new Set(friendIds);
    const outgoing = new Map(
      requests
        .filter((request) => request.fromUserId === me)
        .map((request) => [request.toUserId, request.id.toString()]),
    );
    const incoming = new Map(
      requests
        .filter((request) => request.toUserId === me)
        .map((request) => [request.fromUserId, request.id.toString()]),
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
        const before = await tx.query.relationshipIntent.findFirst({
          where: and(
            eq(relationshipIntent.authorUserId, fromUserId),
            eq(relationshipIntent.subjectUserId, toUserId),
          ),
          columns: { status: true, note: true, expiresAt: true },
        });
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
        const request = await tx.query.relationshipIntent.findFirst({
          where: and(
            eq(relationshipIntent.authorUserId, fromUserId),
            eq(relationshipIntent.subjectUserId, toUserId),
          ),
          columns: { id: true, status: true },
        });
        if (!request) throw new Error('friend request write disappeared');
        const low = Math.min(fromUserId, toUserId);
        const high = Math.max(fromUserId, toUserId);
        const pair = await tx.query.relationshipPair.findFirst({
          where: and(
            eq(relationshipPair.userLowId, low),
            eq(relationshipPair.userHighId, high),
          ),
          columns: { active: true, threadId: true },
        });
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
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    void originOverride;
    return this.database.db.transaction(async (tx) => {
      const target = await tx.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { groupUserId: true },
      });
      if (!target?.groupUserId)
        throw new Error('group invite target is invalid');
      if (afterWrite) await afterWrite(tx);
      else {
        await tx.execute(sql`
          INSERT INTO "RelationshipIntent" (
            "authorUserId", "subjectUserId", status, note,
            "requestedAt", "expiresAt", "updatedAt"
          ) VALUES (${target.groupUserId}, ${toUserId}, 'REQUESTED',
            ${trimmed}, CURRENT_TIMESTAMP, ${expiresAt}, CURRENT_TIMESTAMP)
          ON CONFLICT ("authorUserId", "subjectUserId") DO UPDATE SET
            status = 'REQUESTED', note = EXCLUDED.note,
            "requestedAt" = CURRENT_TIMESTAMP, "expiresAt" = EXCLUDED."expiresAt",
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "RelationshipIntent".status IS DISTINCT FROM 'REQUESTED'
             OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
             OR "RelationshipIntent"."expiresAt" <= CURRENT_TIMESTAMP
        `);
      }
      const request = await tx.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorUserId, target.groupUserId),
          eq(relationshipIntent.subjectUserId, toUserId),
        ),
        columns: {
          id: true,
          requestedAt: true,
          expiresAt: true,
        },
      });
      if (!request) throw new Error('group request write disappeared');
      const [groupIdentity, memberIdentity, actorIdentity] = await Promise.all([
        tx.query.user.findFirst({
          where: eq(user.id, target.groupUserId),
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
          groupUserId: target.groupUserId,
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
        const friend = await tx.query.relationshipIntent.findFirst({
          where: eq(relationshipIntent.id, id),
        });
        if (friend) {
          if (friend.status !== 'REQUESTED')
            throw new BusinessException(
              BusinessCode.INVITE_ALREADY_HANDLED,
              'friend request already handled',
            );
          if (friend.subjectUserId !== byUserId)
            throw new BusinessException(
              BusinessCode.INVITE_NOT_YOURS,
              'this request is not yours to accept',
            );
          if (friend.expiresAt && friend.expiresAt.getTime() <= Date.now())
            throw new BusinessException(
              BusinessCode.INVITE_EXPIRED,
              'request expired',
            );
          const low = Math.min(friend.authorUserId, byUserId);
          const high = Math.max(friend.authorUserId, byUserId);
          if (afterFriendAccept)
            await afterFriendAccept(tx, friend.authorUserId);
          else
            pendingFeedUpdates.push(
              ...(await this.writeLocalFriendIntentInTx(
                tx,
                byUserId,
                friend.authorUserId,
                true,
              )),
            );
          const pair = await tx.query.relationshipPair.findFirst({
            where: and(
              eq(relationshipPair.userLowId, low),
              eq(relationshipPair.userHighId, high),
            ),
            columns: { active: true, threadId: true },
          });
          const requester = await tx.query.user.findFirst({
            where: eq(user.id, friend.authorUserId),
            columns: { domain: true },
          });
          if (!pair?.active || pair.threadId === null) {
            if (requester?.domain === 'local')
              throw new Error(
                'local mutual friend requests did not activate the pair',
              );
            // Federation is a two-phase acknowledgement. Accepting writes our
            // FRIEND direction, while thread creation waits for the peer's
            // subsequent FRIEND state to return through its state feed.
            return {
              kind: 'FRIEND',
              fromUserId: friend.authorUserId,
            };
          }
          return {
            kind: 'FRIEND',
            threadId: pair.threadId,
            fromUserId: friend.authorUserId,
          };
        }

        const membership = await tx.query.relationshipIntent.findFirst({
          where: eq(relationshipIntent.id, id),
        });
        if (!membership)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_FOUND,
            'request not found',
          );
        if (
          membership.authorUserId === byUserId ||
          membership.status !== 'REQUESTED'
        )
          throw new BusinessException(
            BusinessCode.INVITE_ALREADY_HANDLED,
            'group request already handled',
          );
        if (membership.subjectUserId !== byUserId)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_YOURS,
            'this request is not yours to accept',
          );
        if (
          membership.expiresAt &&
          membership.expiresAt.getTime() <= Date.now()
        )
          throw new BusinessException(
            BusinessCode.INVITE_EXPIRED,
            'request expired',
          );
        const threadRow = await tx.query.messageThread.findFirst({
          where: eq(messageThread.groupUserId, membership.authorUserId),
          columns: { id: true },
        });
        if (!threadRow)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_FOUND,
            'group mirror missing',
          );
        const [groupState] = await tx
          .select({
            dissolvedAt: group.dissolvedAt,
            account: user.account,
            domain: user.domain,
          })
          .from(messageThread)
          .leftJoin(group, eq(group.groupUserId, messageThread.groupUserId))
          .leftJoin(user, eq(user.id, messageThread.groupUserId))
          .where(eq(messageThread.id, threadRow.id))
          .limit(1);
        if (groupState?.dissolvedAt != null)
          throw new BusinessException(
            BusinessCode.GROUP_DISSOLVED,
            'group dissolved',
          );
        const isMirror = !!groupState?.domain && groupState.domain !== 'local';
        if (!isMirror) {
          await assertServerGroupCapacityInTx(tx, threadRow.id, byUserId);
          await this.participantService.upsertMemberInTx(
            tx,
            threadRow.id,
            byUserId,
            GroupRole.MEMBER,
          );
          await tx
            .insert(threadAudience)
            .values({
              targetDomain: 'local',
              localUserId: byUserId,
              threadId: threadRow.id,
            })
            .onConflictDoNothing();
        }
        if (afterGroupJoin) await afterGroupJoin(tx, threadRow.id);
        const groupAccount = groupState?.account ?? null;
        const groupDomain = groupState?.domain ?? null;
        if (groupDomain && groupDomain !== 'local') {
          await openFederatedAudienceInTx(tx, groupDomain, threadRow.id);
        }
        return {
          kind: 'GROUP',
          threadId: threadRow.id,
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
        // Explicit acceptance establishes the local participant immediately. System messages are
        // server-local timeline decorations, so every accepting server records its own notice; a
        // later GROUP_META snapshot must not be required to recreate the acceptance event.
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
      const request = await tx.query.relationshipIntent.findFirst({
        where: eq(relationshipIntent.id, id),
      });
      if (!request || request.status !== 'REQUESTED') {
        throw new BusinessException(
          !request
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          !request ? 'request not found' : 'request already handled',
        );
      }
      if (request.authorUserId !== byUserId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this request is not yours to revoke',
        );
      }
      if (afterRevoke) await afterRevoke(tx, request.subjectUserId);
      else
        pendingFeedUpdates.push(
          ...(await this.writeLocalFriendIntentInTx(
            tx,
            byUserId,
            request.subjectUserId,
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
      const request = await tx.query.relationshipIntent.findFirst({
        where: eq(relationshipIntent.id, id),
      });
      if (!request || request.status !== 'REQUESTED')
        throw new BusinessException(
          !request
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          !request ? 'request not found' : 'request already handled',
        );
      if (request.subjectUserId !== byUserId)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this request is not yours to reject',
        );
      await afterReject(tx, request.authorUserId);
    });
  }

  /**
   * Incoming PENDING friend invites for `userId`, newest first, last-7-days, ≤200. No client params.
   * The caller (controller) filters out any whose inviter is already a friend.
   */
  async listIncoming(userId: number) {
    const since = new Date(Date.now() - INVITE_TTL_MS);
    const [local, federated] = await Promise.all([
      this.listFriendInvites(
        and(
          eq(relationshipIntent.subjectUserId, userId),
          gt(relationshipIntent.requestedAt, since),
        ),
      ),
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
      this.listFriendInvites(
        and(
          eq(relationshipIntent.authorUserId, userId),
          gt(relationshipIntent.requestedAt, since),
        ),
      ),
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

  private async listFriendInvites(extra: SQL | undefined) {
    const rows = await this.database.db.query.relationshipIntent.findMany({
      where: and(
        eq(relationshipIntent.status, 'REQUESTED'),
        gt(relationshipIntent.expiresAt, new Date()),
        extra,
      ),
      orderBy: desc(relationshipIntent.requestedAt),
      limit: LIST_LIMIT,
      with: {
        author: { columns: USER_SELECT },
        subject: { columns: USER_SELECT },
      },
    });
    return rows.map(({ author, subject, ...row }) => ({
      id: row.id,
      kind: 'FRIEND' as const,
      fromUserId: row.authorUserId,
      toUserId: row.subjectUserId,
      threadId: null,
      note: row.note,
      status: 'PENDING' as const,
      expiresAt: row.expiresAt ?? new Date(0),
      createdAt: row.requestedAt ?? row.updatedAt,
      updatedAt: row.updatedAt,
      fromUser: author,
      toUser: subject,
    }));
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
    await this.lockFriendPairInTx(tx, params.localUserId, params.peerUserId);
    const desired = params.status;
    if (desired === 'ACCEPTED') {
      const [localDirection, peerDirection] = await Promise.all([
        tx.query.relationshipIntent.findFirst({
          where: and(
            eq(relationshipIntent.authorUserId, params.localUserId),
            eq(relationshipIntent.subjectUserId, params.peerUserId),
          ),
          columns: { status: true, expiresAt: true },
        }),
        tx.query.relationshipIntent.findFirst({
          where: and(
            eq(relationshipIntent.authorUserId, params.peerUserId),
            eq(relationshipIntent.subjectUserId, params.localUserId),
          ),
          columns: { status: true, expiresAt: true },
        }),
      ]);
      const now = new Date();
      const confirmsLocalRequest =
        localDirection?.status === 'REQUESTED' &&
        localDirection.expiresAt !== null &&
        localDirection.expiresAt > now;
      const completesAcceptedPeerRequest =
        localDirection?.status === 'ACCEPTED' &&
        peerDirection?.status === 'REQUESTED' &&
        peerDirection.expiresAt !== null &&
        peerDirection.expiresAt > now;
      if (!confirmsLocalRequest && !completesAcceptedPeerRequest) {
        return { changed: false, requestCreated: false, clientFeedUpdates: [] };
      }
    }
    const previous = await tx.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorUserId, params.peerUserId),
        eq(relationshipIntent.subjectUserId, params.localUserId),
      ),
      columns: { status: true, expiresAt: true },
    });
    const applied = await tx.execute(sql`
      INSERT INTO "RelationshipIntent" (
        "authorUserId", "subjectUserId", status, note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.peerUserId}, ${params.localUserId},
        ${desired}::"RelationshipIntentStatus", ${params.note.slice(0, 255)},
        ${desired === 'REVOKED' ? null : params.requestedAt},
        ${desired === 'REQUESTED' ? params.expiresAt : null}, CURRENT_TIMESTAMP)
      ON CONFLICT ("authorUserId", "subjectUserId") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        "requestedAt" = EXCLUDED."requestedAt", "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
         OR "RelationshipIntent"."requestedAt" IS DISTINCT FROM EXCLUDED."requestedAt"
         OR "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING 1
    `);
    if (!applied.rows[0])
      return { changed: false, requestCreated: false, clientFeedUpdates: [] };
    let localStateRevision: number | undefined;
    if (desired === 'REVOKED') {
      const closed = await tx.execute(sql`
        UPDATE "RelationshipIntent" SET status = 'REVOKED', note = '',
          "expiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "authorUserId" = ${params.localUserId}
          AND "subjectUserId" = ${params.peerUserId}
          AND status <> 'REVOKED'
        RETURNING 1
      `);
      localStateRevision = closed.rows[0] ? 1 : undefined;
    } else {
      const confirmed = await tx.execute(sql`
        UPDATE "RelationshipIntent" SET status = 'ACCEPTED', "expiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "authorUserId" = ${params.localUserId}
          AND "subjectUserId" = ${params.peerUserId}
          AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING 1
      `);
      localStateRevision = confirmed.rows[0] ? 1 : undefined;
      if (desired === 'REQUESTED' && localStateRevision === undefined) {
        const accepted = await tx.query.relationshipIntent.findFirst({
          where: and(
            eq(relationshipIntent.authorUserId, params.localUserId),
            eq(relationshipIntent.subjectUserId, params.peerUserId),
            eq(relationshipIntent.status, 'ACCEPTED'),
          ),
          columns: { authorUserId: true },
        });
        if (accepted) localStateRevision = 1;
      }
    }
    const pairEffect = await this.reconcileFriendPairInTx(
      tx,
      params.localUserId,
      params.peerUserId,
    );
    const localDirection = await tx.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorUserId, params.localUserId),
        eq(relationshipIntent.subjectUserId, params.peerUserId),
      ),
      columns: { status: true, expiresAt: true },
    });
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
    if (desired === 'REQUESTED') {
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

  private async lockFriendPairInTx(
    tx: DatabaseTransaction,
    userAId: number,
    userBId: number,
  ): Promise<void> {
    if (this.relationshipIntents) {
      await this.relationshipIntents.lockPairInTx(tx, userAId, userBId);
      return;
    }
    const low = Math.min(userAId, userBId);
    const high = Math.max(userAId, userBId);
    if (low === high) throw new Error('friend pair requires two users');
    await tx.execute(sql`
      INSERT INTO "RelationshipPair" ("userLowId", "userHighId")
      VALUES (${low}, ${high}) ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      SELECT 1 FROM "RelationshipPair"
      WHERE "userLowId" = ${low} AND "userHighId" = ${high}
      FOR UPDATE
    `);
  }

  private async reconcileFriendPairInTx(
    tx: DatabaseTransaction,
    userAId: number,
    userBId: number,
  ): Promise<{ active: boolean; transitioned: boolean; threadId?: number }> {
    const low = Math.min(userAId, userBId);
    const high = Math.max(userAId, userBId);
    const derived = await tx.execute<{ active: boolean }>(sql`
      SELECT ${mutuallyAuthorizedSql(userAId, userBId)} AS active
    `);
    const desiredActive = derived.rows[0]?.active ?? false;
    const pair = await tx.execute<{
      active: boolean;
      threadId: number | null;
    }>(sql`
      SELECT active, "threadId" FROM "RelationshipPair"
      WHERE "userLowId" = ${low} AND "userHighId" = ${high}
    `);
    const current = pair.rows[0];
    if (!current) throw new Error('friend pair lock disappeared');
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
      await tx.execute(sql`
        UPDATE "RelationshipPair" SET active = true, "threadId" = ${threadId},
          revision = revision + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "userLowId" = ${low} AND "userHighId" = ${high}
      `);
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
      await tx.execute(sql`
        UPDATE "RelationshipPair" SET active = false, revision = revision + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "userLowId" = ${low} AND "userHighId" = ${high}
      `);
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
    const low = Math.min(userAId, userBId);
    const high = Math.max(userAId, userBId);
    const [pair] = await tx
      .select({ threadId: relationshipPair.threadId })
      .from(relationshipPair)
      .where(
        and(
          eq(relationshipPair.userLowId, low),
          eq(relationshipPair.userHighId, high),
        ),
      )
      .limit(1);
    if (!pair) throw new Error('friend pair shell lock missing');
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
        .where(
          and(
            eq(relationshipPair.userLowId, low),
            eq(relationshipPair.userHighId, high),
          ),
        );
    }
    const shellParticipants: Array<typeof threadParticipant.$inferInsert> = [
      userAId,
      userBId,
    ].map((userId) => ({
      userId,
      threadId,
      relationshipRev: 1,
      updatedAt: new Date(),
    }));
    await tx
      .insert(threadParticipant)
      .values(shellParticipants)
      .onConflictDoNothing();
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
    const restored = await tx
      .update(threadParticipant)
      .set({
        relationshipRev: sql`${threadParticipant.relationshipRev} + 1`,
        messageVisibleBeforeSeq: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          inArray(threadParticipant.userId, [userAId, userBId]),
        ),
      )
      .returning({ id: threadParticipant.id });
    if (restored.length < 2) {
      const existing = await tx
        .select({ userId: threadParticipant.userId })
        .from(threadParticipant)
        .where(eq(threadParticipant.threadId, threadId));
      const existingIds = new Set(existing.map((row) => row.userId));
      const missing: Array<typeof threadParticipant.$inferInsert> = [
        userAId,
        userBId,
      ]
        .filter((userId) => !existingIds.has(userId))
        .map((userId) => ({
          userId,
          threadId,
          relationshipRev: 1,
          updatedAt: new Date(),
        }));
      if (missing.length > 0)
        await tx.insert(threadParticipant).values(missing);
    }
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

  /** Create the P2P MessageThread + both active participants and durable discovery audiences. A fresh threadId means brand-new
   *  participant rows even when re-friending (the old soft-left thread stays, filtered out by
   *  findP2PThreadBetween's active-participant check). Since the thread is empty and cannot contain an old
   *  relationship's history, so each remote scan starts at the empty thread's current seq. */
  private async createP2PFriendshipInTx(
    tx: DatabaseTransaction,
    userAId: number,
    userBId: number,
  ): Promise<number> {
    const previous = await tx.execute<{ userId: number; revision: number }>(sql`
      SELECT p."userId", COALESCE(MAX(p."relationshipRev"), 0)::integer AS revision
      FROM "ThreadParticipant" p
      JOIN "MessageThread" t ON t.id = p."threadId" AND t.type = 'P2P'
      WHERE p."userId" IN (${userAId}, ${userBId})
      GROUP BY p."userId"
    `);
    const previousByUser = new Map(
      previous.rows.map((row) => [row.userId, row.revision]),
    );
    const [thread] = await tx
      .insert(messageThread)
      .values({ type: MessageThreadType.P2P, updatedAt: new Date() })
      .returning({ id: messageThread.id });
    await tx.insert(threadParticipant).values([
      {
        userId: userAId,
        threadId: thread.id,
        relationshipRev: (previousByUser.get(userAId) ?? 0) + 1,
        updatedAt: new Date(),
      },
      {
        userId: userBId,
        threadId: thread.id,
        relationshipRev: (previousByUser.get(userBId) ?? 0) + 1,
        updatedAt: new Date(),
      },
    ]);
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
        threadId: thread.id,
      }));
    const peerDomains = [
      ...new Set(
        participants
          .map((participant) => participant.domain)
          .filter((domain) => domain !== 'local'),
      ),
    ];
    if (localAudience.length > 0)
      await tx.insert(threadAudience).values(localAudience);
    for (const peerDomain of peerDomains)
      await openFederatedAudienceInTx(tx, peerDomain, thread.id);
    return thread.id;
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
      .innerJoin(user, eq(user.id, relationshipIntent.authorUserId))
      .where(
        and(
          eq(relationshipIntent.subjectUserId, callerId),
          eq(relationshipIntent.authorUserId, relationshipIntent.authorUserId),
          pendingOnly ? eq(relationshipIntent.status, 'REQUESTED') : undefined,
          eq(user.account, normalizeAccount(groupAccount)),
          eq(user.isGroup, true),
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
