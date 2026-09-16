import {
  groupState as group,
  groupStateFields,
} from '../group/business/shared/group-state.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import {
  addressRelation,
  p2pPeerRelation,
} from '../relationship/business/shared/relationship-address.js';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  accountThreadState,
  messageThread,
  account as user,
} from '../database/schema.js';
import { MessageThreadType } from '../database/enums.js';
import {
  isThreadMutuallyAuthorized,
  relationshipPairMatchesUsersSql,
} from '../relationship/business/shared/relationship-authorization.js';
import { requireThreadContentLockInTx } from '../common/business/locks/thread-content-lock.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { ThreadFeedHeadWriter } from '../message/thread-feed-head.writer.js';
import { ThreadPreviewService } from '../message/thread-preview.service.js';
/** Per-local-account conversation state. Membership and authorization live in their domain facts. */
@Injectable()
export class AccountThreadStateService {
  @Inject(ThreadPreviewService)
  private readonly previews!: ThreadPreviewService;
  constructor(
    private database: DatabaseService,
    private readonly clientStateFeed: ClientStateFeedService,
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
      const threadLock = await requireThreadContentLockInTx(tx, threadId);
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
        await this.previews.initializeReadWindowsInTx(
          tx,
          threadId,
          [userId],
          threadLock,
        );
        // A blocked member missed every fan-out; resuming publishes the
        // current Group Meta coordinate with the reopened read windows.
        await ThreadFeedHeadWriter.reconcileGroupMetaCoordinateInTx(tx, {
          threadId,
          userIds: [userId],
        });
      }
      const head = await tx.execute<{
        feedId: number;
        threadFeedEndId: number;
      }>(sql`
        SELECT "clientStateFeedEndId" AS "feedId", "threadFeedEndId" FROM "Account" WHERE id = ${userId}
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
