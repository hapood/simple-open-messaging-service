import { Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  group,
  messageThread,
  threadMember,
  threadParticipant,
  user,
} from '../database/schema.js';
import { MessageThreadType } from '../database/enums.js';
import { PeerStateFeedService } from '../federation/peer-state-feed.service.js';
import { closeFederatedAudienceInTx } from '../federation/federation-audience.js';
import {
  isThreadMutuallyAuthorized,
  mutuallyAuthorizedSql,
} from '../invite/relationship-authorization.js';
import {
  MessageService,
  type PublicMessage,
} from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
/** ThreadMember is the source-scoped roster projection. ThreadParticipant independently owns local
 * Account conversation state and role facts; neither table is an authorization source. */
@Injectable()
export class ThreadParticipantService {
  constructor(
    private database: DatabaseService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    @Optional() private readonly messages?: MessageService,
  ) {}

  async findParticipant(userId: number, threadId: number) {
    const [participant] = await this.database.db
      .select()
      .from(threadParticipant)
      .where(
        and(
          eq(threadParticipant.accountId, userId),
          eq(threadParticipant.threadId, threadId),
        ),
      )
      .limit(1);
    return participant ?? null;
  }

  async findActiveParticipant(userId: number, threadId: number) {
    const participant = await this.findParticipant(userId, threadId);
    return participant && (await this.isMutuallyAuthorized(userId, threadId))
      ? participant
      : null;
  }

  isMutuallyAuthorized(userId: number, threadId: number) {
    return isThreadMutuallyAuthorized(this.database.db, userId, threadId);
  }

  async getActiveParticipantUserIds(threadId: number) {
    const rows = await this.database.db
      .select({
        userId: threadParticipant.accountId,
        muted: threadParticipant.muted,
        blocked: threadParticipant.blocked,
        account: user.account,
        domain: user.domain,
      })
      .from(threadParticipant)
      .innerJoin(user, eq(user.id, threadParticipant.accountId))
      .where(eq(threadParticipant.threadId, threadId));
    const authorized = await Promise.all(
      rows.map((row) => this.isMutuallyAuthorized(row.userId, threadId)),
    );
    return rows.filter((_, index) => authorized[index]);
  }

