import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { GroupRole, MessageThreadType, Prisma } from '../prisma/generated/client.js';

/**
 * ThreadParticipant data layer.
 *
 * ThreadParticipant is the single source of truth for "who is in a conversation" and their per-user
 * state (read position, mute, role). It replaces both the participation half of UserMessageThread and
 * the whole GroupMember table. P2P and GROUP share it; role is null for P2P.
 *
 * Authorization invariant used across the app: a user may interact with a conversation iff they have an
 * ACTIVE participant row (leftAt IS NULL) on that thread — one check for both P2P and GROUP.
 */
@Injectable()
export class ThreadParticipantService {
  constructor(private prisma: PrismaService) {}

  /** The caller's participant row, regardless of leftAt. */
  findParticipant(userId: number, threadId: number) {
    return this.prisma.threadParticipant.findUnique({
      where: { userId_threadId: { userId, threadId } },
    });
  }

  /** The caller's participant row only if still active (not left). Null otherwise. */
  async findActiveParticipant(userId: number, threadId: number) {
    const p = await this.findParticipant(userId, threadId);
    return p && p.leftAt === null ? p : null;
  }

  /** Active member userIds of a conversation — the SSE fan-out set (P2P and GROUP alike).
   *  Carries `muted` so the send path can drop notifications / push / notif-snapshot for muted
   *  recipients (the in-app bubble still renders via their own SSE pull — mute is a notification
   *  concern, not a delivery concern). */
  getActiveParticipantUserIds(threadId: number) {
    return this.prisma.threadParticipant.findMany({
      where: { threadId, leftAt: null },
      select: { userId: true, muted: true },
    });
  }

  /** The caller's participant row with the thread's type, only if still active. Used by ThreadAccessGuard
   *  to attach `threadType` so message routes can branch on P2P vs GROUP (e.g. block-filter scoping). */
  async findActiveParticipantWithThread(userId: number, threadId: number) {
    const p = await this.prisma.threadParticipant.findUnique({
      where: { userId_threadId: { userId, threadId } },
      include: { thread: { select: { type: true } } },
    });
    return p && p.leftAt === null ? p : null;
  }

  /** Toggle mute for the caller's row. Idempotent (writing the same value is a no-op write). */
  setMuted(userId: number, threadId: number, muted: boolean) {
    return this.prisma.threadParticipant.update({
      where: { userId_threadId: { userId, threadId } },
      data: { muted },
    });
  }

  /**
   * Toggle pin for the caller's row. Pinning stamps pinnedAt = now (most-recently-pinned-first ordering);
   * unpin clears both the flag and the timestamp. Idempotent at the row level — re-pinning an already
   * pinned thread refreshes pinnedAt so it jumps to the top of the pinned tier.
   */
  setPinned(userId: number, threadId: number, pinned: boolean) {
    return this.prisma.threadParticipant.update({
      where: { userId_threadId: { userId, threadId } },
      data: pinned ? { pinned: true, pinnedAt: new Date() } : { pinned: false, pinnedAt: null },
    });
  }

  /**
   * Per-user "clear chat history": stamp clearedAt = now. query-messages then hides rows older than this
   * watermark FOR THIS USER ONLY — the peer's copy is untouched (WhatsApp "clear for me"). Stamping
   * (not deleting) keeps the Message rows intact for the peer and for any future un-clear, and keeps
   * lastReadSeq untouched so the unread badge doesn't regress.
   */
  clearHistory(userId: number, threadId: number) {
    return this.prisma.threadParticipant.update({
      where: { userId_threadId: { userId, threadId } },
      data: { clearedAt: new Date() },
    });
  }

  /** Set a per-user alias/remark for a conversation. An empty/whitespace string CLEARS it (null) so the
   *  real name shows again. The alias overrides peer.account (P2P) / group.name (GROUP) in the caller's
   *  view only. */
  setAlias(userId: number, threadId: number, alias: string | undefined) {
    const trimmed = alias?.trim();
    return this.prisma.threadParticipant.update({
      where: { userId_threadId: { userId, threadId } },
      data: { alias: trimmed && trimmed.length > 0 ? trimmed : null },
    });
  }

