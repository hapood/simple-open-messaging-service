import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { enqueueReverseP2PRevokeInTx } from '../relationship/reverse-revoke-task.js';
import { writeP2PClientRelationshipInTx } from '../relationship/p2p-client-relationship.js';
import { RelationshipIntentService } from '../relationship/relationship-intent.service.js';
import { groupState as group, groupStateFields } from '../group/group-state.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import {
  addressRelation,
  p2pPeerRelation,
} from '../relationship/relationship-address.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  accountThreadState,
  messageThread,
  account as user,
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
import {
  requireP2PThreadContentLockUnderPairInTx,
  requireThreadContentLockInTx,
} from '../relationship/thread-content-lock.js';
import { lockBusinessAccountsInTx } from '../relationship/business-scope-lock.js';
import { setLockedP2PPairActiveInTx } from '../relationship/p2p-pair-state.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { ThreadFeedHeadWriter } from '../message/thread-feed-head.writer.js';
import { ThreadPreviewService } from '../message/thread-preview.service.js';
/** Per-local-account conversation state. Membership and authorization live in their domain facts. */
@Injectable()
export class AccountThreadStateService {
  @Inject(RelationshipIntentService)
  private readonly relationshipIntents!: RelationshipIntentService;
  @Inject(ThreadPreviewService)
  private readonly previews!: ThreadPreviewService;
  @Inject(DurableTaskQueueService)
  private readonly tasks!: DurableTaskQueueService;
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