  async getParticipantDeliverySettings(
    threadId: number,
    userIds: readonly number[],
  ) {
    if (userIds.length === 0) return [];
    return this.database.db
      .select({
        userId: threadParticipant.accountId,
        muted: threadParticipant.muted,
        blocked: threadParticipant.blocked,
        account: user.account,
        domain: user.domain,
      })
      .from(threadParticipant)
      .innerJoin(user, eq(user.id, threadParticipant.accountId))
      .where(
        and(
          eq(threadParticipant.threadId, threadId),
          inArray(threadParticipant.accountId, [...userIds]),
        ),
      );
  }

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
      .leftJoin(group, eq(group.id, messageThread.groupId))
      .where(
        and(
          eq(threadParticipant.accountId, userId),
          eq(threadParticipant.threadId, threadId),
        ),
      )
      .limit(1);
    return row
      ? {
          ...row.participant,
          thread: {
            type: row.threadType,
            group:
              row.groupId === null ? null : { dissolvedAt: row.dissolvedAt },
          },
        }
      : null;
  }

  setMuted(userId: number, threadId: number, muted: boolean) {
    return this.updateParticipant(userId, threadId, { muted });
  }

  async setBlocked(userId: number, threadId: number, blocked: boolean) {
    const pending = await this.database.db.transaction(async (tx) => {
      const [participant] = await tx
        .update(threadParticipant)
        .set({ blocked, updatedAt: new Date() })
        .where(
          and(
            eq(threadParticipant.accountId, userId),
            eq(threadParticipant.threadId, threadId),
          ),
        )
        .returning({ id: threadParticipant.id });
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

  setPinned(userId: number, threadId: number, pinned: boolean) {
    return this.updateParticipant(
      userId,
      threadId,
      pinned
        ? { pinned: true, pinnedAt: new Date() }
        : { pinned: false, pinnedAt: null },
    );
  }

  async clearHistory(userId: number, threadId: number) {
    const thread = await this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, threadId),
      columns: { curSeq: true },
    });
    return this.updateParticipant(userId, threadId, {
      clearedSeq: thread?.curSeq ?? 0,
    });
  }

  setAlias(userId: number, threadId: number, alias: string | undefined) {
    const trimmed = alias?.trim();
    return this.updateParticipant(userId, threadId, {
      alias: trimmed && trimmed.length > 0 ? trimmed : null,
    });
  }

  async queryParticipants(params: ParticipantQuery) {
    const threadId = params.where.threadId;
    const rows = await this.database.db
      .select({
        participant: threadParticipant,
        thread: messageThread,
      })
      .from(threadParticipant)
      .innerJoin(
        messageThread,
        eq(messageThread.id, threadParticipant.threadId),
      )
      .where(
        and(
          eq(threadParticipant.accountId, params.where.userId),
          typeof threadId === 'number'
            ? eq(threadParticipant.threadId, threadId)
            : threadId
              ? inArray(threadParticipant.threadId, threadId.in)
              : undefined,
        ),
      )
      .orderBy(asc(threadParticipant.id))
      .limit(params.take ?? 1000);
    return rows.map((row) => ({
      ...row.participant,
      thread: row.thread,
    }));
  }

  async findP2PPeers(threadIds: number[], notUserId: number) {
    if (threadIds.length === 0) return [];
    const rows = await this.database.db
      .select({
        member: threadMember,
        identity: user,
      })
      .from(threadMember)
      .innerJoin(user, eq(user.id, threadMember.userId))
      .where(
        and(
          inArray(threadMember.threadId, threadIds),
          ne(threadMember.userId, notUserId),
        ),
      );
    return rows.map((row) => ({
      ...row.member,
      user: row.identity,
      account: row.identity.account,
      domain: row.identity.domain,
    }));
  }

  async findP2PThreadBetween(userX: number, userY: number) {
    const result = await this.database.db.execute<{ threadId: number }>(sql`
      SELECT mine."threadId"
      FROM "ThreadMember" mine
      JOIN "ThreadMember" peer ON peer."threadId" = mine."threadId"
      JOIN "MessageThread" thread ON thread.id = mine."threadId"
      WHERE mine."userId" = ${userX} AND peer."userId" = ${userY}
        AND ${mutuallyAuthorizedSql(userX, userY)}
        AND thread.type = ${MessageThreadType.P2P}
      LIMIT 1
    `);
    return result.rows[0]?.threadId ?? null;
  }

  async findLatestP2PThreadBetween(userX: number, userY: number) {
    const result = await this.database.db.execute<{ threadId: number }>(sql`
      SELECT mine."threadId"
      FROM "ThreadMember" mine
      JOIN "ThreadMember" peer ON peer."threadId" = mine."threadId"
      JOIN "MessageThread" thread ON thread.id = mine."threadId"
      WHERE mine."userId" = ${userX} AND peer."userId" = ${userY}
        AND thread.type = ${MessageThreadType.P2P}
      ORDER BY mine."threadId" DESC LIMIT 1
    `);
    return result.rows[0]?.threadId ?? null;
  }

  async softLeaveP2PBoth(threadId: number): Promise<void> {
    void threadId;
  }

  async endP2P(
    threadId: number,
    callerUserId: number,
    deleteData: boolean,
  ): Promise<{
    transitioned: boolean;
    statePeers: string[];
    systemMessage: PublicMessage | null;
    localRecipientIds: number[];
  }> {
    const now = new Date();
    return this.database.db.transaction(async (tx) => {
      const identities = await tx
        .select({
          memberId: threadMember.id,
          userId: user.id,
          account: user.account,
          domain: user.domain,
        })
        .from(threadMember)
        .innerJoin(user, eq(user.id, threadMember.userId))
        .where(eq(threadMember.threadId, threadId));
      const mine = identities.find((row) => row.userId === callerUserId);
      const peer = identities.find((row) => row.userId !== callerUserId);
      if (!mine || !peer) throw new Error('P2P endpoints are missing');

      const endpointKey = (row: typeof mine) =>
        `USER\u0000${row.domain}\u0000${row.account}`;
      const callerSide = endpointKey(mine) < endpointKey(peer) ? 'A' : 'B';
      const peerSide = callerSide === 'A' ? 'B' : 'A';
      const pair = await tx.execute<{ id: bigint }>(sql`
        SELECT id FROM "RelationshipPair"
        WHERE "threadId" = ${threadId} AND kind = 'P2P' FOR UPDATE
      `);
      const pairId = pair.rows[0]?.id;
      if (pairId === undefined)
        throw new Error('P2P relationship pair is missing');
      await tx.execute(
        sql`SELECT id FROM "MessageThread" WHERE id = ${threadId} FOR UPDATE`,
      );
      const outgoing = await tx.execute<{ status: string }>(sql`
        SELECT status FROM "RelationshipIntent"
        WHERE "pairId" = ${pairId} AND "authorSide" = ${callerSide}
      `);
      const transitioned = outgoing.rows[0]?.status !== 'REVOKED';
      if (deleteData)
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
              eq(threadParticipant.accountId, callerUserId),
              eq(threadParticipant.threadId, threadId),
            ),
          );

      const localRecipientIds = identities
        .filter((identity) => identity.domain === 'local')
        .map((identity) => identity.userId);
      let systemMessage: PublicMessage | null = null;
      const statePeers: string[] = [];
      if (!transitioned)
        return { transitioned, statePeers, systemMessage, localRecipientIds };

      if (this.messages) {
        systemMessage = (
          await this.messages.writeSystemMessageInTx(
            tx,
            threadId,
            SystemMessageType.FRIEND_REMOVED,
            peer.userId,
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
      await tx.execute(sql`
        DELETE FROM "ThreadAudience"
        WHERE "threadId" = ${threadId} AND "targetDomain" = 'local'
      `);
      if (peer.domain !== 'local')
        await closeFederatedAudienceInTx(tx, peer.domain, threadId);

      const request = await tx.execute(sql`
        INSERT INTO "RelationshipIntent" (
          "pairId", "authorSide", status, note,
          "requestedAt", "expiresAt", "updatedAt"
        ) VALUES (${pairId}, ${callerSide}, 'REVOKED', '', NULL, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
          status = 'REVOKED', note = '', "requestedAt" = NULL,
          "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "RelationshipIntent".status <> 'REVOKED'
        RETURNING 1
      `);
      if (peer.domain === 'local')
        await tx.execute(sql`
          INSERT INTO "RelationshipIntent" (
            "pairId", "authorSide", status, note,
            "requestedAt", "expiresAt", "updatedAt"
          ) VALUES (${pairId}, ${peerSide}, 'REVOKED', '', NULL, NULL, CURRENT_TIMESTAMP)
          ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
            status = 'REVOKED', note = '', "requestedAt" = NULL,
            "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "RelationshipIntent".status <> 'REVOKED'
        `);
      await tx.execute(sql`
        UPDATE "RelationshipPair"
        SET active = false, revision = revision + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${pairId} AND active = true
      `);
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
      return { transitioned, statePeers, systemMessage, localRecipientIds };
    });
  }

  async areFriends(userX: number, userY: number) {
    return (await this.findP2PThreadBetween(userX, userY)) !== null;
  }

  async getActiveP2PPeerUserIds(userId: number): Promise<number[]> {
    const result = await this.database.db.execute<{ userId: number }>(sql`
      SELECT DISTINCT peer."userId"
      FROM "ThreadMember" mine
      JOIN "ThreadMember" peer ON peer."threadId" = mine."threadId"
      JOIN "MessageThread" thread ON thread.id = mine."threadId"
      WHERE mine."userId" = ${userId} AND peer."userId" <> ${userId}
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
          eq(threadParticipant.accountId, userId),
          eq(threadParticipant.threadId, threadId),
        ),
      )
      .returning();
    return row;
  }
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