  /**
   * Active roster of a conversation with each member's profile (login name + display name +
   * avatar) and role — the data behind group/members. Ordered by join time; the controller sorts
   * by role for display. P2P threads have exactly two rows with role null.
   */
  getRoster(threadId: number) {
    return this.prisma.threadParticipant.findMany({
      where: { threadId, leftAt: null },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    });
  }

  /** Batch roster fetch for multiple threads (mixed; group by threadId at the call site). Used by the
   *  /group/members batch endpoint so the client can hydrate all group rosters in one request. */
  getRosters(threadIds: number[]) {
    return this.prisma.threadParticipant.findMany({
      where: { threadId: { in: threadIds }, leftAt: null },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    });
  }

  /**
   * Generic list query (used by the conversation-list endpoint). Generic over the args so that
   * `include`/`select` are reflected in the returned payload type — Prisma can't infer includes
   * passed through a plain `FindManyArgs`-typed variable.
   */
  queryParticipants<T extends Prisma.ThreadParticipantFindManyArgs>(
    params: T,
  ): Promise<Prisma.ThreadParticipantGetPayload<T>[]> {
    // Cast: findMany's generic return narrows to the default payload, but callers passing `include` need the included
    // fields typed (e.g. `thread`). GetPayload<T> models exactly that.
    return this.prisma.threadParticipant.findMany(params) as unknown as Promise<
      Prisma.ThreadParticipantGetPayload<T>[]
    >;
  }

  /**
   * For each P2P thread id, the OTHER active participant (the peer). Used to hydrate peerUser on the
   * conversation list. Returns at most one peer per thread (P2P threads have exactly two participants).
   */
  findP2PPeers(threadIds: number[], notUserId: number) {
    return this.prisma.threadParticipant.findMany({
      where: {
        threadId: { in: threadIds },
        leftAt: null,
        userId: { not: notUserId },
      },
    });
  }

  /** Add a member to a conversation (used by group create/join). */
  createParticipant(data: Prisma.ThreadParticipantCreateInput) {
    return this.prisma.threadParticipant.create({ data });
  }

  /**
   * The id of the ACTIVE P2P thread two users share, or null. With the Friendship table gone, "are A
   * and B friends" is exactly "do they share an active (leftAt IS NULL on BOTH sides) P2P thread".
   *
   * Critical: BOTH participant rows must be active. `deleteFriend` soft-leaves both rows (leftAt=now)
   * but keeps the thread, and re-friending mints a NEW thread — so two P2P threads can exist between a
   * pair (the stale soft-left one + the new active one). Filtering leftAt:null on both sides selects
   * only the live edge. This is the S2S message/file serving authz gate after unfriend.
   */
  async findP2PThreadBetween(userX: number, userY: number): Promise<number | null> {
    const mine = await this.prisma.threadParticipant.findMany({
      where: { userId: userX, leftAt: null, thread: { type: MessageThreadType.P2P } },
      select: { threadId: true },
    });
    if (mine.length === 0) return null;
    const peer = await this.prisma.threadParticipant.findFirst({
      where: {
        userId: userY,
        leftAt: null,
        threadId: { in: mine.map((m) => m.threadId) },
      },
      select: { threadId: true },
    });
    return peer?.threadId ?? null;
  }

  /**
   * End a P2P friendship: soft-leave BOTH active participants of the thread (leftAt=now). The thread
   * row + participants are kept (history); findP2PThreadBetween now returns null for the pair, and
   * re-friending mints a fresh thread. The unfriend is LOCAL-ONLY — no S2S notification (the peer
   * discovers the severed edge lazily via a 403 on its next pull, per the federation protocol).
   */
  async softLeaveP2PBoth(threadId: number): Promise<void> {
    await this.prisma.threadParticipant.updateMany({
      where: { threadId, leftAt: null },
      data: { leftAt: new Date() },
    });
  }

  // ─── raw roster mutators (federation inbound) ─────────────────────────────────
  // These bypass the local authority checks: the ORIGIN already authorized the op (signer ==
  // originDomain), so a mirror applies it verbatim. Used by FederationService handleGroupAccept (origin
  // adds the accepter) + handleThreadMember (mirror applies a join/leave/kick/role fanout).

