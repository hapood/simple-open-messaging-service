import { Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  max,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  group,
  invite,
  messageThread,
  threadParticipant,
  user,
} from '../database/schema.js';
import {
  GroupRole,
  InviteKind,
  InviteStatus,
  MessageThreadType,
} from '../database/enums.js';
import { mintUlid, normalizeAccount } from '../common/account.js';
import { loadFederationConfig } from '../federation/federation.config.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { ThreadRevisionService } from '../thread-revision/thread-revision.service.js';

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
  | { kind: 'FRIEND'; threadId: number; fromUserId: number }
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
 * The service owns DB + the derived `friendReqRev` (MAX(createdAt) over incoming FRIEND invites — the
 * friend-request badge the client derives from HELLO/push; creation-based so it arms ONLY on a NEW request).
 * It is deliberately decoupled from federation + SSE — the controller orchestrates S2S delivery and the live
 * NOTIFY / FRIEND_REQ_REV_UPDATED frames based on the structured results returned here.
 */
@Injectable()
export class InviteService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly database: DatabaseService,
    private readonly participantService: ThreadParticipantService,
    private readonly threadRevisionService: ThreadRevisionService,
  ) {}

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

    const [friendIds, invites] = await Promise.all([
      this.participantService.getActiveP2PPeerUserIds(me),
      this.database.db
        .select({
          id: invite.id,
          fromUserId: invite.fromUserId,
          toUserId: invite.toUserId,
        })
        .from(invite)
        .where(
          and(
            eq(invite.kind, InviteKind.FRIEND),
            eq(invite.status, InviteStatus.PENDING),
            gt(invite.expiresAt, new Date()),
            or(
              and(eq(invite.fromUserId, me), inArray(invite.toUserId, userIds)),
              and(eq(invite.toUserId, me), inArray(invite.fromUserId, userIds)),
            ),
          ),
        ),
    ]);
    const friends = new Set(friendIds);
    const outgoing = new Map(
      invites
        .filter((invite) => invite.fromUserId === me)
        .map((invite) => [invite.toUserId, invite.id.toString()]),
    );
    const incoming = new Map(
      invites
        .filter((invite) => invite.toUserId === me)
        .map((invite) => [invite.fromUserId, invite.id.toString()]),
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
  ): Promise<CreateFriendInviteResult> {
    const trimmed = (note ?? '').slice(0, 255);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const origin = this.config.domain;

    // Explicit type param keeps the callback's `status` literals from widening to string (the
    // bare `const result = await …` form loses the method-return contextual type the old
    // returning the transaction promise directly used to provide implicitly).
    const result = await this.database.db.transaction<CreateFriendInviteResult>(
      async (tx) => {
        if (allowAutoAccept) {
          const mutual = await tx.query.invite.findFirst({
            where: and(
              eq(invite.kind, InviteKind.FRIEND),
              eq(invite.status, InviteStatus.PENDING),
              eq(invite.fromUserId, toUserId),
              eq(invite.toUserId, fromUserId),
            ),
          });
          if (mutual) {
            const threadId = await this.createP2PFriendshipInTx(
              tx,
              fromUserId,
              toUserId,
            );
            await tx
              .update(invite)
              .set({ status: InviteStatus.ACCEPTED, updatedAt: new Date() })
              .where(eq(invite.id, mutual.id));
            return { status: 'auto-accepted', threadId };
          }
        }

        const originId = originIdOverride ?? mintUlid();
        const [created] = await tx
          .insert(invite)
          .values({
            kind: InviteKind.FRIEND,
            fromUserId,
            toUserId,
            note: trimmed,
            status: InviteStatus.PENDING,
            expiresAt,
            origin,
            originId,
            updatedAt: new Date(),
          })
          .onConflictDoNothing()
          .returning({ id: invite.id });
        if (created) {
          // The friend-request badge is derived (MAX(createdAt) over incoming FRIEND invites) — creating
          // this PENDING row advances it automatically (accept/decline don't: createdAt is immutable); no
          // denormalized badge column to arm here.
          return { status: 'created', inviteId: created.id.toString() };
        }
        // Partial unique index (FRIEND, from→to, PENDING) — refresh the existing row in place.
        const existing = await tx.query.invite.findFirst({
          where: and(
            eq(invite.kind, InviteKind.FRIEND),
            eq(invite.status, InviteStatus.PENDING),
            eq(invite.fromUserId, fromUserId),
            eq(invite.toUserId, toUserId),
          ),
        });
        if (!existing)
          throw new Error('invite insert conflicted without a pending row');
        await tx
          .update(invite)
          .set({
            note: trimmed,
            expiresAt,
            origin,
            originId,
            updatedAt: new Date(),
          })
          .where(eq(invite.id, existing.id));
        return {
          status: 'already-pending',
          inviteId: existing.id.toString(),
        };
      },
    );
    // Record the thread add AFTER the tx commits (bump threadRevision + push signal). Auto-accept
    // creates the P2P thread for BOTH users — mirrors acceptInvite's recordThreadAdd for both
    // (inviter + accepter). The 'created'/'already-pending' paths create no thread, so no signal.
    if (result.status === 'auto-accepted') {
      await this.threadRevisionService.recordThreadAdd(
        fromUserId,
        result.threadId,
      );
      await this.threadRevisionService.recordThreadAdd(
        toUserId,
        result.threadId,
      );
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
  ): Promise<string> {
    const trimmed = (note ?? '').slice(0, 255);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    // Inbound federated invites carry the peer's (origin, originId) for delivery dedup; local invites
    // mint our domain + a fresh ULID.
    const origin = originOverride?.origin ?? this.config.domain;
    const originId = originOverride?.originId ?? mintUlid();
    const [created] = await this.database.db
      .insert(invite)
      .values({
        kind: InviteKind.GROUP,
        fromUserId,
        toUserId,
        threadId,
        note: trimmed,
        status: InviteStatus.PENDING,
        expiresAt,
        origin,
        originId,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: invite.id });
    if (created) return created.id.toString();
    // Partial unique index (GROUP, to, thread, PENDING) — refresh in place; id stays stable.
    const existing = await this.database.db.query.invite.findFirst({
      where: and(
        eq(invite.kind, InviteKind.GROUP),
        eq(invite.status, InviteStatus.PENDING),
        eq(invite.toUserId, toUserId),
        eq(invite.threadId, threadId),
      ),
    });
    if (existing) {
      await this.database.db
        .update(invite)
        .set({
          fromUserId,
          note: trimmed,
          expiresAt,
          origin,
          originId,
          updatedAt: new Date(),
        })
        .where(eq(invite.id, existing.id));
      return existing.id.toString();
    }
    throw new Error('group invite insert conflicted without a pending row');
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
    const inviteRow = await this.database.db.query.invite.findFirst({
      where: eq(invite.id, id),
      with: {
        user_fromUserId: { columns: USER_SELECT },
        messageThread: {
          columns: { id: true },
          with: {
            user: { columns: { name: true, avatar: true, domain: true } },
          },
        },
      },
    });
    if (!inviteRow || inviteRow.toUserId !== callerId) {
      throw new BusinessException(
        BusinessCode.INVITE_NOT_FOUND,
        'invite not found',
      );
    }
    let alreadyJoined = false;
    if (inviteRow.threadId !== null) {
      const p = await this.database.db.query.threadParticipant.findFirst({
        where: and(
          eq(threadParticipant.userId, callerId),
          eq(threadParticipant.threadId, inviteRow.threadId),
        ),
        columns: { leftAt: true },
      });
      alreadyJoined = !!p && p.leftAt === null;
    }
    const gu = inviteRow.messageThread?.user;
    const groupIsLocal = !gu?.domain || gu.domain === 'local';
    const groupDomain = groupIsLocal ? this.config.domain : (gu?.domain ?? '');
    return {
      id: inviteRow.id.toString(),
      kind: inviteRow.kind,
      status: inviteRow.status,
      expiresAt: inviteRow.expiresAt,
      note: inviteRow.note,
      threadId: inviteRow.threadId,
      groupName: gu?.name ?? '',
      groupAvatar: gu?.avatar ?? '',
      groupDomain,
      groupIsLocal,
      alreadyJoined,
      fromUser: inviteRow.user_fromUserId,
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
  ): Promise<AcceptInviteResult> {
    const id = await this.resolveInviteId(inviteIdOrGroup, byUserId, true);
    const result = await this.database.db.transaction(
      async (tx): Promise<AcceptInviteResult> => {
        const inviteRow = await tx.query.invite.findFirst({
          where: eq(invite.id, id),
        });
        if (!inviteRow || inviteRow.status !== InviteStatus.PENDING) {
          throw new BusinessException(
            !inviteRow
              ? BusinessCode.INVITE_NOT_FOUND
              : BusinessCode.INVITE_ALREADY_HANDLED,
            !inviteRow ? 'invite not found' : 'invite already handled',
          );
        }
        if (inviteRow.toUserId !== byUserId) {
          throw new BusinessException(
            BusinessCode.INVITE_NOT_YOURS,
            'this invite is not yours to accept',
          );
        }
        if (inviteRow.expiresAt.getTime() <= Date.now()) {
          throw new BusinessException(
            BusinessCode.INVITE_EXPIRED,
            'invite expired',
          );
        }

        if (inviteRow.kind === InviteKind.FRIEND) {
          const threadId = await this.createP2PFriendshipInTx(
            tx,
            inviteRow.fromUserId,
            inviteRow.toUserId,
          );
          const now = new Date();
          await tx
            .update(invite)
            .set({ status: InviteStatus.ACCEPTED, updatedAt: now })
            .where(eq(invite.id, id));
          // Symmetric cleanup: any other pending friend invite between this pair (either direction) is
          // now moot — mark it ACCEPTED so it leaves both pending lists.
          await tx
            .update(invite)
            .set({ status: InviteStatus.ACCEPTED, updatedAt: now })
            .where(
              and(
                eq(invite.kind, InviteKind.FRIEND),
                eq(invite.status, InviteStatus.PENDING),
                ne(invite.id, id),
                or(
                  and(
                    eq(invite.fromUserId, inviteRow.fromUserId),
                    eq(invite.toUserId, inviteRow.toUserId),
                  ),
                  and(
                    eq(invite.fromUserId, inviteRow.toUserId),
                    eq(invite.toUserId, inviteRow.fromUserId),
                  ),
                ),
              ),
            );
          return {
            kind: 'FRIEND',
            threadId,
            fromUserId: inviteRow.fromUserId,
          };
        }

        // GROUP
        if (inviteRow.threadId === null) {
          throw new BusinessException(
            BusinessCode.INVITE_NOT_FOUND,
            'group invite has no target thread',
          );
        }
        const [groupState] = await tx
          .select({ dissolvedAt: group.dissolvedAt })
          .from(messageThread)
          .leftJoin(group, eq(group.groupUserId, messageThread.groupUserId))
          .where(eq(messageThread.id, inviteRow.threadId))
          .limit(1);
        if (groupState?.dissolvedAt != null) {
          throw new BusinessException(
            BusinessCode.GROUP_DISSOLVED,
            'group has been dissolved',
          );
        }
        // NOTE: upsertMemberInTx(tx, threadId, userId, role) — threadId FIRST. (A swapped-arg bug here left
        // the group accept marking the Invite ACCEPTED but never adding the joiner to the mirror thread.)
        await this.participantService.upsertMemberInTx(
          tx,
          inviteRow.threadId,
          byUserId,
          GroupRole.MEMBER,
        );
        await tx
          .update(invite)
          .set({ status: InviteStatus.ACCEPTED, updatedAt: new Date() })
          .where(eq(invite.id, id));
        // The group's federation fields: a cross-server mirror iff groupUser.domain !== 'local'. The
        // controller uses originDomain (non-null = mirror) to propagate the join to the origin (roster fanout).
        const [thread] = await tx
          .select({ account: user.account, domain: user.domain })
          .from(messageThread)
          .leftJoin(user, eq(user.id, messageThread.groupUserId))
          .where(eq(messageThread.id, inviteRow.threadId))
          .limit(1);
        const groupAccount = thread?.account ?? null;
        const groupDomain = thread?.domain ?? null;
        return {
          kind: 'GROUP',
          threadId: inviteRow.threadId,
          fedGroupAccount: groupAccount, // the group `!account` (S2S 'to'); non-null for any group
          originDomain:
            groupDomain && groupDomain !== 'local' ? groupDomain : null, // non-null = federated mirror
        };
      },
    );
    // Record the thread add AFTER the tx commits (bump threadRevision + push signal). FRIEND adds the
    // thread for BOTH users (inviter + accepter); GROUP adds it for the joiner only.
    if (result.kind === 'FRIEND') {
      await this.threadRevisionService.recordThreadAdd(
        result.fromUserId,
        result.threadId,
      );
      await this.threadRevisionService.recordThreadAdd(
        byUserId,
        result.threadId,
      );
    } else {
      await this.threadRevisionService.recordThreadAdd(
        byUserId,
        result.threadId,
      );
    }
    return result;
  }

  /** Reject a pending invite addressed to `byUserId`. */
  async rejectInvite(inviteId: string, byUserId: number): Promise<void> {
    const id = this.parseInviteId(inviteId);
    await this.database.db.transaction(async (tx) => {
      const inviteRow = await tx.query.invite.findFirst({
        where: eq(invite.id, id),
      });
      if (!inviteRow || inviteRow.status !== InviteStatus.PENDING) {
        throw new BusinessException(
          !inviteRow
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          !inviteRow ? 'invite not found' : 'invite already handled',
        );
      }
      if (inviteRow.toUserId !== byUserId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this invite is not yours to reject',
        );
      }
      await tx
        .update(invite)
        .set({ status: InviteStatus.REJECTED, updatedAt: new Date() })
        .where(eq(invite.id, id));
    });
  }

  /** Revoke my own outgoing pending invite. */
  async revokeInvite(inviteId: string, byUserId: number): Promise<void> {
    const id = this.parseInviteId(inviteId);
    await this.database.db.transaction(async (tx) => {
      const inviteRow = await tx.query.invite.findFirst({
        where: eq(invite.id, id),
      });
      if (!inviteRow || inviteRow.status !== InviteStatus.PENDING) {
        throw new BusinessException(
          !inviteRow
            ? BusinessCode.INVITE_NOT_FOUND
            : BusinessCode.INVITE_ALREADY_HANDLED,
          !inviteRow ? 'invite not found' : 'invite already handled',
        );
      }
      if (inviteRow.fromUserId !== byUserId) {
        throw new BusinessException(
          BusinessCode.INVITE_NOT_YOURS,
          'this invite is not yours to revoke',
        );
      }
      await tx
        .update(invite)
        .set({ status: InviteStatus.REVOKED, updatedAt: new Date() })
        .where(eq(invite.id, id));
    });
  }

  /** Resolve a pending outgoing invite before a consumer revoke. The controller uses the embedded
   * recipient address to synchronously notify a federated peer before committing the local terminal. */
  async getOutgoingRevokeContext(inviteId: string, byUserId: number) {
    const id = this.parseInviteId(inviteId);
    const inviteRow = await this.database.db.query.invite.findFirst({
      where: eq(invite.id, id),
      with: { user_toUserId: { columns: USER_SELECT } },
    });
    if (!inviteRow || inviteRow.status !== InviteStatus.PENDING) {
      throw new BusinessException(
        !inviteRow
          ? BusinessCode.INVITE_NOT_FOUND
          : BusinessCode.INVITE_ALREADY_HANDLED,
        !inviteRow ? 'invite not found' : 'invite already handled',
      );
    }
    if (inviteRow.fromUserId !== byUserId) {
      throw new BusinessException(
        BusinessCode.INVITE_NOT_YOURS,
        'this invite is not yours to revoke',
      );
    }
    return {
      originId: inviteRow.originId,
      toUser: inviteRow.user_toUserId,
    };
  }

  /** Apply a signed peer withdrawal to our mirrored incoming invite using the correlation id shared
   * when the federated invite was created. */
  async revokeInboundFriendInvite(params: {
    fromUserId: number;
    toUserId: number;
    origin: string;
    originId: string;
  }): Promise<void> {
    const inviteRow = await this.database.db.query.invite.findFirst({
      where: and(
        eq(invite.origin, params.origin),
        eq(invite.originId, params.originId),
      ),
      columns: {
        id: true,
        kind: true,
        status: true,
        fromUserId: true,
        toUserId: true,
      },
    });
    if (
      !inviteRow ||
      inviteRow.kind !== InviteKind.FRIEND ||
      inviteRow.fromUserId !== params.fromUserId ||
      inviteRow.toUserId !== params.toUserId ||
      inviteRow.status !== InviteStatus.PENDING
    ) {
      return;
    }
    await this.database.db
      .update(invite)
      .set({ status: InviteStatus.REVOKED, updatedAt: new Date() })
      .where(eq(invite.id, inviteRow.id));
  }

  /**
   * Incoming PENDING friend invites for `userId`, newest first, last-7-days, ≤200. No client params.
   * The caller (controller) filters out any whose inviter is already a friend.
   */
  listIncoming(userId: number) {
    const since = new Date(Date.now() - INVITE_TTL_MS);
    return this.listFriendInvites(
      and(eq(invite.toUserId, userId), gt(invite.createdAt, since)),
    );
  }

  /** Outgoing PENDING friend invites from `userId`, newest first, last-7-days, ≤200. */
  listOutgoing(userId: number) {
    const since = new Date(Date.now() - INVITE_TTL_MS);
    return this.listFriendInvites(
      and(eq(invite.fromUserId, userId), gt(invite.createdAt, since)),
    );
  }

  private async listFriendInvites(extra: SQL | undefined) {
    const rows = await this.database.db.query.invite.findMany({
      where: and(
        eq(invite.kind, InviteKind.FRIEND),
        eq(invite.status, InviteStatus.PENDING),
        extra,
      ),
      orderBy: desc(invite.createdAt),
      limit: LIST_LIMIT,
      with: {
        user_fromUserId: { columns: USER_SELECT },
        user_toUserId: { columns: USER_SELECT },
      },
    });
    return rows.map(({ user_fromUserId, user_toUserId, ...row }) => ({
      ...row,
      fromUser: user_fromUserId,
      toUser: user_toUserId,
    }));
  }

  /** Acknowledge the friend-request badge (the panel was opened): advance the server-side read cursor
   *  `friendReqAckRev` (a Date) to the current `friendReqRev` (MAX(createdAt)), clearing the badge on ALL
   *  devices (the caller pushes the returned state via FRIEND_REQ_REV_UPDATED). Returns the post-ack wire
   *  state (epoch-ms) so the caller can push without a re-read. */
  async markRead(
    userId: number,
  ): Promise<{ friendReqRev: number | null; friendReqAckRev: number }> {
    const d = await this.latestFriendReqDate(userId);
    const ackDate = d ?? new Date(0); // no incoming FRIEND invites → ack epoch (no badge either way)
    await this.database.db
      .update(user)
      .set({ friendReqAckRev: ackDate, updatedAt: new Date() })
      .where(eq(user.id, userId));
    return {
      friendReqRev: d ? d.getTime() : null,
      friendReqAckRev: ackDate.getTime(),
    };
  }

  /** The `createdAt` of the most-recently-CREATED incoming FRIEND invite (the raw, Date-typed derivation),
   *  or null when the user has none. Creation-based (NOT updatedAt): the badge must arm ONLY on a NEW
   *  request, so the derivation advances ONLY on create — accept/decline/expiry flip status (bumping
   *  updatedAt) but must NOT re-arm the badge, hence createdAt. Monotonic + DATA-DERIVED (no counter). */
  private async latestFriendReqDate(userId: number): Promise<Date | null> {
    const [res] = await this.database.db
      .select({ createdAt: max(invite.createdAt) })
      .from(invite)
      .where(
        and(eq(invite.kind, InviteKind.FRIEND), eq(invite.toUserId, userId)),
      );
    return res.createdAt ?? null;
  }

  /** The friend-request revision as epoch-ms (the wire form), or null. */
  async findLatestFriendReqUpdate(userId: number): Promise<number | null> {
    const d = await this.latestFriendReqDate(userId);
    return d ? d.getTime() : null;
  }

  /** The full friend-request badge state — `{ friendReqRev, friendReqAckRev }` (epoch-ms) — what HELLO +
   *  the FRIEND_REQ_REV_UPDATED push carry (so the native layer merges both + the client derives
   *  `friendReqRev > friendReqAckRev`). */
  async friendReqState(
    userId: number,
  ): Promise<{ friendReqRev: number | null; friendReqAckRev: number }> {
    const [d, userRow] = await Promise.all([
      this.latestFriendReqDate(userId),
      this.database.db.query.user.findFirst({
        where: eq(user.id, userId),
        columns: { friendReqAckRev: true },
      }),
    ]);
    return {
      friendReqRev: d ? d.getTime() : null,
      friendReqAckRev: userRow?.friendReqAckRev
        ? userRow.friendReqAckRev.getTime()
        : 0,
    };
  }

  // ─── federation inbound (called by FriendOpHandler) ──────────────────────────

  /**
   * Inbound friend-request from a peer: create the incoming FRIEND Invite from the foreign stub to
   * the local user, carrying the PEER's (origin, originId) for cross-server delivery dedup. Arms the
   * recipient's badge. The FriendOpHandler already deduped via S2SFriendOpSeen, so a P2002 here is the
   * (from→to) partial unique index → refresh the existing PENDING invite in place. Never auto-accepts
   * (the inviter is foreign — the recipient must accept the delivered invite explicitly).
   */
  async receiveInboundFriendInvite(params: {
    fromUserId: number;
    toUserId: number;
    note: string;
    origin: string;
    originId: string;
    expiresAt: Date;
  }): Promise<string> {
    const note = (params.note ?? '').slice(0, 255);
    const [created] = await this.database.db
      .insert(invite)
      .values({
        kind: InviteKind.FRIEND,
        fromUserId: params.fromUserId,
        toUserId: params.toUserId,
        note,
        status: InviteStatus.PENDING,
        expiresAt: params.expiresAt,
        origin: params.origin,
        originId: params.originId,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: invite.id });
    if (created) {
      // Creating this PENDING row advances the derived friendReqRev (MAX(createdAt) over incoming FRIEND
      // invites) — no denormalized badge column to arm.
      return created.id.toString();
    }
    // Existing PENDING invite from this foreign stub → refresh in place, keep the badge armed.
    const existing = await this.database.db.query.invite.findFirst({
      where: and(
        eq(invite.kind, InviteKind.FRIEND),
        eq(invite.status, InviteStatus.PENDING),
        eq(invite.fromUserId, params.fromUserId),
        eq(invite.toUserId, params.toUserId),
      ),
    });
    if (existing) {
      await this.database.db
        .update(invite)
        .set({
          note,
          expiresAt: params.expiresAt,
          origin: params.origin,
          originId: params.originId,
          updatedAt: new Date(),
        })
        .where(eq(invite.id, existing.id));
      return existing.id.toString();
    }
    throw new Error('inbound invite insert conflicted without a pending row');
  }

  /**
   * Inbound friend-approve from a peer: the remote user accepted our local user's invite. Mark every
   * PENDING invite between the pair (including a crossed reverse request) ACCEPTED, and form the
   * friendship if it isn't already (ACCEPT-WINS — robust under message reordering: even if the
   * outgoing invite was revoked/expired/never landed, the approver definitively approved, so the
   * friendship is formed). Returns the P2P threadId + whether it was newly created (for SSE).
   */
  async applyInboundFriendApprove(
    localRequesterId: number,
    foreignApproverId: number,
  ): Promise<{ threadId: number; created: boolean }> {
    return this.database.db.transaction(async (tx) => {
      await tx
        .update(invite)
        .set({ status: InviteStatus.ACCEPTED, updatedAt: new Date() })
        .where(
          and(
            eq(invite.kind, InviteKind.FRIEND),
            eq(invite.status, InviteStatus.PENDING),
            or(
              and(
                eq(invite.fromUserId, localRequesterId),
                eq(invite.toUserId, foreignApproverId),
              ),
              and(
                eq(invite.fromUserId, foreignApproverId),
                eq(invite.toUserId, localRequesterId),
              ),
            ),
          ),
        );
      const existing = await this.findP2PThreadBetweenInTx(
        tx,
        localRequesterId,
        foreignApproverId,
      );
      if (existing !== null) return { threadId: existing, created: false };
      const threadId = await this.createP2PFriendshipInTx(
        tx,
        localRequesterId,
        foreignApproverId,
      );
      return { threadId, created: true };
    });
  }

  // ─── internals ───────────────────────────────────────────────────────────────

  /** In-tx version of ThreadParticipantService.findP2PThreadBetween: the id of the active P2P thread
   *  two users share (leftAt null on BOTH), or null. Used by applyInboundFriendApprove's accept-wins
   *  check to avoid minting a second thread when the friendship already exists. */
  private async findP2PThreadBetweenInTx(
    tx: DatabaseTransaction,
    userX: number,
    userY: number,
  ): Promise<number | null> {
    const result = await tx.execute<{ threadId: number }>(sql`
      SELECT mine."threadId"
      FROM "ThreadParticipant" mine
      JOIN "ThreadParticipant" peer ON peer."threadId" = mine."threadId"
      JOIN "MessageThread" thread ON thread.id = mine."threadId"
      WHERE mine."userId" = ${userX}
        AND peer."userId" = ${userY}
        AND mine."leftAt" IS NULL
        AND peer."leftAt" IS NULL
        AND thread.type = ${MessageThreadType.P2P}
      LIMIT 1
    `);
    return result.rows[0]?.threadId ?? null;
  }

  /** Create the P2P MessageThread + both active participants. A fresh threadId means brand-new
   *  participant rows even when re-friending (the old soft-left thread stays, filtered out by
   *  findP2PThreadBetween's leftAt:null check). */
  private async createP2PFriendshipInTx(
    tx: DatabaseTransaction,
    userAId: number,
    userBId: number,
  ): Promise<number> {
    const [thread] = await tx
      .insert(messageThread)
      .values({ type: MessageThreadType.P2P, updatedAt: new Date() })
      .returning({ id: messageThread.id });
    await tx.insert(threadParticipant).values([
      { userId: userAId, threadId: thread.id, updatedAt: new Date() },
      { userId: userBId, threadId: thread.id, updatedAt: new Date() },
    ]);
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
      .select({ id: invite.id })
      .from(invite)
      .innerJoin(messageThread, eq(messageThread.id, invite.threadId))
      .innerJoin(user, eq(user.id, messageThread.groupUserId))
      .where(
        and(
          eq(invite.toUserId, callerId),
          eq(invite.kind, InviteKind.GROUP),
          pendingOnly ? eq(invite.status, InviteStatus.PENDING) : undefined,
          eq(user.account, normalizeAccount(groupAccount)),
          eq(user.isGroup, true),
        ),
      )
      .orderBy(desc(invite.createdAt))
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
