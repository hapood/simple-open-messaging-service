import { Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type Database,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  group,
  messageThread,
  threadParticipant,
  user,
} from '../database/schema.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
import { PeerStateFeedService } from '../federation/peer-state-feed.service.js';
import { closeFederatedAudienceInTx } from '../federation/federation-audience.js';
import {
  isThreadMutuallyAuthorized,
  mutuallyAuthorizedSql,
} from '../invite/relationship-authorization.js';
import { MessageService, type Message } from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';

/**
 * ThreadParticipant data layer.
 *
 * ThreadParticipant retains conversation linkage and per-user settings (read position, mute, role).
 * It replaces both the participation half of UserMessageThread and
 * the whole GroupMember table. P2P and GROUP share it; role is null for P2P.
 *
 * Current authority is derived exclusively from the two directed RelationshipIntent facts. Rows may
 * remain after revocation so clients can retain conversation history without treating them as authority.
 */
@Injectable()
export class ThreadParticipantService {
  constructor(
    private database: DatabaseService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    @Optional() private readonly messages?: MessageService,
  ) {}

  /** The caller's retained participant row, regardless of current relationship authorization. */
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

  /** The caller's participant row when both relationship directions currently authorize the thread. */
  async findActiveParticipant(userId: number, threadId: number) {
    const p = await this.findParticipant(userId, threadId);
    return p && (await this.isMutuallyAuthorized(userId, threadId)) ? p : null;
  }

  isMutuallyAuthorized(userId: number, threadId: number) {
    return isThreadMutuallyAuthorized(this.database.db, userId, threadId);
  }

  /** Active member userIds of a conversation — the SSE fan-out set (P2P and GROUP alike).
   *  Carries `muted` so the send path can drop notifications / push / notif-snapshot for muted
   *  recipients (the in-app bubble still renders via their own SSE pull — mute is a notification
   *  concern, not a delivery concern). */
  async getActiveParticipantUserIds(threadId: number) {
    const rows = await this.database.db.query.threadParticipant.findMany({
      where: eq(threadParticipant.threadId, threadId),
      columns: { userId: true, muted: true, blocked: true },
    });
    const authorized = await Promise.all(
      rows.map((row) => this.isMutuallyAuthorized(row.userId, threadId)),
    );
    return rows.filter((_, index) => authorized[index]);
  }

  /** Delivery settings for a transactionally captured local recipient set. No current-authorization
   *  filter: boundary SYSTEM messages deliberately wake the participant whose relationship just closed. */
  getParticipantDeliverySettings(threadId: number, userIds: readonly number[]) {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.database.db.query.threadParticipant.findMany({
      where: and(
        eq(threadParticipant.threadId, threadId),
        inArray(threadParticipant.userId, [...userIds]),
      ),
      columns: { userId: true, muted: true, blocked: true },
    });
  }

  /** Resolve a retained participant with the thread type. */
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

