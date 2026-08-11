import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type Database,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  group,
  messageThread,
  threadAudience,
  threadParticipant,
  user,
} from '../database/schema.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
import {
  PendingThreadRevision,
  ThreadRevisionService,
} from '../thread-revision/thread-revision.service.js';
import { PeerStateFeedService } from '../federation/peer-state-feed.service.js';

/**
 * ThreadParticipant data layer.
 *
 * ThreadParticipant is the single source of truth for "who is in a conversation" and their per-user
 * state (read position, mute, role). It replaces both the participation half of UserMessageThread and
 * the whole GroupMember table. P2P and GROUP share it; role is null for P2P.
 *
 * GROUP access requires an active participant. P2P keeps a participant row readable after unfriend:
 * `leftAt` ends the friendship/write capability, while the retained row continues to authorize history.
 */
@Injectable()
export class ThreadParticipantService {
  constructor(
    private database: DatabaseService,
    private readonly threadRevisionService: ThreadRevisionService,
    private readonly stateFeed: PeerStateFeedService,
  ) {}

  /** The caller's participant row, regardless of leftAt. */
  findParticipant(userId: number, threadId: number) {
    return this.database.db.query.threadParticipant
      .findFirst({
        where: and(
          eq(threadParticipant.userId, userId),
          eq(threadParticipant.threadId, threadId),
        ),
      })
      .then((row) => row ?? null);
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
    return this.database.db.query.threadParticipant.findMany({
      where: and(
        eq(threadParticipant.threadId, threadId),
        isNull(threadParticipant.leftAt),
      ),
      columns: { userId: true, muted: true },
    });
  }

  /** Resolve a history-readable participant with the thread type. GROUP rows must still be active;
   *  P2P rows remain readable after unfriend so the old conversation can be opened without a composer. */
  async findActiveParticipantWithThread(userId: number, threadId: number) {
    const [row] = await this.database.db
      .select({
        participant: threadParticipant,
        threadType: messageThread.type,
        groupId: group.id,
        dissolvedAt: group.dissolvedAt,
      })
      .from(threadParticipant)
      .innerJoin(
        messageThread,
        eq(messageThread.id, threadParticipant.threadId),
      )
      .leftJoin(group, eq(group.groupUserId, messageThread.groupUserId))
      .where(
        and(
          eq(threadParticipant.userId, userId),
          eq(threadParticipant.threadId, threadId),
        ),
      )
      .limit(1);
    return row
      ? {
          ...row.participant,
          thread: {
            type: row.threadType,
            groupUser:
              row.groupId === null
                ? null
                : { group: { dissolvedAt: row.dissolvedAt } },
          },
        }
      : null;
  }

  /** Toggle mute for the caller's row. Idempotent (writing the same value is a no-op write). */
  setMuted(userId: number, threadId: number, muted: boolean) {
    return this.updateParticipant(userId, threadId, { muted });
  }

  /**
   * Toggle pin for the caller's row. Pinning stamps pinnedAt = now (most-recently-pinned-first ordering);
   * unpin clears both the flag and the timestamp. Idempotent at the row level — re-pinning an already
   * pinned thread refreshes pinnedAt so it jumps to the top of the pinned tier.
   */
  setPinned(userId: number, threadId: number, pinned: boolean) {
    return this.updateParticipant(
      userId,
      threadId,
      pinned
        ? { pinned: true, pinnedAt: new Date() }
        : { pinned: false, pinnedAt: null },
    );
  }