  async findActiveParticipantWithThread(userId: number, threadId: number) {
    const [row] = await this.database.db
      .select({
        participant: accountThreadState,
        threadType: messageThread.type,
        clearedSeq: messageThread.clearedSeq,
        groupId: group.id,
        dissolvedAt: groupStateFields.dissolvedAt,
      })
      .from(accountThreadState)
      .innerJoin(
        messageThread,
        eq(messageThread.id, accountThreadState.threadId),
      )
      .leftJoin(group, eq(group.id, messageThread.id))
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
      await requireThreadContentLockInTx(tx, threadId);
      const current = await tx.execute<{ blocked: boolean }>(sql`
          SELECT blocked FROM "AccountThreadState"
          WHERE "accountId" = ${userId} AND "threadId" = ${threadId} FOR NO KEY UPDATE`);
      if (!current.rows[0]) throw new Error('thread participant is missing');
      if (current.rows[0].blocked === blocked) return null;
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
      if (!blocked) {
        await this.previews.initializeReadWindowsInTx(tx, threadId, [userId]);
        // A blocked member missed every fan-out; resuming publishes the
        // current group meta head with the reopened read windows.
        await ThreadFeedHeadWriter.reconcileGroupMetaHeadInTx(tx, {
          threadId,
          userIds: [userId],
        });
      }
      const head = await tx.execute<{
        feedId: number;
        threadFeedEndId: number;
      }>(sql`
        SELECT "stateFeedEndId" AS "feedId", "threadFeedEndId" FROM "Account" WHERE id = ${userId}
      `);
      const feedId = head.rows[0]?.feedId ?? null;
      return {
        notification:
          feedId === null
            ? null
            : { userId, feedId, threadFeedEndId: head.rows[0].threadFeedEndId },
      };
    });
    if (pending?.notification)
      this.clientStateFeed.notifyFeedUpdated(pending.notification);
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
      account: string;
      domain: string;
      namespaceId: number;
      profileRev: number;
      name: string;
      avatar: string;
    }>(sql`
      SELECT pair."threadId", peer.account, peer.domain, peer."namespaceId",
        COALESCE((state.body->'profile'->>'profileRev')::integer, 0) AS "profileRev",
        COALESCE(snapshot."displayName", peer.account) AS name,
        COALESCE(snapshot.avatar, '') AS avatar
      FROM "RelationshipPair" pair
      JOIN "Account" self_identity ON self_identity.id = ${notUserId}
      JOIN ${p2pPeerRelation(sql`pair`, sql`self_identity`)} peer ON true
      LEFT JOIN "ClientStateFeed" state ON state."userId" = self_identity.id
        AND state."eventType" = 'THREAD_STATE' AND state."subjectAccount" = pair."threadId"::text
      LEFT JOIN "Profile" snapshot ON snapshot.account = peer.account AND snapshot.domain = peer.domain
        AND snapshot."namespaceId" = peer."namespaceId" AND snapshot."profileRev" = (state.body->'profile'->>'profileRev')::integer
      WHERE pair.kind = 'P2P' AND pair."threadId" = ANY(${sql.param(threadIds)}::integer[])
    `);
    return rows.rows;
  }

  async findP2PThreadBetween(userX: number, userY: AccountTarget) {
    const second = await this.database.db.transaction((tx) =>
      accountAddressInTx(tx, userY),
    );
    const result = await this.database.db.execute<{ threadId: number }>(sql`
      SELECT pair."threadId"
      FROM "RelationshipPair" pair
      JOIN "Account" first_identity ON first_identity.id = ${userX}
      JOIN ${addressRelation(second)} second_identity ON true
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
      account: string;
      domain: string;
      namespaceId: number;
      threadId: number;
    }>(sql`
      SELECT friend.account, friend.domain, friend."namespaceId", pair."threadId"
      FROM "RelationshipPair" pair
      JOIN "Account" actor ON actor.id = ${userId}
      JOIN ${p2pPeerRelation(sql`pair`, sql`actor`)} friend ON true
      JOIN "MessageThread" thread ON thread.id = pair."threadId" AND thread.type = 'P2P'
      WHERE pair.kind = 'P2P' AND pair.active = true
        AND friend.account = ${address.account} AND friend.domain = ${address.domain}
        AND (friend.domain = 'local' OR EXISTS (
          SELECT 1 FROM "FederatedPeer" peer JOIN "IdentityNamespace" ns ON ns.id = peer."activeNamespaceId"
          WHERE peer.domain = friend.domain AND ns.id = friend."namespaceId" AND ns."retiredAt" IS NULL
        ))
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async findLatestP2PThreadBetween(userX: number, userY: AccountTarget) {
    const second = await this.database.db.transaction((tx) =>
      accountAddressInTx(tx, userY),
    );
    const result = await this.database.db.execute<{ threadId: number }>(sql`
      SELECT pair."threadId"
      FROM "RelationshipPair" pair
      JOIN "Account" first_identity ON first_identity.id = ${userX}
      JOIN ${addressRelation(second)} second_identity ON true
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
    expectedAuthorizationEpoch?: number,
    initiator: AccountTarget = callerUserId,
  ): Promise<{
    transitioned: boolean;
    statePeers: string[];
    systemMessage: PublicMessage | null;
  }> {
    const pendingClientUpdates: Array<{ userId: number; feedId: number }> = [];
    const now = new Date();
    const result = await this.database.db.transaction(async (tx) => {
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
      const pair = await tx.execute<{ id: string; active: boolean }>(sql`
        SELECT id, active FROM "RelationshipPair"
        WHERE id = ${pairId} AND "threadId" = ${threadId} AND kind = 'P2P'
        FOR NO KEY UPDATE
      `);
      if (
        pair.rows[0] === undefined ||
        rawBigInt(pair.rows[0].id, 'RelationshipPair.id') !== pairId
      )
        throw new Error('P2P relationship pair is missing');
      const wasActive = pair.rows[0].active;
      const threadLock = await requireP2PThreadContentLockUnderPairInTx(
        tx,
        pairId,
        threadId,
      );
      if (expectedAuthorizationEpoch !== undefined) {
        const thread = await tx.query.messageThread.findFirst({
          where: eq(messageThread.id, threadId),
          columns: { authorizationEpoch: true },
        });
        if (thread?.authorizationEpoch !== expectedAuthorizationEpoch)
          return { transitioned: false, statePeers: [], systemMessage: null };
      }
      await tx.execute(sql`
        SELECT id FROM "RelationshipIntent"
        WHERE "pairId" = ${pairId}
        ORDER BY "authorSide"
        FOR NO KEY UPDATE
      `);
      await tx.execute(sql`
        SELECT id FROM "AccountThreadState"
        WHERE "threadId" = ${threadId}
        ORDER BY "accountId"
        FOR NO KEY UPDATE
      `);
      const outgoing = await tx.execute<{ status: string }>(sql`
        SELECT status FROM "RelationshipIntent"
        WHERE "pairId" = ${pairId} AND "authorSide" = ${callerSide}
      `);
      const transitioned = outgoing.rows[0]?.status !== 'REVOKED';
      const localHistoryUserIds = [mine, peer]
        .filter((identity) => identity.domain === 'local')
        .map((identity) => identity.userId)
        .filter((id): id is number => id !== null);
      let systemMessage: PublicMessage | null = null;
      const statePeers: string[] = [];
      if (!transitioned) return { transitioned, statePeers, systemMessage };

      if (peer.domain !== 'local')
        await this.stateFeed.lockTargetsInTx(tx, [
          { peerDomain: peer.domain, namespaceId: peer.namespaceId! },
        ]);

      if (wasActive && this.messages) {
        systemMessage = (
          await this.messages.writeSystemMessageInTx(
            tx,
            threadId,
            { type: SystemMessageType.FRIEND_REMOVED, initiator },
            { threadLock },
          )
        ).message;
        if (localHistoryUserIds.length > 0)
          await tx
            .update(accountThreadState)
            .set({
              messageVisibleThroughSeq: systemMessage.seq,
              updatedAt: now,
            })
            .where(
              and(
                eq(accountThreadState.threadId, threadId),
                inArray(accountThreadState.accountId, localHistoryUserIds),
              ),
            );
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
          "pairId", "authorSide", status, note, "messageEndSeq", "tombstoneEndSeq",
          "requestedAt", "expiresAt", "updatedAt"
        ) VALUES (${pairId}, ${callerSide}, 'REVOKED', '', 0, 0, NULL, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
          status = 'REVOKED', note = '', "requestedAt" = NULL,
          "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "RelationshipIntent".status <> 'REVOKED'
        RETURNING "profileRev"
      `);
      if (wasActive && peer.domain === 'local')
        await enqueueReverseP2PRevokeInTx(
          tx,
          this.tasks,
          peer.userId!,
          mine.userId,
        );
      await setLockedP2PPairActiveInTx(tx, pairId, false);
      pendingClientUpdates.push(
        ...(await writeP2PClientRelationshipInTx(
          tx,
          mine,
          peer,
          this.relationshipIntents,
          this.clientStateFeed,
        )),
      );
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
      return { transitioned, statePeers, systemMessage };
    });
    if (pendingClientUpdates.length)
      this.clientStateFeed.notifyFeedUpdates(pendingClientUpdates);
    return result;
  }

  async areFriends(userX: number, userY: number) {
    return (await this.findP2PThreadBetween(userX, userY)) !== null;
  }

  async getActiveP2PPeerUserIds(userId: number): Promise<number[]> {
    const result = await this.database.db.execute<{ userId: number }>(sql`
      SELECT DISTINCT peer.id AS "userId"
      FROM "RelationshipPair" pair
      JOIN "Account" self_identity ON self_identity.id = ${userId}
      JOIN "Account" peer ON peer.id <> self_identity.id
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
      userId: number | null;
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
      peerUserId: number | null;
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
        local_peer.id AS "peerUserId", peer.account AS "peerAccount",
        peer.domain AS "peerDomain", peer."namespaceId" AS "peerNamespaceId"
      FROM "RelationshipPair" pair
      JOIN "Account" mine ON mine.id = ${callerUserId}
      JOIN ${p2pPeerRelation(sql`pair`, sql`mine`)} peer ON true
      LEFT JOIN "Account" local_peer ON peer.domain = 'local' AND local_peer.account = peer.account
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
