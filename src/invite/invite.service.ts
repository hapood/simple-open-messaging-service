import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { and, desc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  group,
  friendPair,
  friendRequest,
  federatedFriendRequest,
  groupMembershipRequest,
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
import { ThreadRevisionService } from '../thread-revision/thread-revision.service.js';
import { ClientStateFeedService } from '../thread-revision/client-state-feed.service.js';
import { MessageService } from '../message/message.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { assertServerGroupCapacityInTx } from '../group/group-capacity.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from '../federation/federation-audience.js';

/** Friend + group invite TTL: 7 days. Validated at accept time; the background sweep/GC is deferred
 *  (a row stays PENDING past expiry until then — the client renders an "expired" prompt from
 *  `expiresAt`, and accept rejects an expired row with INVITE_EXPIRED as defense-in-depth). */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** One-shot cap for the parameterless incoming/outgoing endpoints. */
const LIST_LIMIT = 200;

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
  displayName?: string;
  avatar?: string;
}

/** Fields selected for the embedded inviter/recipient profile on list queries (never hashPwd — it is
 *  sensitive). */
const USER_SELECT = {
  id: true,
  account: true,
  name: true,
  avatar: true,
  domain: true,
  isForeigner: true,
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
    private readonly threadRevisionService: ThreadRevisionService,
    private readonly clientStateFeed: ClientStateFeedService,
    @Optional() private readonly messages?: MessageService,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<MessageFanoutService, 'dispatch'>,
  ) {}

  async writeGroupInviteClientStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    pendingRevisions: Array<{ userId: number; revision: number }>,
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
      tx.query.groupMembershipRequest.findFirst({
        where: and(
          eq(groupMembershipRequest.groupUserId, state.groupUserId),
          eq(groupMembershipRequest.memberUserId, memberUserId),
          eq(groupMembershipRequest.direction, 'INVITE'),
        ),
      }),
      tx.query.user.findFirst({
        where: eq(user.id, memberUserId),
        columns: { account: true },
      }),
    ]);
    if (!request || !member) return;
    const revision = await this.clientStateFeed.writeInTx(tx, {
      userId: memberUserId,
      account: state.account,
      domain: this.config.domain,
      eventType: 'GROUP_INVITE_INTENT',
      subjectAccount: member.account,
      subjectDomain: this.config.domain,
      body: {
        status:
          request.status === 'MEMBER'
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
    if (revision !== null)
      pendingRevisions.push({ userId: memberUserId, revision });
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
      },
    ) => Promise<void>,
  ): Promise<{ created: boolean }> {
    const account = normalizeAccount(remoteAccount);
    const trimmed = note.slice(0, 255);
    const now = new Date();
    let clientRevision: number | null = null;
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
      await afterWrite(tx, { requestedAt, expiresAt, note: trimmed });
      const local = await tx.query.user.findFirst({
        where: eq(user.id, localUserId),
      });
      if (!local) throw new Error('federated friend request owner missing');
      clientRevision = await this.clientStateFeed.writeInTx(tx, {
        userId: localUserId,
        account: local.account,
        domain: local.domain,
        eventType: 'P2P_INTENT',
        subjectAccount: account,
        subjectDomain: remoteDomain,
        body: {
          status: 'REQUESTED',
          note: trimmed,
          requestedAt: requestedAt.getTime(),
          expiresAt: expiresAt.getTime(),
          direction: 'OUTGOING',
          peer: {
            id: 0,
            account,
            name: snapshot.displayName?.slice(0, 30) || account,
            avatar: snapshot.avatar || '',
            domain: remoteDomain,
            isForeigner: true,
          },
        },
      });
      return { created: true };
    });
    if (clientRevision !== null)
      this.threadRevisionService.notifyThreadRevision({
        userId: localUserId,
        revision: clientRevision,
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
  ): Promise<Array<{ userId: number; revision: number }>> {
    await this.lockFriendPairInTx(tx, actorUserId, peerUserId);
    const [opposite, peer] = await Promise.all([
      tx.query.friendRequest.findFirst({
        where: and(
          eq(friendRequest.requesterUserId, peerUserId),
          eq(friendRequest.targetUserId, actorUserId),
        ),
        columns: { status: true, expiresAt: true },
      }),
      tx.query.user.findFirst({
        where: eq(user.id, peerUserId),
        columns: { isForeigner: true },
      }),
    ]);
    const oppositeEffective =
      opposite?.status === 'FRIEND' ||
      (opposite?.status === 'REQUESTED' &&
        opposite.expiresAt !== null &&
        opposite.expiresAt > new Date());
    const desired = wantsFriend
      ? oppositeEffective
        ? 'FRIEND'
        : 'REQUESTED'
      : 'NOT_FRIEND';
    const requestedAt = wantsFriend ? new Date() : null;
    const expiresAt =
      desired === 'REQUESTED' && requestedAt
        ? new Date(requestedAt.getTime() + INVITE_TTL_MS)
        : null;
    await tx.execute(sql`
      INSERT INTO "FriendRequest" (
        "requesterUserId", "targetUserId", status, note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${actorUserId}, ${peerUserId}, ${desired}::"FriendRequestStatus",
        ${note.slice(0, 255)},
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("requesterUserId", "targetUserId") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        "requestedAt" = CASE WHEN EXCLUDED.status IN ('REQUESTED', 'FRIEND') THEN EXCLUDED."requestedAt"
                             ELSE "FriendRequest"."requestedAt" END,
        "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "FriendRequest".status IS DISTINCT FROM EXCLUDED.status
         OR "FriendRequest".note IS DISTINCT FROM EXCLUDED.note
         OR (EXCLUDED.status = 'REQUESTED'
             AND "FriendRequest"."expiresAt" <= CURRENT_TIMESTAMP)
    `);
    // A purely local mutual request has no wire acknowledgement to wait for;
    // confirm the opposite direction inside this same transaction. Federated
    // pairs must receive the peer's explicit FRIEND state before activation.
    if (desired === 'FRIEND' && peer && !peer.isForeigner) {
      await tx.execute(sql`
        UPDATE "FriendRequest" SET status = 'FRIEND', "expiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "requesterUserId" = ${peerUserId}
          AND "targetUserId" = ${actorUserId}
          AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
      `);
    }
    await this.reconcileFriendPairInTx(tx, actorUserId, peerUserId);
    return this.publishClientFriendPairInTx(tx, actorUserId, peerUserId);
  }

  private async publishClientFriendPairInTx(
    tx: DatabaseTransaction,
    firstUserId: number,
    secondUserId: number,
  ): Promise<Array<{ userId: number; revision: number }>> {
    const [first, second, directions] = await Promise.all([
      tx.query.user.findFirst({ where: eq(user.id, firstUserId) }),
      tx.query.user.findFirst({ where: eq(user.id, secondUserId) }),
      tx.query.friendRequest.findMany({
        where: or(
          and(
            eq(friendRequest.requesterUserId, firstUserId),
            eq(friendRequest.targetUserId, secondUserId),
          ),
          and(
            eq(friendRequest.requesterUserId, secondUserId),
            eq(friendRequest.targetUserId, firstUserId),
          ),
        ),
      }),
    ]);
    if (!first || !second) throw new Error('client friend intent user missing');
    const users = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    const pending: Array<{ userId: number; revision: number }> = [];
    for (const direction of directions) {
      const actor = users.get(direction.requesterUserId)!;
      const subject = users.get(direction.targetUserId)!;
      const commonBody = {
        inviteId: direction.id.toString(),
        status:
          direction.status === 'FRIEND'
            ? 'ACCEPTED'
            : direction.status === 'NOT_FRIEND'
              ? 'REVOKED'
              : 'REQUESTED',
        note: direction.note,
        requestedAt: direction.requestedAt?.getTime() ?? null,
        expiresAt: direction.expiresAt?.getTime() ?? null,
      };
      for (const owner of [actor, subject]) {
        if (owner.isForeigner || owner.isDeleted) continue;
        const body = {
          ...commonBody,
          direction: owner.id === actor.id ? 'OUTGOING' : 'INCOMING',
          peer: this.clientInviteUser(owner.id === actor.id ? subject : actor),
        };
        const revision = await this.clientStateFeed.writeInTx(tx, {
          userId: owner.id,
          account: actor.account,
          domain: actor.domain,
          eventType: 'P2P_INTENT',
          subjectAccount: subject.account,
          subjectDomain: subject.domain,
          body,
        });
        if (revision !== null) pending.push({ userId: owner.id, revision });
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
      domain: value.domain,
      isForeigner: value.isForeigner,
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
          id: friendRequest.id,
          fromUserId: friendRequest.requesterUserId,
          toUserId: friendRequest.targetUserId,
        })
        .from(friendRequest)
        .where(
          and(
            eq(friendRequest.status, 'REQUESTED'),
            gt(friendRequest.expiresAt, new Date()),
            or(
              and(
                eq(friendRequest.requesterUserId, me),
                inArray(friendRequest.targetUserId, userIds),
              ),
              and(
                eq(friendRequest.targetUserId, me),
                inArray(friendRequest.requesterUserId, userIds),
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
    const pendingRevisions: Array<{ userId: number; revision: number }> = [];
    const result = await this.database.db.transaction<CreateFriendInviteResult>(
      async (tx) => {
        void allowAutoAccept;
        void originIdOverride;
        const before = await tx.query.friendRequest.findFirst({
          where: and(
            eq(friendRequest.requesterUserId, fromUserId),
            eq(friendRequest.targetUserId, toUserId),
          ),
          columns: { status: true, note: true, expiresAt: true },
        });
        const created =
          !before ||
          before.status === 'NOT_FRIEND' ||
          (before.expiresAt !== null && before.expiresAt <= new Date());
        if (afterInviteWrite) await afterInviteWrite(tx, created);
        else
          pendingRevisions.push(
            ...(await this.writeLocalFriendIntentInTx(
              tx,
              fromUserId,
              toUserId,
              true,
              trimmed,
            )),
          );
        const request = await tx.query.friendRequest.findFirst({
          where: and(
            eq(friendRequest.requesterUserId, fromUserId),
            eq(friendRequest.targetUserId, toUserId),
          ),
          columns: { id: true, status: true },
        });
        if (!request) throw new Error('friend request write disappeared');
        const low = Math.min(fromUserId, toUserId);
        const high = Math.max(fromUserId, toUserId);
        const pair = await tx.query.friendPair.findFirst({
          where: and(
            eq(friendPair.userLowId, low),
            eq(friendPair.userHighId, high),
          ),
          columns: { active: true, threadId: true },
        });
        if (pair?.active && pair.threadId !== null) {
          pendingRevisions.push(
            {
              userId: fromUserId,
              revision: await this.threadRevisionService.recordThreadAddInTx(
                tx,
                fromUserId,
                pair.threadId,
              ),
            },
            {
              userId: toUserId,
              revision: await this.threadRevisionService.recordThreadAddInTx(
                tx,
                toUserId,
                pair.threadId,
              ),
            },
          );
          return { status: 'auto-accepted', threadId: pair.threadId };
        }
        return created
          ? { status: 'created', inviteId: request.id.toString() }
          : { status: 'already-pending', inviteId: request.id.toString() };
      },
    );
    // Record the thread add AFTER the tx commits (bump threadRevision + push signal). Auto-accept
    // creates the P2P thread for BOTH users — mirrors acceptInvite's recordThreadAdd for both
    // (inviter + accepter). The 'created'/'already-pending' paths create no thread, so no signal.
    pendingRevisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
    if (
      result.status === 'auto-accepted' &&
      this.messages &&
      this.messageFanout
    ) {
      const system = await this.messages.tryWriteSystemMessage(
        fromUserId,
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
          INSERT INTO "GroupMembershipRequest" (
            "groupUserId", "memberUserId", direction, status, note,
            "requestedAt", "expiresAt", "updatedAt"
          ) VALUES (${target.groupUserId}, ${toUserId}, 'INVITE', 'REQUESTED',
            ${trimmed}, CURRENT_TIMESTAMP, ${expiresAt}, CURRENT_TIMESTAMP)
          ON CONFLICT ("groupUserId", "memberUserId", direction) DO UPDATE SET
            status = 'REQUESTED', note = EXCLUDED.note,
            "requestedAt" = CURRENT_TIMESTAMP, "expiresAt" = EXCLUDED."expiresAt",
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "GroupMembershipRequest".status IS DISTINCT FROM 'REQUESTED'
             OR "GroupMembershipRequest".note IS DISTINCT FROM EXCLUDED.note
             OR "GroupMembershipRequest"."expiresAt" <= CURRENT_TIMESTAMP
        `);
      }
      const request = await tx.query.groupMembershipRequest.findFirst({
        where: and(
          eq(groupMembershipRequest.groupUserId, target.groupUserId),
          eq(groupMembershipRequest.memberUserId, toUserId),
          eq(groupMembershipRequest.direction, 'INVITE'),
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
    const pendingRevisions: Array<{ userId: number; revision: number }> = [];
    const result = await this.database.db.transaction(
      async (tx): Promise<AcceptInviteResult> => {
        const friend = await tx.query.friendRequest.findFirst({
          where: eq(friendRequest.id, id),
        });
        if (friend) {
          if (friend.status !== 'REQUESTED')
            throw new BusinessException(
              BusinessCode.INVITE_ALREADY_HANDLED,
              'friend request already handled',
            );
          if (friend.targetUserId !== byUserId)
            throw new BusinessException(
              BusinessCode.INVITE_NOT_YOURS,
              'this request is not yours to accept',
            );
          if (friend.expiresAt && friend.expiresAt.getTime() <= Date.now())
            throw new BusinessException(
              BusinessCode.INVITE_EXPIRED,
              'request expired',
            );
          const low = Math.min(friend.requesterUserId, byUserId);
          const high = Math.max(friend.requesterUserId, byUserId);
          const before = await tx.query.friendPair.findFirst({
            where: and(
              eq(friendPair.userLowId, low),
              eq(friendPair.userHighId, high),
            ),
            columns: { active: true },
          });
          if (afterFriendAccept)
            await afterFriendAccept(tx, friend.requesterUserId);
          else
            pendingRevisions.push(
              ...(await this.writeLocalFriendIntentInTx(
                tx,
                byUserId,
                friend.requesterUserId,
                true,
              )),
            );
          const pair = await tx.query.friendPair.findFirst({
            where: and(
              eq(friendPair.userLowId, low),
              eq(friendPair.userHighId, high),
            ),
            columns: { active: true, threadId: true },
          });
          const requester = await tx.query.user.findFirst({
            where: eq(user.id, friend.requesterUserId),
            columns: { isForeigner: true },
          });
          if (!pair?.active || pair.threadId === null) {
            if (!requester?.isForeigner)
              throw new Error(
                'local mutual friend requests did not activate the pair',
              );
            // Federation is a two-phase acknowledgement. Accepting writes our
            // FRIEND direction, while thread creation waits for the peer's
            // subsequent FRIEND state to return through its state feed.
            return {
              kind: 'FRIEND',
              fromUserId: friend.requesterUserId,
            };
          }
          if (!before?.active)
            pendingRevisions.push(
              {
                userId: friend.requesterUserId,
                revision: await this.threadRevisionService.recordThreadAddInTx(
                  tx,
                  friend.requesterUserId,
                  pair.threadId,
                ),
              },
              {
                userId: byUserId,
                revision: await this.threadRevisionService.recordThreadAddInTx(
                  tx,
                  byUserId,
                  pair.threadId,
                ),
              },
            );
          return {
            kind: 'FRIEND',
            threadId: pair.threadId,
            fromUserId: friend.requesterUserId,
          };
        }

        const membership = await tx.query.groupMembershipRequest.findFirst({
          where: eq(groupMembershipRequest.id, id),
        });
        if (!membership)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_FOUND,
            'request not found',
          );
        if (
          membership.direction !== 'INVITE' ||
          membership.status !== 'REQUESTED'
        )
          throw new BusinessException(
            BusinessCode.INVITE_ALREADY_HANDLED,
            'group request already handled',
          );
        if (membership.memberUserId !== byUserId)
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
          where: eq(messageThread.groupUserId, membership.groupUserId),
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
        if (!isMirror) {
          pendingRevisions.push(
            ...(await this.threadRevisionService.recordActiveLocalThreadRefreshInTx(
              tx,
              threadRow.id,
              [byUserId],
            )),
          );
          pendingRevisions.push({
            userId: byUserId,
            revision: await this.threadRevisionService.recordThreadAddInTx(
              tx,
              byUserId,
              threadRow.id,
            ),
          });
        }
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
    // Record the thread add AFTER the tx commits (bump threadRevision + push signal). FRIEND adds the
    // thread for BOTH users (inviter + accepter); GROUP adds it for the joiner only.
    pendingRevisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
    if (
      result.kind === 'FRIEND' &&
      result.threadId !== undefined &&
      this.messages &&
      this.messageFanout
    ) {
      const system = await this.messages.tryWriteSystemMessage(
        byUserId,
        result.threadId,
        SystemMessageType.FRIEND_ADDED,
      );
      if (system) void this.messageFanout.dispatch(system);
    }
    if (this.messages && this.messageFanout) {
      if (result.kind === 'GROUP' && result.originDomain === null) {
        // A mirror only authored a JOIN intent. Its origin server will emit
        // GROUP_JOINED after GROUP_META confirms membership; never announce
        // success optimistically on the requesting mirror.
        const joined = await this.messages.tryWriteSystemMessage(
          byUserId,
          result.threadId,
          SystemMessageType.GROUP_JOINED,
          byUserId,
        );
        if (joined) void this.messageFanout.dispatch(joined);
      }
    }
    return result;
  }

  /** Reject a pending invite addressed to `byUserId`. */
  async rejectInvite(
    inviteIdOrGroup: string,
    byUserId: number,
    afterReject?: (
      tx: DatabaseTransaction,
      fromUserId: number,
    ) => Promise<void>,
  ): Promise<void> {
    const id = await this.resolveInviteId(inviteIdOrGroup, byUserId, true);
    const pendingRevisions: Array<{ userId: number; revision: number }> = [];
    await this.database.db.transaction(async (tx) => {
      const request = await tx.query.friendRequest.findFirst({
        where: eq(friendRequest.id, id),
      });
      if (request) {
        if (request.status !== 'REQUESTED')
          throw new BusinessException(
            BusinessCode.INVITE_ALREADY_HANDLED,
            'request already handled',
          );
        if (request.targetUserId !== byUserId)
          throw new BusinessException(
            BusinessCode.INVITE_NOT_YOURS,
            'this request is not yours to reject',
          );
        if (afterReject) await afterReject(tx, request.requesterUserId);
        else
          pendingRevisions.push(
            ...(await this.writeLocalFriendIntentInTx(
              tx,
              byUserId,
              request.requesterUserId,
              false,
            )),
          );
        return;
      }

      const membership = await tx.query.groupMembershipRequest.findFirst({
        where: eq(groupMembershipRequest.id, id),
      });
      if (!membership)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_FOUND,
          'request not found',
        );
      if (
        membership.direction !== 'INVITE' ||
        membership.status !== 'REQUESTED'
      )
        throw new BusinessException(
          BusinessCode.INVITE_ALREADY_HANDLED,
          'group request already handled',
        );
      if (membership.memberUserId !== byUserId)
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this request is not yours to reject',
        );
      const [updated] = await tx
        .update(groupMembershipRequest)
        .set({
          status: 'NOT_MEMBER',
          expiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(groupMembershipRequest.id, id))
        .returning({ id: groupMembershipRequest.id });
      const [groupIdentity] = await tx
        .select({
          account: user.account,
          domain: user.domain,
          name: user.name,
          avatar: user.avatar,
          description: user.bio,
          profileRev: user.profileRev,
          threadId: messageThread.id,
        })
        .from(user)
        .innerJoin(messageThread, eq(messageThread.groupUserId, user.id))
        .where(eq(user.id, membership.groupUserId))
        .limit(1);
      if (!updated || !groupIdentity)
        throw new Error('group invite state disappeared while rejecting');
      const memberIdentity = await tx.query.user.findFirst({
        where: eq(user.id, byUserId),
        columns: { account: true },
      });
      if (!memberIdentity)
        throw new Error('group invite member disappeared while rejecting');
      const domain =
        groupIdentity.domain === 'local'
          ? this.config.domain
          : groupIdentity.domain;
      const revision = await this.clientStateFeed.writeInTx(tx, {
        userId: byUserId,
        account: groupIdentity.account,
        domain,
        eventType: 'GROUP_INVITE_INTENT',
        subjectAccount: memberIdentity.account,
        subjectDomain: this.config.domain,
        body: {
          status: 'REVOKED',
          note: membership.note,
          requestedAt: membership.requestedAt?.getTime() ?? null,
          expiresAt: null,
          threadId: groupIdentity.threadId,
          group: {
            account: groupIdentity.account,
            domain,
            isLocal: groupIdentity.domain === 'local',
            name: groupIdentity.name,
            avatar: groupIdentity.avatar,
            description: groupIdentity.description,
            profileRev: groupIdentity.profileRev,
          },
        },
      });
      if (revision !== null)
        pendingRevisions.push({ userId: byUserId, revision });
    });
    pendingRevisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
  }

  /** Revoke my own outgoing pending invite. */
  async revokeInvite(
    inviteId: string,
    byUserId: number,
    afterRevoke?: (tx: DatabaseTransaction, toUserId: number) => Promise<void>,
  ): Promise<void> {
    const id = this.parseInviteId(inviteId);
    const pendingRevisions: Array<{ userId: number; revision: number }> = [];
    await this.database.db.transaction(async (tx) => {
      const request = await tx.query.friendRequest.findFirst({
        where: eq(friendRequest.id, id),
      });
      if (!request || request.status !== 'REQUESTED') {
        throw new BusinessException(
          !request
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          !request ? 'request not found' : 'request already handled',
        );
      }
      if (request.requesterUserId !== byUserId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this request is not yours to revoke',
        );
      }
      if (afterRevoke) await afterRevoke(tx, request.targetUserId);
      else
        pendingRevisions.push(
          ...(await this.writeLocalFriendIntentInTx(
            tx,
            byUserId,
            request.targetUserId,
            false,
          )),
        );
    });
    pendingRevisions.forEach((pending) =>
      this.threadRevisionService.notifyThreadRevision(pending),
    );
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
          eq(friendRequest.targetUserId, userId),
          gt(friendRequest.requestedAt, since),
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
          eq(friendRequest.requesterUserId, userId),
          gt(friendRequest.requestedAt, since),
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
        isForeigner: true,
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
    const rows = await this.database.db.query.friendRequest.findMany({
      where: and(
        eq(friendRequest.status, 'REQUESTED'),
        gt(friendRequest.expiresAt, new Date()),
        extra,
      ),
      orderBy: desc(friendRequest.requestedAt),
      limit: LIST_LIMIT,
      with: {
        requester: { columns: USER_SELECT },
        target: { columns: USER_SELECT },
      },
    });
    return rows.map(({ requester, target, ...row }) => ({
      id: row.id,
      kind: 'FRIEND' as const,
      fromUserId: row.requesterUserId,
      toUserId: row.targetUserId,
      threadId: null,
      note: row.note,
      status: 'PENDING' as const,
      expiresAt: row.expiresAt ?? new Date(0),
      createdAt: row.requestedAt ?? row.updatedAt,
      updatedAt: row.updatedAt,
      fromUser: requester,
      toUser: target,
    }));
  }

  /** Revision-gated remote intent application. This runs inside the state-feed page transaction;
   * the pair row is also the lock that serializes crossed requests. */
  async applyRemoteFriendIntentInTx(
    tx: DatabaseTransaction,
    params: {
      localUserId: number;
      peerUserId: number;
      status: 'REQUESTED' | 'FRIEND' | 'NOT_FRIEND';
      note: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
      origin: string;
    },
  ): Promise<{
    changed: boolean;
    requestCreated: boolean;
    localStateRevision?: number;
    clientRevisions: Array<{ userId: number; revision: number }>;
    threadId?: number;
    added?: boolean;
    removed?: boolean;
  }> {
    await this.lockFriendPairInTx(tx, params.localUserId, params.peerUserId);
    const desired = params.status;
    if (desired === 'FRIEND') {
      const [localDirection, peerDirection] = await Promise.all([
        tx.query.friendRequest.findFirst({
          where: and(
            eq(friendRequest.requesterUserId, params.localUserId),
            eq(friendRequest.targetUserId, params.peerUserId),
          ),
          columns: { status: true, expiresAt: true },
        }),
        tx.query.friendRequest.findFirst({
          where: and(
            eq(friendRequest.requesterUserId, params.peerUserId),
            eq(friendRequest.targetUserId, params.localUserId),
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
        localDirection?.status === 'FRIEND' &&
        peerDirection?.status === 'REQUESTED' &&
        peerDirection.expiresAt !== null &&
        peerDirection.expiresAt > now;
      if (!confirmsLocalRequest && !completesAcceptedPeerRequest) {
        return { changed: false, requestCreated: false, clientRevisions: [] };
      }
    }
    const previous = await tx.query.friendRequest.findFirst({
      where: and(
        eq(friendRequest.requesterUserId, params.peerUserId),
        eq(friendRequest.targetUserId, params.localUserId),
      ),
      columns: { status: true, expiresAt: true },
    });
    const applied = await tx.execute(sql`
      INSERT INTO "FriendRequest" (
        "requesterUserId", "targetUserId", status, note,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.peerUserId}, ${params.localUserId},
        ${desired}::"FriendRequestStatus", ${params.note.slice(0, 255)},
        ${desired === 'NOT_FRIEND' ? null : params.requestedAt},
        ${desired === 'REQUESTED' ? params.expiresAt : null}, CURRENT_TIMESTAMP)
      ON CONFLICT ("requesterUserId", "targetUserId") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        "requestedAt" = EXCLUDED."requestedAt", "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "FriendRequest".status IS DISTINCT FROM EXCLUDED.status
         OR "FriendRequest".note IS DISTINCT FROM EXCLUDED.note
         OR "FriendRequest"."requestedAt" IS DISTINCT FROM EXCLUDED."requestedAt"
         OR "FriendRequest"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING 1
    `);
    if (!applied.rows[0])
      return { changed: false, requestCreated: false, clientRevisions: [] };
    let localStateRevision: number | undefined;
    if (desired === 'NOT_FRIEND') {
      const closed = await tx.execute(sql`
        UPDATE "FriendRequest" SET status = 'NOT_FRIEND', note = '',
          "expiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "requesterUserId" = ${params.localUserId}
          AND "targetUserId" = ${params.peerUserId}
          AND status <> 'NOT_FRIEND'
        RETURNING 1
      `);
      localStateRevision = closed.rows[0] ? 1 : undefined;
    } else {
      const confirmed = await tx.execute(sql`
        UPDATE "FriendRequest" SET status = 'FRIEND', "expiresAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "requesterUserId" = ${params.localUserId}
          AND "targetUserId" = ${params.peerUserId}
          AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING 1
      `);
      localStateRevision = confirmed.rows[0] ? 1 : undefined;
    }
    const pairEffect = await this.reconcileFriendPairInTx(
      tx,
      params.localUserId,
      params.peerUserId,
    );
    const clientRevisions = await this.publishClientFriendPairInTx(
      tx,
      params.localUserId,
      params.peerUserId,
    );
    if (pairEffect.active) {
      return {
        changed: true,
        requestCreated: false,
        clientRevisions,
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
        clientRevisions,
      };
    }
    void params.origin;
    return {
      changed: true,
      requestCreated: false,
      clientRevisions,
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
    const low = Math.min(userAId, userBId);
    const high = Math.max(userAId, userBId);
    if (low === high) throw new Error('friend pair requires two users');
    await tx.execute(sql`
      INSERT INTO "FriendPair" ("userLowId", "userHighId")
      VALUES (${low}, ${high}) ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      SELECT 1 FROM "FriendPair"
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
    const requests = await tx.execute<{
      requesterUserId: number;
      status: string;
      effective: boolean;
    }>(sql`
      SELECT "requesterUserId", status::text,
        (status = 'FRIEND') AS effective
      FROM "FriendRequest"
      WHERE ("requesterUserId" = ${userAId} AND "targetUserId" = ${userBId})
         OR ("requesterUserId" = ${userBId} AND "targetUserId" = ${userAId})
    `);
    const desiredActive =
      requests.rows.length === 2 &&
      requests.rows.every((request) => request.effective);
    const pair = await tx.execute<{
      active: boolean;
      threadId: number | null;
    }>(sql`
      SELECT active, "threadId" FROM "FriendPair"
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
        UPDATE "FriendPair" SET active = true, "threadId" = ${threadId},
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
        await tx
          .update(threadParticipant)
          .set({
            leftAt: new Date(),
            recognizesFriend: false,
            updatedAt: new Date(),
          })
          .where(eq(threadParticipant.threadId, current.threadId));
        await this.closeP2PAudiencesInTx(tx, current.threadId);
      }
      await tx.execute(sql`
        UPDATE "FriendPair" SET active = false, revision = revision + 1,
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
      .select({ id: messageThread.id })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!locked) throw new Error('retained P2P thread disappeared');
    const restored = await tx
      .update(threadParticipant)
      .set({
        leftAt: null,
        recognizesFriend: true,
        relationshipRev: sql`${threadParticipant.relationshipRev} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          inArray(threadParticipant.userId, [userAId, userBId]),
        ),
      )
      .returning({ id: threadParticipant.id });
    if (restored.length !== 2)
      throw new Error('retained P2P participants disappeared');
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
   *  findP2PThreadBetween's leftAt:null check). Since the thread is empty and cannot contain an old
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
        recognizesFriend: true,
        relationshipRev: (previousByUser.get(userAId) ?? 0) + 1,
        updatedAt: new Date(),
      },
      {
        userId: userBId,
        threadId: thread.id,
        recognizesFriend: true,
        relationshipRev: (previousByUser.get(userBId) ?? 0) + 1,
        updatedAt: new Date(),
      },
    ]);
    const participants = await tx
      .select({
        id: user.id,
        account: user.account,
        domain: user.domain,
        isForeigner: user.isForeigner,
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
      .select({ id: groupMembershipRequest.id })
      .from(groupMembershipRequest)
      .innerJoin(user, eq(user.id, groupMembershipRequest.groupUserId))
      .where(
        and(
          eq(groupMembershipRequest.memberUserId, callerId),
          eq(groupMembershipRequest.direction, 'INVITE'),
          pendingOnly
            ? eq(groupMembershipRequest.status, 'REQUESTED')
            : undefined,
          eq(user.account, normalizeAccount(groupAccount)),
          eq(user.isGroup, true),
        ),
      )
      .orderBy(desc(groupMembershipRequest.requestedAt))
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