  /**
   * Per-user "clear chat history": snapshot the thread's current seq. query-messages then hides rows at
   * watermark FOR THIS USER ONLY — the peer's copy is untouched (WhatsApp "clear for me"). Stamping
   * (not deleting) keeps the Message rows intact for the peer and for any future un-clear, and keeps
   * lastReadSeq untouched so the unread badge doesn't regress.
   */
  async clearHistory(userId: number, threadId: number) {
    const thread = await this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { curSeq: true },
    });
    return this.updateParticipant(userId, threadId, {
      clearedSeq: thread?.curSeq ?? -1,
    });
  }

  /** Permanently hide a thread for one participant. The peer/member copies and Message rows are untouched. */
  async deleteThreadForUser(userId: number, threadId: number) {
    const thread = await this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { curSeq: true },
    });
    return this.updateParticipant(userId, threadId, {
      clearedSeq: thread?.curSeq ?? -1,
      pinned: false,
      pinnedAt: null,
    });
  }

  /** Set a per-user alias/remark for a conversation. An empty/whitespace string CLEARS it (null) so the
   *  real name shows again. The alias overrides peer.account (P2P) / group.name (GROUP) in the caller's
   *  view only. */
  setAlias(userId: number, threadId: number, alias: string | undefined) {
    const trimmed = alias?.trim();
    return this.updateParticipant(userId, threadId, {
      alias: trimmed && trimmed.length > 0 ? trimmed : null,
    });
  }

  /**
   * Active roster of a conversation with each member's profile (login name + display name +
   * avatar) and role — the data behind group/members. Ordered by join time; the controller sorts
   * by role for display. P2P threads have exactly two rows with role null.
   */
  getRoster(threadId: number) {
    return this.database.db.query.threadParticipant.findMany({
      where: and(
        eq(threadParticipant.threadId, threadId),
        isNull(threadParticipant.leftAt),
      ),
      with: { user: true },
      orderBy: asc(threadParticipant.joinedAt),
    });
  }

  /** Batch roster fetch for multiple threads (mixed; group by threadId at the call site). Used by the
   *  /group/members batch endpoint so the client can hydrate all group rosters in one request. */
  getRosters(threadIds: number[]) {
    if (threadIds.length === 0) return Promise.resolve([]);
    return this.database.db.query.threadParticipant.findMany({
      where: and(
        inArray(threadParticipant.threadId, threadIds),
        isNull(threadParticipant.leftAt),
      ),
      with: { user: true },
      orderBy: asc(threadParticipant.joinedAt),
    });
  }

  /**
   * Generic list query (used by the conversation-list endpoint). Generic over the args so that
   * selected relations are reflected in the returned payload type.
   */
  async queryParticipants(params: ParticipantQuery) {
    const threadId = params.where.threadId;
    const rows = await this.database.db.query.threadParticipant.findMany({
      where: and(
        eq(threadParticipant.userId, params.where.userId),
        params.where.leftAt === null
          ? isNull(threadParticipant.leftAt)
          : undefined,
        typeof threadId === 'number'
          ? eq(threadParticipant.threadId, threadId)
          : threadId
            ? inArray(threadParticipant.threadId, threadId.in)
            : undefined,
      ),
      with: { messageThread: true },
      orderBy: params.orderBy ? asc(threadParticipant.id) : undefined,
      limit: params.take,
    });
    return rows.map(({ messageThread, ...row }) => ({
      ...row,
      thread: messageThread,
    }));
  }

  /**
   * For each P2P thread id, the OTHER participant (the peer). Rows remain available after unfriend so
   * retained history can still render the peer identity. Used to hydrate peerUser on the
   * conversation list. Returns at most one peer per thread (P2P threads have exactly two participants).
   */
  findP2PPeers(threadIds: number[], notUserId: number) {
    if (threadIds.length === 0) return Promise.resolve([]);
    return this.database.db.query.threadParticipant.findMany({
      where: and(
        inArray(threadParticipant.threadId, threadIds),
        ne(threadParticipant.userId, notUserId),
      ),
    });
  }

  /** Add a member to a conversation (used by group create/join). */
  createParticipant(data: typeof threadParticipant.$inferInsert) {
    return this.database.db
      .insert(threadParticipant)
      .values({ ...data, updatedAt: data.updatedAt ?? new Date() })
      .returning()
      .then(([row]) => row);
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
  async findP2PThreadBetween(
    userX: number,
    userY: number,
  ): Promise<number | null> {
    const result = await this.database.db.execute<{ threadId: number }>(sql`
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

  /** Most recent retained P2P thread for a pair, including an already-ended relationship. Used only
   *  to make a repeated unfriend request idempotent and to apply a late `deleteData` choice. */
  async findLatestP2PThreadBetween(
    userX: number,
    userY: number,
  ): Promise<number | null> {
    const result = await this.database.db.execute<{ threadId: number }>(sql`
      SELECT mine."threadId"
      FROM "ThreadParticipant" mine
      JOIN "ThreadParticipant" peer ON peer."threadId" = mine."threadId"
      JOIN "MessageThread" thread ON thread.id = mine."threadId"
      WHERE mine."userId" = ${userX}
        AND peer."userId" = ${userY}
        AND thread.type = ${MessageThreadType.P2P}
      ORDER BY mine."threadId" DESC
      LIMIT 1
    `);
    return result.rows[0]?.threadId ?? null;
  }

  /**
   * End a P2P friendship: soft-leave BOTH active participants of the thread (leftAt=now). The thread
   * row + participants are kept (history); findP2PThreadBetween now returns null for the pair, and
   * re-friending mints a fresh thread. The unfriend is LOCAL-ONLY — no S2S notification (the peer
   * discovers the severed edge lazily via a 403 on its next pull, per the federation protocol).
   */
  async softLeaveP2PBoth(threadId: number): Promise<void> {
    await this.database.db
      .update(threadParticipant)
      .set({ leftAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          isNull(threadParticipant.leftAt),
        ),
      );
  }

  /** Atomically end both sides of a P2P relation and optionally clear the caller's history boundary. */
  async endP2P(
    threadId: number,
    callerUserId: number,
    deleteData: boolean,
    localPeerUserId?: number,
  ): Promise<{ transitioned: boolean; statePeers: string[] }> {
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
      const identities = await tx
        .select({
          id: threadParticipant.id,
          userId: user.id,
          account: user.account,
          domain: user.domain,
          relationshipRev: threadParticipant.relationshipRev,
        })
        .from(threadParticipant)
        .innerJoin(user, eq(user.id, threadParticipant.userId))
        .where(eq(threadParticipant.threadId, threadId));
      const mine = identities.find((row) => row.userId === callerUserId);
      const peer = identities.find((row) => row.userId !== callerUserId);
      if (mine && peer) {
        const low = Math.min(callerUserId, peer.userId);
        const high = Math.max(callerUserId, peer.userId);
        await tx.execute(sql`
          INSERT INTO "FriendPair" ("userLowId", "userHighId") VALUES (${low}, ${high})
          ON CONFLICT DO NOTHING
        `);
        await tx.execute(sql`
          SELECT 1 FROM "FriendPair" WHERE "userLowId" = ${low} AND "userHighId" = ${high}
          FOR UPDATE
        `);
      }
      // Message writes lock this same row while allocating seq. Taking the lock before mutation makes the
      // audience boundary an exact cut: prior writes commit before MAX(id), later writes wait and
      // receive ids outside the closed access epoch.
      await tx.execute(sql`
        SELECT id
        FROM "MessageThread"
        WHERE id = ${threadId}
        FOR UPDATE
      `);
      const callerHidden = await this.threadRevisionService.isThreadHiddenInTx(
        tx,
        callerUserId,
        threadId,
      );
      const peerHidden =
        localPeerUserId === undefined
          ? true
          : await this.threadRevisionService.isThreadHiddenInTx(
              tx,
              localPeerUserId,
              threadId,
            );
      const ended = await tx
        .update(threadParticipant)
        .set({ leftAt: now, updatedAt: now })
        .where(
          and(
            eq(threadParticipant.threadId, threadId),
            isNull(threadParticipant.leftAt),
          ),
        )
        .returning({ id: threadParticipant.id });
      const shouldDelete = deleteData && !callerHidden;
      if (shouldDelete) {
        await tx
          .update(threadParticipant)
          .set({
            clearedSeq: sql`(SELECT "curSeq" FROM "MessageThread" WHERE id = ${threadId})`,
            pinned: false,
            pinnedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(threadParticipant.userId, callerUserId),
              eq(threadParticipant.threadId, threadId),
            ),
          );
      }
      const transitioned = ended.length > 0;
      const statePeers: string[] = [];
      if (transitioned) {
        if (mine && peer) {
          const low = Math.min(callerUserId, peer.userId);
          const high = Math.max(callerUserId, peer.userId);
          const request = await tx.execute<{ revision: number }>(sql`
            INSERT INTO "FriendRequest" (
              "requesterUserId", "targetUserId", status, note, revision, "updatedAt"
            ) VALUES (${callerUserId}, ${peer.userId}, 'NOT_FRIEND', '', 1, CURRENT_TIMESTAMP)
            ON CONFLICT ("requesterUserId", "targetUserId") DO UPDATE SET
              status = 'NOT_FRIEND', note = '', revision = "FriendRequest".revision + 1,
              "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "FriendRequest".status <> 'NOT_FRIEND'
            RETURNING revision
          `);
          const relationshipRev = request.rows[0]?.revision;
          await tx.execute(sql`
            UPDATE "FriendPair" SET active = false, revision = revision + 1,
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "userLowId" = ${low} AND "userHighId" = ${high} AND active = true
          `);
          await tx
            .update(threadParticipant)
            .set({
              recognizesFriend: false,
              ...(relationshipRev === undefined ? {} : { relationshipRev }),
              updatedAt: now,
            })
            .where(eq(threadParticipant.id, mine.id));
          if (relationshipRev !== undefined && peer.domain !== 'local') {
            await this.stateFeed.writeManyInTx(tx, [
              {
                peerDomain: peer.domain,
                account: mine.account,
                subjectAccount: peer.account,
                eventType: 'P2P_META',
                revision: relationshipRev,
                body: {
                  status: 'NOT_FRIEND',
                  note: '',
                  requestedAt: null,
                  expiresAt: null,
                },
              },
            ]);
            statePeers.push(peer.domain);
          }
        }
      }
      if (transitioned) {
        // Keep the row as a closed audience sentinel; federation epoch triggers capture the durable
        // MessageThread.curSeq boundary independently of this legacy-named field.
        await tx.execute(sql`
          UPDATE "ThreadAudience" audience
          SET "deliverThroughChangeId" = 0
          WHERE audience."threadId" = ${threadId}
            AND audience."deliverThroughChangeId" IS NULL
        `);
      }
      const revisions: PendingThreadRevision[] = [];
      if (shouldDelete) {
        revisions.push({
          userId: callerUserId,
          revision: await this.threadRevisionService.recordThreadDeleteInTx(
            tx,
            callerUserId,
            threadId,
          ),
        });
      } else if (transitioned && !callerHidden) {
        revisions.push({
          userId: callerUserId,
          revision: await this.threadRevisionService.recordThreadAddInTx(
            tx,
            callerUserId,
            threadId,
          ),
        });
      }
      if (transitioned && localPeerUserId !== undefined && !peerHidden) {
        revisions.push({
          userId: localPeerUserId,
          revision: await this.threadRevisionService.recordThreadAddInTx(
            tx,
            localPeerUserId,
            threadId,
          ),
        });
      }
      return { transitioned, revisions, statePeers };
    });
    result.revisions.forEach((revision) =>
      this.threadRevisionService.notifyThreadRevision(revision),
    );
    return { transitioned: result.transitioned, statePeers: result.statePeers };
  }

  // ─── raw roster mutators (federation inbound) ─────────────────────────────────
  // These bypass the local authority checks: the ORIGIN already authorized the op (signer ==
  // originDomain), so a mirror applies it verbatim. Used by FederationService handleGroupAccept (origin
  // adds the accepter) + handleThreadMember (mirror applies a join/leave/kick/role fanout).

  /** Add a member, or reactivate + re-role a previously-left row. Idempotent if already active at that
   *  role. Takes a tx-or-client so a caller's transaction (e.g. InviteService.acceptInvite) can include
   *  the member add atomically — the single implementation shared with the non-tx callers. */
  async upsertMemberInTx(
    tx: Database | DatabaseTransaction,
    threadId: number,
    userId: number,
    role: GroupRole,
  ): Promise<void> {
    const [existing] = await tx
      .select()
      .from(threadParticipant)
      .where(
        and(
          eq(threadParticipant.userId, userId),
          eq(threadParticipant.threadId, threadId),
        ),
      )
      .limit(1);
    if (!existing) {
      await tx.insert(threadParticipant).values({
        userId,
        threadId,
        role,
        updatedAt: new Date(),
      });
      return;
    }
    if (existing.leftAt !== null || existing.role !== role) {
      await tx
        .update(threadParticipant)
        .set({ leftAt: null, role, updatedAt: new Date() })
        .where(eq(threadParticipant.id, existing.id));
    }
  }

  /** Non-tx convenience wrapper around {@link upsertMemberInTx} (uses the shared pool client). */
  upsertMember(
    threadId: number,
    userId: number,
    role: GroupRole,
  ): Promise<void> {
    return this.upsertMemberInTx(this.database.db, threadId, userId, role);
  }

  /** Soft-leave a single member (set leftAt). No-op if already left / not a member. */
  async softLeaveMember(threadId: number, userId: number): Promise<void> {
    await this.database.db
      .update(threadParticipant)
      .set({ leftAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          eq(threadParticipant.userId, userId),
          isNull(threadParticipant.leftAt),
        ),
      );
  }

  /** Set a member's role (raw — the origin authorized it). */
  async setMemberRole(
    threadId: number,
    userId: number,
    role: GroupRole,
  ): Promise<void> {
    await this.database.db
      .update(threadParticipant)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          eq(threadParticipant.userId, userId),
        ),
      );
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
    const result = await this.database.db.execute<{ userId: number }>(sql`
      SELECT DISTINCT peer."userId"
      FROM "ThreadParticipant" mine
      JOIN "ThreadParticipant" peer ON peer."threadId" = mine."threadId"
      JOIN "MessageThread" thread ON thread.id = mine."threadId"
      WHERE mine."userId" = ${userId}
        AND peer."userId" <> ${userId}
        AND mine."leftAt" IS NULL
        AND peer."leftAt" IS NULL
        AND thread.type = ${MessageThreadType.P2P}
    `);
    return result.rows.map((row) => row.userId);
  }

  private updateParticipant(
    userId: number,
    threadId: number,
    data: Partial<typeof threadParticipant.$inferInsert>,
  ) {
    return this.database.db
      .update(threadParticipant)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(threadParticipant.userId, userId),
          eq(threadParticipant.threadId, threadId),
        ),
      )
      .returning()
      .then(([row]) => row);
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
}

type ParticipantQuery = {
  where: {
    userId: number;
    leftAt?: null;
    threadId?: number | { in: number[] };
  };
  include?: { thread: true };
  orderBy?: { id: 'asc' };
  take?: number;
};