  /** Add a member, or reactivate + re-role a previously-left row. Idempotent if already active at that
   *  role. Takes a tx-or-client so a caller's transaction (e.g. InviteService.acceptInvite) can include
   *  the member add atomically — the single implementation shared with the non-tx callers. */
  async upsertMemberInTx(
    tx: Prisma.TransactionClient,
    threadId: number,
    userId: number,
    role: GroupRole,
  ): Promise<void> {
    const existing = await tx.threadParticipant.findUnique({
      where: { userId_threadId: { userId, threadId } },
    });
    if (existing === null) {
      await tx.threadParticipant.create({ data: { userId, threadId, role } });
      return;
    }
    if (existing.leftAt !== null || existing.role !== role) {
      await tx.threadParticipant.update({
        where: { id: existing.id },
        data: { leftAt: null, role },
      });
    }
  }

  /** Non-tx convenience wrapper around {@link upsertMemberInTx} (uses the shared pool client). */
  upsertMember(threadId: number, userId: number, role: GroupRole): Promise<void> {
    return this.upsertMemberInTx(this.prisma, threadId, userId, role);
  }

  /** Soft-leave a single member (set leftAt). No-op if already left / not a member. */
  async softLeaveMember(threadId: number, userId: number): Promise<void> {
    await this.prisma.threadParticipant.updateMany({
      where: { threadId, userId, leftAt: null },
      data: { leftAt: new Date() },
    });
  }

  /** Set a member's role (raw — the origin authorized it). */
  async setMemberRole(threadId: number, userId: number, role: GroupRole): Promise<void> {
    await this.prisma.threadParticipant.updateMany({
      where: { threadId, userId },
      data: { role },
    });
  }

  /** Whether two users currently share an active P2P thread (i.e. are friends). */
  async areFriends(userX: number, userY: number): Promise<boolean> {
    return (await this.findP2PThreadBetween(userX, userY)) !== null;
  }

  /**
   * All userIds sharing an ACTIVE P2P thread with `userId` — the friend set, now derived from thread
   * membership (replaces FriendshipService.getApprovedPeerUserIds). Used by profile-update fan-out.
   * Blocking does NOT unfriend (block lives in UserBlock, independent of thread membership), so
   * blocked peers are still returned — a profile refresh is harmless and the conversation list still
   * shows them, mirroring the previous behavior.
   */
  async getActiveP2PPeerUserIds(userId: number): Promise<number[]> {
    const mine = await this.prisma.threadParticipant.findMany({
      where: { userId, leftAt: null, thread: { type: MessageThreadType.P2P } },
      select: { threadId: true },
    });
    if (mine.length === 0) return [];
    const peers = await this.prisma.threadParticipant.findMany({
      where: {
        threadId: { in: mine.map((m) => m.threadId) },
        leftAt: null,
        userId: { not: userId },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return peers.map((p) => p.userId);
  }

  /**
   * Advance the caller's read watermark for a conversation, but only forward (monotonic): a stale
   * mark-read for an older message (e.g. an out-of-order retry, or marking read on an older message
   * after newer ones arrived) never regresses the cursor. Returns whether the cursor actually moved,
   * so the controller can tell "already read up to here" from a genuine update.
   *
   * Implemented as a single conditional updateMany so monotonicity is a DB-level guarantee under
   * concurrency — two racing mark-reads (e.g. from two tabs) can no longer both observe a stale
   * cursor and let the later write regress it. The WHERE clause matches only when the new id is
   * strictly greater than the current watermark (or the watermark is NULL); count>0 means it moved.
   */
  async advanceReadCursor(
    userId: number,
    threadId: number,
    lastReadSeq: number,
  ): Promise<boolean> {
    const result = await this.prisma.threadParticipant.updateMany({
      where: {
        userId,
        threadId,
        OR: [{ lastReadSeq: null }, { lastReadSeq: { lt: lastReadSeq } }],
      },
      data: { lastReadSeq },
    });
    return result.count > 0;
  }
}