  /** Thread-scoped delivery block. Works for both P2P and groups without changing membership/history. */
  async setBlocked(userId: number, threadId: number, blocked: boolean) {
    const pending = await this.database.db.transaction(async (tx) => {
      const [participant] = await tx
        .update(threadParticipant)
        .set({ blocked, updatedAt: new Date() })
        .where(
          and(
            eq(threadParticipant.userId, userId),
            eq(threadParticipant.threadId, threadId),
          ),
        )
        .returning({ userId: threadParticipant.userId });
      if (!participant) throw new Error('thread participant is missing');
      const feedId = await this.clientStateFeed.writeInTx(tx, {
        userId,
        account: '',
        domain: 'local',
        eventType: 'THREAD_BLOCK',
        subjectAccount: threadId.toString(),
        subjectDomain: 'local',
        body: { threadId, blocked },
      });
      return feedId === null ? null : { userId, feedId };
    });
    if (pending) this.clientStateFeed.notifyFeedUpdated(pending);
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
      clearedSeq: thread?.curSeq ?? 0,
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

  /** Active roster used to build authoritative group conversation snapshots. */
  async getRoster(threadId: number) {
    const rows = await this.database.db.query.threadParticipant.findMany({
      where: eq(threadParticipant.threadId, threadId),
      with: { user: true },
      orderBy: asc(threadParticipant.joinedAt),
    });
    const authorized = await Promise.all(
      rows.map((row) => this.isMutuallyAuthorized(row.userId, threadId)),
    );
    return rows.filter((_, index) => authorized[index]);
  }

  /** Batch roster fetch used while hydrating conversation snapshots. */
  async getRosters(threadIds: number[]) {
    if (threadIds.length === 0) return Promise.resolve([]);
    const rows = await this.database.db.query.threadParticipant.findMany({
      where: inArray(threadParticipant.threadId, threadIds),
      with: { user: true },
      orderBy: asc(threadParticipant.joinedAt),
    });
    const authorized = await Promise.all(
      rows.map((row) => this.isMutuallyAuthorized(row.userId, row.threadId)),
    );
    return rows.filter((_, index) => authorized[index]);
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
   * The currently mutually authorized P2P thread two users share, or null.
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
        AND ${mutuallyAuthorizedSql(userX, userY)}
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

  /** Participant rows are retained; revocation is represented only by RelationshipIntent. */
  async softLeaveP2PBoth(threadId: number): Promise<void> {
    void threadId;
  }

  /** Atomically end both sides of a P2P relation and optionally clear the caller's history boundary. */
  async endP2P(
    threadId: number,
    callerUserId: number,
    deleteData: boolean,
  ): Promise<{
    transitioned: boolean;
    statePeers: string[];
    systemMessage: Omit<Message, 'id'> | null;
    localRecipientIds: number[];
  }> {
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
          INSERT INTO "RelationshipPair" ("userLowId", "userHighId") VALUES (${low}, ${high})
          ON CONFLICT DO NOTHING
        `);
        await tx.execute(sql`
          SELECT 1 FROM "RelationshipPair" WHERE "userLowId" = ${low} AND "userHighId" = ${high}
          FOR UPDATE
        `);
      }
      // This is the relationship-write gate, not a feed/audience lock. Message creation already
      // updates this row to allocate seq and re-checks participant access afterwards. Holding it here
      // makes an earlier authorized send finish first and a later send observe the closed participant.
      await tx.execute(sql`
        SELECT id FROM "MessageThread" WHERE id = ${threadId} FOR UPDATE
      `);
      const outgoing = peer
        ? await tx.execute<{ status: string }>(sql`
            SELECT status
            FROM "RelationshipIntent"
            WHERE "authorUserId" = ${callerUserId}
              AND "subjectUserId" = ${peer.userId}
          `)
        : { rows: [] };
      // Idempotency belongs to the direction authored by the caller. The reverse direction may already
      // be revoked (and therefore make the pair mutually unauthorized) without this caller having
      // performed its own terminal transition yet.
      const transitioned = outgoing.rows[0]?.status !== 'REVOKED';
      const shouldDelete = deleteData;
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
      const statePeers: string[] = [];
      let systemMessage: Omit<Message, 'id'> | null = null;
      const localRecipientIds = identities
        .filter((identity) => identity.domain === 'local')
        .map((identity) => identity.userId);
      if (transitioned) {
        if (this.messages) {
          systemMessage = (
            await this.messages.writeSystemMessageInTx(
              tx,
              threadId,
              SystemMessageType.FRIEND_REMOVED,
              peer?.userId,
              {
                actorUserId: callerUserId,
                recipientUserIds: localRecipientIds,
                markReadUserId: callerUserId,
              },
            )
          ).message;
          await tx
            .update(threadParticipant)
            .set({
              messageVisibleBeforeSeq: systemMessage.seq + 1,
              updatedAt: now,
            })
            .where(eq(threadParticipant.threadId, threadId));
        }
        // Remote discovery authorization ends immediately; local thread visibility remains.
        await tx.execute(sql`
          DELETE FROM "ThreadAudience" audience
          WHERE audience."threadId" = ${threadId}
            AND audience."targetDomain" = 'local'
        `);
        if (peer?.domain && peer.domain !== 'local') {
          await closeFederatedAudienceInTx(tx, peer.domain, threadId);
        }
      }
      if (transitioned) {
        if (mine && peer) {
          const low = Math.min(callerUserId, peer.userId);
          const high = Math.max(callerUserId, peer.userId);
          const localPair = peer.domain === 'local';
          const request = await tx.execute(sql`
            INSERT INTO "RelationshipIntent" (
              "authorUserId", "subjectUserId", status, note,
              "requestedAt", "expiresAt", "updatedAt"
            ) VALUES (${callerUserId}, ${peer.userId}, 'REVOKED', '', NULL, NULL,
              CURRENT_TIMESTAMP)
            ON CONFLICT ("authorUserId", "subjectUserId") DO UPDATE SET
              status = 'REVOKED', note = '', "requestedAt" = NULL,
              "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "RelationshipIntent".status <> 'REVOKED'
            RETURNING 1
          `);
          if (localPair) {
            await tx.execute(sql`
              INSERT INTO "RelationshipIntent" (
                "authorUserId", "subjectUserId", status, note,
                "requestedAt", "expiresAt", "updatedAt"
              ) VALUES (${peer.userId}, ${callerUserId}, 'REVOKED', '', NULL, NULL,
                CURRENT_TIMESTAMP)
              ON CONFLICT ("authorUserId", "subjectUserId") DO UPDATE SET
                status = 'REVOKED', note = '', "requestedAt" = NULL,
                "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
              WHERE "RelationshipIntent".status <> 'REVOKED'
            `);
          }
          const pair = await tx.execute<{ revision: number }>(sql`
            UPDATE "RelationshipPair" SET active = false, revision = revision + 1,
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "userLowId" = ${low} AND "userHighId" = ${high} AND active = true
            RETURNING revision
          `);
          const relationshipRev = pair.rows[0]?.revision;
          await tx
            .update(threadParticipant)
            .set({
              ...(relationshipRev === undefined ? {} : { relationshipRev }),
              updatedAt: now,
            })
            .where(
              localPair
                ? eq(threadParticipant.threadId, threadId)
                : eq(threadParticipant.id, mine.id),
            );
          if ((request.rowCount ?? 0) > 0 && peer.domain !== 'local') {
            const localDomain = process.env.SOMS_DOMAIN;
            if (!localDomain)
              throw new Error('SOMS_DOMAIN is required for federation state');
            await this.stateFeed.writeManyInTx(tx, [
              {
                peerDomain: peer.domain,
                account: mine.account,
                domain: localDomain,
                subjectAccount: peer.account,
                subjectDomain: peer.domain,
                eventType: 'RELATIONSHIP_INTENT',
                body: {
                  status: 'REVOKED',
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
      return {
        transitioned,
        statePeers,
        systemMessage,
        localRecipientIds,
      };
    });
    return result;
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
    if (existing.role !== role || existing.messageVisibleBeforeSeq !== null) {
      await tx
        .update(threadParticipant)
        .set({
          role,
          messageVisibleBeforeSeq: null,
          updatedAt: new Date(),
        })
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

  /** Retain a former group member's visible history in the revoked state. */
  async softLeaveMember(threadId: number, userId: number): Promise<void> {
    void threadId;
    void userId;
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
   * Blocking does not unfriend or remove the retained participant row, so
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
        AND ${mutuallyAuthorizedSql(sql`mine."userId"`, sql`peer."userId"`)}
        AND thread.type = ${MessageThreadType.P2P}
    `);
    return result.rows.map((row) => row.userId);
  }

  private async updateParticipant(
    userId: number,
    threadId: number,
    data: Partial<typeof threadParticipant.$inferInsert>,
  ) {
    const [row] = await this.database.db
      .update(threadParticipant)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(threadParticipant.userId, userId),
          eq(threadParticipant.threadId, threadId),
        ),
      )
      .returning();
    return row;
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
    active?: true;
    threadId?: number | { in: number[] };
  };
  include?: { thread: true };
  orderBy?: { id: 'asc' };
  take?: number;
};
