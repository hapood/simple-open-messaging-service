import { Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  accountThreadState,
  group,
  messageThread,
  user,
} from '../database/schema.js';
import { rawBigInt } from '../database/raw-result.js';
import { MessageThreadType } from '../database/enums.js';
import { PeerStateFeedService } from '../federation/peer-state-feed.service.js';
import { closeFederatedAudienceInTx } from '../federation/federation-audience.js';
import {
  isThreadMutuallyAuthorized,
  relationshipEndpointMatchesUserSql,
  relationshipPairMatchesUsersSql,
} from '../relationship/relationship-authorization.js';
import {
  MessageService,
  type PublicMessage,
} from '../message/message.service.js';
import { SystemMessageType } from '../message/system-message.js';
import { lockBusinessAccountsInTx } from '../relationship/business-scope-lock.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
/** Per-local-account conversation state. Membership and authorization live in their domain facts. */
@Injectable()
export class AccountThreadStateService {
  constructor(
    private database: DatabaseService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    @Optional() private readonly messages?: MessageService,
  ) {}

  async findParticipant(userId: number, threadId: number) {
    const [participant] = await this.database.db
      .select()
      .from(accountThreadState)
      .where(
        and(
          eq(accountThreadState.accountId, userId),
          eq(accountThreadState.threadId, threadId),
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
        userId: accountThreadState.accountId,
        muted: accountThreadState.muted,
        blocked: accountThreadState.blocked,
        account: user.account,
        domain: user.domain,
      })
      .from(accountThreadState)
      .innerJoin(user, eq(user.id, accountThreadState.accountId))
      .where(eq(accountThreadState.threadId, threadId));
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
        userId: accountThreadState.accountId,
        muted: accountThreadState.muted,
        blocked: accountThreadState.blocked,
        account: user.account,
        domain: user.domain,
      })
      .from(accountThreadState)
      .innerJoin(user, eq(user.id, accountThreadState.accountId))
      .where(
        and(
          eq(accountThreadState.threadId, threadId),
          inArray(accountThreadState.accountId, [...userIds]),
        ),
      );
  }

  async findActiveParticipantWithThread(userId: number, threadId: number) {
    const [row] = await this.database.db
      .select({
        participant: accountThreadState,
        threadType: messageThread.type,
        clearedSeq: messageThread.clearedSeq,
        groupId: group.id,
        dissolvedAt: group.dissolvedAt,
      })
      .from(accountThreadState)
      .innerJoin(
        messageThread,
        eq(messageThread.id, accountThreadState.threadId),
      )
      .leftJoin(group, eq(group.id, messageThread.groupId))
      .where(
        and(
          eq(accountThreadState.accountId, userId),
          eq(accountThreadState.threadId, threadId),
        ),
      )
      .limit(1);
    return row
      ? {
          ...row.participant,
          thread: {
            type: row.threadType,
            clearedSeq: row.clearedSeq,
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
        .update(accountThreadState)
        .set({ blocked, updatedAt: new Date() })
        .where(
          and(
            eq(accountThreadState.accountId, userId),
            eq(accountThreadState.threadId, threadId),
          ),
        )
        .returning({ id: accountThreadState.id });
      if (!participant) throw new Error('thread participant is missing');
      const feedId = await this.clientStateFeed.writeInTx(tx, {
        userId,
        account: '',
        domain: 'local',
        namespaceId: 0,
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
        participant: accountThreadState,
        thread: messageThread,
      })
      .from(accountThreadState)
      .innerJoin(
        messageThread,
        eq(messageThread.id, accountThreadState.threadId),
      )
      .where(
        and(
          eq(accountThreadState.accountId, params.where.userId),
          typeof threadId === 'number'
            ? eq(accountThreadState.threadId, threadId)
            : threadId
              ? inArray(accountThreadState.threadId, threadId.in)
              : undefined,
        ),
      )
      .orderBy(asc(accountThreadState.id))
      .limit(params.take ?? 1000);
    return rows.map((row) => ({
      ...row.participant,
      thread: row.thread,
    }));
  }

  async findP2PPeers(threadIds: number[], notUserId: number) {
    if (threadIds.length === 0) return [];
    const rows = await this.database.db.execute<{
      threadId: number;
      userId: number;
      account: string;
      domain: string;
      namespaceId: number;
    }>(sql`
      SELECT pair."threadId", peer.id AS "userId", peer.account,
        peer.domain, peer."namespaceId"
      FROM "RelationshipPair" pair
      JOIN "User" self_identity ON self_identity.id = ${notUserId}
      JOIN "User" peer ON peer.id <> self_identity.id
      WHERE pair.kind = 'P2P'
        AND pair."threadId" IN (${sql.join(
          threadIds.map((threadId) => sql`${threadId}`),
          sql`, `,
        )})
        AND ${relationshipPairMatchesUsersSql(sql`pair`, sql`self_identity`, sql`peer`)}
    `);
    return rows.rows.map((row) => ({
      ...row,
      user: {
        id: row.userId,
        account: row.account,
        domain: row.domain,
        namespaceId: row.namespaceId,
      },
    }));
  }

  async findP2PThreadBetween(userX: number, userY: number) {
    const result = await this.database.db.execute<{ threadId: number }>(sql`
      SELECT pair."threadId"
      FROM "RelationshipPair" pair
      JOIN "User" first_identity ON first_identity.id = ${userX}
      JOIN "User" second_identity ON second_identity.id = ${userY}
      JOIN "MessageThread" thread ON thread.id = pair."threadId"
      WHERE pair.kind = 'P2P' AND pair.active = true
        AND ${relationshipPairMatchesUsersSql(sql`pair`, sql`first_identity`, sql`second_identity`)}
        AND thread.type = ${MessageThreadType.P2P}
      LIMIT 1
    `);
    return result.rows[0]?.threadId ?? null;
  }

  /** Resolve an existing direct friend, never an identity copied from another group's authority. */
  async findP2PFriendByAddress(
    userId: number,
    address: { account: string; domain: string },
  ) {
    const result = await this.database.db.execute<{
      userId: number;
      threadId: number;
    }>(sql`
      SELECT friend.id AS "userId", pair."threadId"
      FROM "User" friend
      JOIN "User" actor ON actor.id = ${userId}
      JOIN "RelationshipPair" pair ON pair.kind = 'P2P' AND pair.active = true
        AND ${relationshipPairMatchesUsersSql(sql`pair`, sql`actor`, sql`friend`)}
      JOIN "MessageThread" thread ON thread.id = pair."threadId" AND thread.type = 'P2P'
      WHERE friend.account = ${address.account} AND friend.domain = ${address.domain}
        AND friend.availability = 'AVAILABLE'
        AND friend."namespaceId" = CASE WHEN ${address.domain} = 'local' THEN 0 ELSE (
          SELECT ns.id FROM "FederatedPeer" peer
          JOIN "IdentityNamespace" ns ON ns.id = peer."activeNamespaceId"
          WHERE peer.domain = ${address.domain} AND ns.domain = peer.domain AND ns."retiredAt" IS NULL
        ) END
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async findLatestP2PThreadBetween(userX: number, userY: number) {
    const result = await this.database.db.execute<{ threadId: number }>(sql`
      SELECT pair."threadId"
      FROM "RelationshipPair" pair
      JOIN "User" first_identity ON first_identity.id = ${userX}
      JOIN "User" second_identity ON second_identity.id = ${userY}
      JOIN "MessageThread" thread ON thread.id = pair."threadId"
      WHERE pair.kind = 'P2P'
        AND ${relationshipPairMatchesUsersSql(sql`pair`, sql`first_identity`, sql`second_identity`)}
        AND thread.type = ${MessageThreadType.P2P}
      ORDER BY pair."threadId" DESC LIMIT 1
    `);
    return result.rows[0]?.threadId ?? null;
  }

  async softLeaveP2PBoth(threadId: number): Promise<void> {
    void threadId;
  }

  async endP2P(
    threadId: number,
    callerUserId: number,
  ): Promise<{
    transitioned: boolean;
    statePeers: string[];
    systemMessage: PublicMessage | null;
    localRecipientIds: number[];
  }> {
    const now = new Date();
    return this.database.db.transaction(async (tx) => {
      let endpoints = await this.readP2PEndpointsInTx(
        tx,
        threadId,
        callerUserId,
      );
      if (!endpoints) throw new Error('P2P endpoints are missing');
      let { mine, peer } = endpoints;
      await lockBusinessAccountsInTx(tx, [mine, peer]);
      endpoints = await this.readP2PEndpointsInTx(tx, threadId, callerUserId);
      if (!endpoints) throw new Error('P2P endpoints are missing');
      ({ mine, peer } = endpoints);
      const { callerSide, pairId } = endpoints;
      const peerSide = callerSide === 'A' ? 'B' : 'A';
      const pair = await tx.execute<{ id: string; active: boolean }>(sql`
        SELECT id, active FROM "RelationshipPair"
        WHERE id = ${pairId} AND "threadId" = ${threadId} AND kind = 'P2P'
        FOR UPDATE
      `);
      if (
        pair.rows[0] === undefined ||
        rawBigInt(pair.rows[0].id, 'RelationshipPair.id') !== pairId
      )
        throw new Error('P2P relationship pair is missing');
      const wasActive = pair.rows[0].active;
      await tx.execute(
        sql`SELECT id FROM "MessageThread" WHERE id = ${threadId} FOR UPDATE`,
      );
      await tx.execute(sql`
        SELECT id FROM "RelationshipIntent"
        WHERE "pairId" = ${pairId}
        ORDER BY "authorSide"
        FOR UPDATE
      `);
      await tx.execute(sql`
        SELECT id FROM "AccountThreadState"
        WHERE "threadId" = ${threadId}
        ORDER BY "accountId"
        FOR UPDATE
      `);
      const outgoing = await tx.execute<{ status: string }>(sql`
        SELECT status FROM "RelationshipIntent"
        WHERE "pairId" = ${pairId} AND "authorSide" = ${callerSide}
      `);
      const transitioned = outgoing.rows[0]?.status !== 'REVOKED';
      const localRecipientIds = [mine, peer]
        .filter((identity) => identity.domain === 'local')
        .map((identity) => identity.userId);
      let systemMessage: PublicMessage | null = null;
      const statePeers: string[] = [];
      if (!transitioned)
        return { transitioned, statePeers, systemMessage, localRecipientIds };

      if (peer.domain !== 'local')
        await this.stateFeed.lockTargetsInTx(tx, [
          { peerDomain: peer.domain, namespaceId: peer.namespaceId! },
        ]);

      if (wasActive && this.messages) {
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
          .update(accountThreadState)
          .set({
            messageVisibleThroughSeq: systemMessage.seq,
            updatedAt: now,
          })
          .where(eq(accountThreadState.threadId, threadId));
      }
      if (wasActive) {
        await tx.execute(sql`
          DELETE FROM "ThreadAudience"
          WHERE "threadId" = ${threadId} AND "targetDomain" = 'local'
        `);
        if (peer.domain !== 'local')
          await closeFederatedAudienceInTx(tx, peer.domain, threadId);
      }

      const request = await tx.execute<{ profileRev: number }>(sql`
        INSERT INTO "RelationshipIntent" (
          "pairId", "authorSide", status, note,
          "requestedAt", "expiresAt", "updatedAt"
        ) VALUES (${pairId}, ${callerSide}, 'REVOKED', '', NULL, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
          status = 'REVOKED', note = '', "requestedAt" = NULL,
          "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "RelationshipIntent".status <> 'REVOKED'
        RETURNING "profileRev"
      `);
      if (wasActive && peer.domain === 'local')
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
        SET active = false, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${pairId} AND active = true
      `);
      if ((request.rowCount ?? 0) > 0 && peer.domain !== 'local') {
        const profileRev = request.rows[0]?.profileRev;
        if (profileRev === undefined)
          throw new Error('revoked friend intent disappeared');
        const localDomain = process.env.SOMS_DOMAIN;
        if (!localDomain)
          throw new Error('SOMS_DOMAIN is required for federation state');
        await this.stateFeed.writeManyInTx(tx, [
          {
            peerDomain: peer.domain,
            namespaceId: peer.namespaceId!,
            account: mine.account,
            domain: localDomain,
            subjectAccount: peer.account,
            subjectDomain: peer.domain,
            eventType: 'RELATIONSHIP_INTENT',
            body: {
              status: 'REVOKED',
              profileRev,
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
      SELECT DISTINCT peer.id AS "userId"
      FROM "RelationshipPair" pair
      JOIN "User" self_identity ON self_identity.id = ${userId}
      JOIN "User" peer ON peer.id <> self_identity.id
      JOIN "MessageThread" thread ON thread.id = pair."threadId"
      WHERE pair.kind = 'P2P' AND pair.active = true
        AND ${relationshipPairMatchesUsersSql(sql`pair`, sql`self_identity`, sql`peer`)}
        AND thread.type = ${MessageThreadType.P2P}
    `);
    return result.rows.map((row) => row.userId);
  }

  private async readP2PEndpointsInTx(
    tx: DatabaseTransaction,
    threadId: number,
    callerUserId: number,
  ): Promise<{
    pairId: bigint;
    callerSide: 'A' | 'B';
    mine: {
      userId: number;
      account: string;
      domain: string;
      namespaceId: number;
    };
    peer: {
      userId: number;
      account: string;
      domain: string;
      namespaceId: number;
    };
  } | null> {
    const result = await tx.execute<{
      pairId: string;
      callerSide: 'A' | 'B';
      mineUserId: number;
      mineAccount: string;
      mineDomain: string;
      mineNamespaceId: number;
      peerUserId: number;
      peerAccount: string;
      peerDomain: string;
      peerNamespaceId: number;
    }>(sql`
      SELECT pair.id AS "pairId",
        CASE
          WHEN ${relationshipEndpointMatchesUserSql(sql`pair`, 'A', sql`mine`)} THEN 'A'
          ELSE 'B'
        END AS "callerSide",
        mine.id AS "mineUserId", mine.account AS "mineAccount",
        mine.domain AS "mineDomain", mine."namespaceId" AS "mineNamespaceId",
        peer.id AS "peerUserId", peer.account AS "peerAccount",
        peer.domain AS "peerDomain", peer."namespaceId" AS "peerNamespaceId"
      FROM "RelationshipPair" pair
      JOIN "User" mine ON mine.id = ${callerUserId}
      JOIN "User" peer ON peer.id <> mine.id
      WHERE pair.kind = 'P2P' AND pair."threadId" = ${threadId}
        AND ${relationshipPairMatchesUsersSql(sql`pair`, sql`mine`, sql`peer`)}
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      pairId: rawBigInt(row.pairId, 'RelationshipPair.id'),
      callerSide: row.callerSide,
      mine: {
        userId: row.mineUserId,
        account: row.mineAccount,
        domain: row.mineDomain,
        namespaceId: row.mineNamespaceId,
      },
      peer: {
        userId: row.peerUserId,
        account: row.peerAccount,
        domain: row.peerDomain,
        namespaceId: row.peerNamespaceId,
      },
    };
  }

  private async updateParticipant(
    userId: number,
    threadId: number,
    data: Partial<typeof accountThreadState.$inferInsert>,
  ) {
    const [row] = await this.database.db
      .update(accountThreadState)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(accountThreadState.accountId, userId),
          eq(accountThreadState.threadId, threadId),
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
