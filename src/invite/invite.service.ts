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
  federationP2PHistoryGrant,
  groupMembershipRequest,
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
    @Optional() private readonly messages?: MessageService,
    @Optional()
    @Inject(forwardRef(() => MessageFanoutService))
    private readonly messageFanout?: Pick<MessageFanoutService, 'dispatch'>,
  ) {}

  /** Apply one locally-authored direction. Purely local pairs use this same state machine but emit no
   * peer feed. The canonical pair row is locked before either directed request is inspected. */
  async writeLocalFriendIntentInTx(
    tx: DatabaseTransaction,
    actorUserId: number,
    peerUserId: number,
    wantsFriend: boolean,
    note = '',
  ): Promise<void> {
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
    await tx.execute(sql`
      INSERT INTO "FriendRequest" (
        "requesterUserId", "targetUserId", status, note, revision,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${actorUserId}, ${peerUserId}, ${desired}::"FriendRequestStatus",
        ${note.slice(0, 255)}, 1,
        ${wantsFriend ? new Date() : null},
        ${desired === 'REQUESTED' ? new Date(Date.now() + INVITE_TTL_MS) : null}, CURRENT_TIMESTAMP)
      ON CONFLICT ("requesterUserId", "targetUserId") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        revision = "FriendRequest".revision + 1,
        "requestedAt" = CASE WHEN EXCLUDED.status IN ('REQUESTED', 'FRIEND') THEN CURRENT_TIMESTAMP
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
          revision = revision + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "requesterUserId" = ${peerUserId}
          AND "targetUserId" = ${actorUserId}
          AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
      `);
    }
    const pairEffect = await this.reconcileFriendPairInTx(
      tx,
      actorUserId,
      peerUserId,
    );
    if (!wantsFriend && pairEffect.threadId !== undefined) {
      await tx
        .delete(federationP2PHistoryGrant)
        .where(eq(federationP2PHistoryGrant.threadId, pairEffect.threadId));
    }
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
          await this.writeLocalFriendIntentInTx(
            tx,
            fromUserId,
            toUserId,
            true,
            trimmed,
          );
        const [request, target] = await Promise.all([
          tx.query.friendRequest.findFirst({
            where: and(
              eq(friendRequest.requesterUserId, fromUserId),
              eq(friendRequest.targetUserId, toUserId),
            ),
            columns: { id: true, status: true },
          }),
          tx.query.user.findFirst({
            where: eq(user.id, toUserId),
            columns: { isForeigner: true },
          }),
        ]);
        if (!request) throw new Error('friend request write disappeared');
        if (created && request.status === 'REQUESTED' && !target?.isForeigner) {
          pendingRevisions.push({
            userId: toUserId,
            revision:
              await this.threadRevisionService.recordFriendRequestStateInTx(
                tx,
                toUserId,
              ),
          });
        }
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

  /**
   * Create (or refresh) a single GROUP invite. Returns the invite id — STABLE across overwrites (the
   * BigInt PK is unchanged; only originId refreshes), so an already-delivered card message still
   * resolves to the freshest invite. Does NOT arm the unread badge (a group invite surfaces as a card
   * message in the P2P thread, not the friend-pending badge). The caller friend-gates + writes that
   * card message.
   */
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
    void fromUserId;
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
            "groupUserId", "memberUserId", direction, status, note, revision,
            "requestedAt", "expiresAt", "updatedAt"
          ) VALUES (${target.groupUserId}, ${toUserId}, 'INVITE', 'REQUESTED',
            ${trimmed}, 1, CURRENT_TIMESTAMP, ${expiresAt}, CURRENT_TIMESTAMP)
          ON CONFLICT ("groupUserId", "memberUserId", direction) DO UPDATE SET
            status = 'REQUESTED', note = EXCLUDED.note,
            revision = "GroupMembershipRequest".revision + 1,
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
        columns: { id: true },
      });
      if (!request) throw new Error('group request write disappeared');
      return request.id.toString();
    });
  }

  /**
   * The live state of an invite for the group-invite dialog: status / expiry / target group identity /
   * whether the caller already joined. Non-leaking — an invite not addressed to the caller (or a missing
   * one) resolves to INVITE_NOT_FOUND. The dialog renders "valid → Join", "joined", "expired", or "invalid".
   */
  async getInviteDetail(
    inviteIdOrGroup: string,
    callerId: number,
  ): Promise<{
    id: string;
    kind: string;
    status: string;
    expiresAt: Date;
    note: string;
    threadId: number | null;
    groupName: string;
    groupAvatar: string;
    groupDomain: string;
    groupIsLocal: boolean;
    alreadyJoined: boolean;
    joinRequested: boolean;
    fromUser: {
      id: number;
      account: string;
      name: string;
      avatar: string;
      domain: string;
      isForeigner: boolean;
    };
  }> {
    const id = await this.resolveInviteId(inviteIdOrGroup, callerId, false);
    const request =
      await this.database.db.query.groupMembershipRequest.findFirst({
        where: eq(groupMembershipRequest.id, id),
        with: {
          groupUser: {
            columns: { id: true, name: true, avatar: true, domain: true },
          },
        },
      });
    if (
      !request ||
      request.memberUserId !== callerId ||
      request.direction !== 'INVITE'
    ) {
      throw new BusinessException(
        BusinessCode.INVITE_NOT_FOUND,
        'invite not found',
      );
    }
    const thread = await this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.groupUserId, request.groupUserId),
      columns: { id: true },
    });
    if (!thread)
      throw new BusinessException(
        BusinessCode.INVITE_NOT_FOUND,
        'group mirror missing',
      );
    const [p, groupRow, joinDirection] = await Promise.all([
      this.database.db.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.userId, callerId),
          eq(threadParticipant.threadId, thread.id),
        ),
        columns: { leftAt: true },
      }),
      this.database.db.query.group.findFirst({
        where: eq(group.groupUserId, request.groupUserId),
        columns: { ownerId: true },
      }),
      this.database.db.query.groupMembershipRequest.findFirst({
        where: and(
          eq(groupMembershipRequest.groupUserId, request.groupUserId),
          eq(groupMembershipRequest.memberUserId, callerId),
          eq(groupMembershipRequest.direction, 'JOIN'),
        ),
        columns: { status: true },
      }),
    ]);
    const owner = groupRow
      ? await this.database.db.query.user.findFirst({
          where: eq(user.id, groupRow.ownerId),
          columns: USER_SELECT,
        })
      : null;
    if (!owner)
      throw new BusinessException(
        BusinessCode.INVITE_NOT_FOUND,
        'group owner missing',
      );
    const alreadyJoined = !!p && p.leftAt === null;
    const gu = request.groupUser;
    const groupIsLocal = !gu?.domain || gu.domain === 'local';
    const groupDomain = groupIsLocal ? this.config.domain : (gu?.domain ?? '');
    return {
      id: request.id.toString(),
      kind: 'GROUP',
      status:
        request.status === 'REQUESTED'
          ? 'PENDING'
          : request.status === 'MEMBER'
            ? 'ACCEPTED'
            : 'REVOKED',
      expiresAt: request.expiresAt ?? new Date(0),
      note: request.note,
      threadId: thread.id,
      groupName: gu?.name ?? '',
      groupAvatar: gu?.avatar ?? '',
      groupDomain,
      groupIsLocal,
      alreadyJoined,
      joinRequested: !alreadyJoined && joinDirection?.status === 'REQUESTED',
      fromUser: owner,
    };
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
            await this.writeLocalFriendIntentInTx(
              tx,
              byUserId,
              friend.requesterUserId,
              true,
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
        if (!isMirror)
          pendingRevisions.push({
            userId: byUserId,
            revision: await this.threadRevisionService.recordThreadAddInTx(
              tx,
              byUserId,
              threadRow.id,
            ),
          });
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
    inviteId: string,
    byUserId: number,
    afterReject?: (
      tx: DatabaseTransaction,
      fromUserId: number,
    ) => Promise<void>,
  ): Promise<void> {
    const id = this.parseInviteId(inviteId);
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
      if (request.targetUserId !== byUserId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this request is not yours to reject',
        );
      }
      if (afterReject) await afterReject(tx, request.requesterUserId);
      else
        await this.closeLocalFriendIntentInTx(
          tx,
          byUserId,
          request.requesterUserId,
        );
    });
  }

  /** Revoke my own outgoing pending invite. */
  async revokeInvite(
    inviteId: string,
    byUserId: number,
    afterRevoke?: (tx: DatabaseTransaction, toUserId: number) => Promise<void>,
  ): Promise<void> {
    const id = this.parseInviteId(inviteId);
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
        await this.closeLocalFriendIntentInTx(
          tx,
          byUserId,
          request.targetUserId,
        );
    });
  }

  /**
   * Incoming PENDING friend invites for `userId`, newest first, last-7-days, ≤200. No client params.
   * The caller (controller) filters out any whose inviter is already a friend.
   */
  listIncoming(userId: number) {
    const since = new Date(Date.now() - INVITE_TTL_MS);
    return this.listFriendInvites(
      and(
        eq(friendRequest.targetUserId, userId),
        gt(friendRequest.requestedAt, since),
      ),
    );
  }

  /** Outgoing PENDING friend invites from `userId`, newest first, last-7-days, ≤200. */
  listOutgoing(userId: number) {
    const since = new Date(Date.now() - INVITE_TTL_MS);
    return this.listFriendInvites(
      and(
        eq(friendRequest.requesterUserId, userId),
        gt(friendRequest.requestedAt, since),
      ),
    );
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
      revision: number;
      requestedAt: Date | null;
      expiresAt: Date | null;
      origin: string;
    },
  ): Promise<{
    changed: boolean;
    requestCreated: boolean;
    localStateRevision?: number;
    threadId?: number;
    added?: boolean;
    removed?: boolean;
  }> {
    await this.lockFriendPairInTx(tx, params.localUserId, params.peerUserId);
    const desired = params.status;
    const previous = await tx.query.friendRequest.findFirst({
      where: and(
        eq(friendRequest.requesterUserId, params.peerUserId),
        eq(friendRequest.targetUserId, params.localUserId),
      ),
      columns: { status: true, expiresAt: true },
    });
    const applied = await tx.execute<{ revision: number }>(sql`
      INSERT INTO "FriendRequest" (
        "requesterUserId", "targetUserId", status, note, revision,
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.peerUserId}, ${params.localUserId},
        ${desired}::"FriendRequestStatus", ${params.note.slice(0, 255)},
        ${params.revision}, ${desired === 'NOT_FRIEND' ? null : params.requestedAt},
        ${desired === 'REQUESTED' ? params.expiresAt : null}, CURRENT_TIMESTAMP)
      ON CONFLICT ("requesterUserId", "targetUserId") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note, revision = EXCLUDED.revision,
        "requestedAt" = EXCLUDED."requestedAt", "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "FriendRequest".revision < EXCLUDED.revision
      RETURNING revision
    `);
    if (!applied.rows[0]) return { changed: false, requestCreated: false };
    let localStateRevision: number | undefined;
    if (desired === 'NOT_FRIEND') {
      const closed = await tx.execute<{ revision: number }>(sql`
        UPDATE "FriendRequest" SET status = 'NOT_FRIEND', note = '',
          "expiresAt" = NULL, revision = revision + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "requesterUserId" = ${params.localUserId}
          AND "targetUserId" = ${params.peerUserId}
          AND status <> 'NOT_FRIEND'
        RETURNING revision
      `);
      localStateRevision = closed.rows[0]?.revision;
    } else {
      const confirmed = await tx.execute<{ revision: number }>(sql`
        UPDATE "FriendRequest" SET status = 'FRIEND', "expiresAt" = NULL,
          revision = revision + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "requesterUserId" = ${params.localUserId}
          AND "targetUserId" = ${params.peerUserId}
          AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING revision
      `);
      localStateRevision = confirmed.rows[0]?.revision;
      if (localStateRevision === undefined && desired === 'FRIEND') {
        // A peer may still advertise its established, non-expiring FRIEND
        // direction after this user deleted the relationship. Preserve that
        // standing peer consent, but refresh our newer NOT_FRIEND direction so
        // the state-feed caller sends the deletion back and both sides
        // converge. A valid local REQUESTED direction took the confirmation
        // branch above and becomes FRIEND instead.
        const rejected = await tx.execute<{ revision: number }>(sql`
          UPDATE "FriendRequest" SET revision = revision + 1,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "requesterUserId" = ${params.localUserId}
            AND "targetUserId" = ${params.peerUserId}
            AND status = 'NOT_FRIEND'
          RETURNING revision
        `);
        localStateRevision = rejected.rows[0]?.revision;
      }
    }
    const pairEffect = await this.reconcileFriendPairInTx(
      tx,
      params.localUserId,
      params.peerUserId,
    );
    if (pairEffect.active) {
      return {
        changed: true,
        requestCreated: false,
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
      };
    }
    void params.origin;
    return {
      changed: true,
      requestCreated: false,
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

  /** Close every P2P subscription at an exact message-feed boundary. */
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
      UPDATE "ThreadAudience" audience
      SET "deliverThroughChangeId" = 0
      WHERE audience."threadId" = ${threadId}
        AND audience."targetDomain" = 'local'
        AND audience."deliverThroughChangeId" IS NULL
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
    await tx
      .update(threadAudience)
      .set({ deliverThroughChangeId: null })
      .where(
        and(
          eq(threadAudience.threadId, threadId),
          eq(threadAudience.targetDomain, 'local'),
        ),
      );
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
      await openFederatedAudienceInTx(tx, peer.domain, threadId);
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

  /** Materialize a retained read-only P2P shell for history authorized by a compacted remote
   * REVOKED snapshot. This never activates FriendPair or grants write access. */
  async ensureP2PHistoryThreadInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    peerUserId: number,
  ): Promise<number> {
    await this.lockFriendPairInTx(tx, localUserId, peerUserId);
    const low = Math.min(localUserId, peerUserId);
    const high = Math.max(localUserId, peerUserId);
    const [pair] = await tx
      .select({ threadId: friendPair.threadId })
      .from(friendPair)
      .where(
        and(eq(friendPair.userLowId, low), eq(friendPair.userHighId, high)),
      )
      .limit(1);
    if (pair?.threadId !== null && pair?.threadId !== undefined)
      return pair.threadId;

    const threadId = await this.createP2PFriendshipInTx(
      tx,
      localUserId,
      peerUserId,
    );
    const now = new Date();
    await tx
      .update(threadParticipant)
      .set({
        leftAt: now,
        recognizesFriend: false,
        updatedAt: now,
      })
      .where(eq(threadParticipant.threadId, threadId));
    await tx
      .update(threadAudience)
      .set({ deliverThroughChangeId: 0n })
      .where(
        and(
          eq(threadAudience.threadId, threadId),
          sql`${threadAudience.targetDomain} <> 'local'`,
        ),
      );
    await tx
      .update(friendPair)
      .set({ active: false, threadId, updatedAt: now })
      .where(
        and(eq(friendPair.userLowId, low), eq(friendPair.userHighId, high)),
      );
    return threadId;
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

  /**
   * Find the caller's local GROUP Invite row for a group `!account` (the federated-stable card identity):
   * matched on (toUserId=caller, kind=GROUP) for the group whose account equals groupAccount — the row
   * handleGroupInvite created. `pendingOnly` — detail shows any-status (so an already-joined invite
   * renders its final state); accept requires PENDING. Returns null if no such invite (caller throws
   * the domain error).
   */
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
