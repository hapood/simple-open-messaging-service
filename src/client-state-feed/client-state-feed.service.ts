import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import {
  account,
  clientStateFeed,
  groupRequestProjection,
  user,
} from '../database/schema.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { SseService } from '../gateway/sse.service.js';
import { ClientGroupMetaFeedService } from './client-group-meta-feed.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';

export interface ClientStateFeedWrite {
  userId: number;
  account: string;
  domain: string;
  eventType:
    | 'PROFILE'
    | 'RELATIONSHIP_INTENT'
    | 'GROUP_META_FEED_HEAD'
    | 'GROUP_JOIN_REQUEST_HEAD'
    | 'INCOMING_INVITE_HEAD'
    | 'THREAD_BLOCK'
    | 'THREAD_CONTENT_HEAD';
  /** Federation context owning this fact. If either relationship endpoint is federated, both
   * authored directions use that captured namespace; only wholly local facts use namespace 0. */
  namespaceId: number;
  subjectAccount: string;
  subjectDomain: string;
  body: Record<string, unknown>;
}

export interface PendingClientStateFeedUpdate {
  userId: number;
  feedId: number;
}

/** Device-facing compacted state feed. Account.stateFeedAllocatedThrough is the shared allocator. */
@Injectable()
export class ClientStateFeedService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
    private readonly groupMetaFeed: ClientGroupMetaFeedService,
  ) {}

  notifyFeedUpdated(pending: PendingClientStateFeedUpdate): void {
    this.sse.onStateFeedUpdated(pending.userId, {
      feedId: pending.feedId,
    });
  }

  /** Publish one committed high-watermark hint per affected user. */
  notifyFeedUpdates(pending: Iterable<PendingClientStateFeedUpdate>): void {
    const highWatermarks = new Map<number, number>();
    for (const update of pending)
      highWatermarks.set(
        update.userId,
        Math.max(highWatermarks.get(update.userId) ?? 0, update.feedId),
      );
    for (const [userId, feedId] of highWatermarks)
      this.notifyFeedUpdated({ userId, feedId });
  }

  async readEndId(userId: number): Promise<number> {
    const owner = await this.database.db.query.account.findFirst({
      where: eq(account.id, userId),
      columns: { stateFeedAllocatedThrough: true },
    });
    if (!owner) throw new Error(`client state feed owner ${userId} is missing`);
    return owner.stateFeedAllocatedThrough;
  }

  async rejectMissingAfter(userId: number): Promise<never> {
    const stateFeedEndId = await this.readEndId(userId);
    throw new BusinessException(
      BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the client state feed cursor',
      HttpStatus.OK,
      { resumeAfter: 0, resumeBefore: stateFeedEndId + 1 },
    );
  }

  async writeInTx(
    tx: DatabaseTransaction,
    write: ClientStateFeedWrite,
  ): Promise<number | null> {
    const body = serializeBody(write.body) as Record<string, unknown>;
    const compactionKey = this.compactionKey(write);
    const [current] = await tx
      .select({
        body: clientStateFeed.body,
      })
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, write.userId),
          eq(clientStateFeed.compactionKey, compactionKey),
        ),
      )
      .limit(1);
    if (current && isDeepStrictEqual(current.body, body)) return null;
    const [owner] = await tx
      .update(account)
      .set({
        stateFeedAllocatedThrough: sql`${account.stateFeedAllocatedThrough} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(account.id, write.userId))
      .returning({ feedId: account.stateFeedAllocatedThrough });
    if (!owner) throw new Error('client state feed owner missing');
    await tx
      .insert(clientStateFeed)
      .values({ ...write, compactionKey, body, feedId: owner.feedId })
      .onConflictDoUpdate({
        target: [clientStateFeed.userId, clientStateFeed.compactionKey],
        set: {
          feedId: owner.feedId,
          body,
          updatedAt: new Date(),
        },
      });
    return owner.feedId;
  }

  private compactionKey(write: ClientStateFeedWrite): string {
    return JSON.stringify([
      write.eventType,
      write.namespaceId,
      write.account,
      write.domain,
      write.subjectAccount,
      write.subjectDomain,
    ]);
  }

  /** Merge the account-wide unread watermark for one group's compacted application head. */
  async writeGroupJoinRequestHeadInTx(
    tx: DatabaseTransaction,
    write: {
      userId: number;
      account: string;
      domain: string;
      threadId: number;
      latestFeedId?: number;
      latestRequestAt?: number;
      readFeedId?: number;
    },
  ): Promise<number | null> {
    const [current] = await tx
      .select({ body: clientStateFeed.body })
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, write.userId),
          eq(clientStateFeed.account, write.account),
          eq(clientStateFeed.domain, write.domain),
          eq(clientStateFeed.eventType, 'GROUP_JOIN_REQUEST_HEAD'),
          eq(clientStateFeed.subjectAccount, ''),
          eq(clientStateFeed.subjectDomain, 'local'),
        ),
      )
      .limit(1);
    const body = current?.body as
      | {
          latestFeedId?: unknown;
          latestRequestAt?: unknown;
          readFeedId?: unknown;
        }
      | undefined;
    const currentLatest =
      typeof body?.latestFeedId === 'number' ? body.latestFeedId : 0;
    const currentRead =
      typeof body?.readFeedId === 'number' ? body.readFeedId : 0;
    const latestFeedId =
      write.latestFeedId !== undefined && write.latestFeedId > currentLatest
        ? write.latestFeedId
        : currentLatest;
    const latestRequestAt =
      write.latestFeedId !== undefined &&
      write.latestFeedId >= currentLatest &&
      write.latestRequestAt !== undefined
        ? write.latestRequestAt
        : typeof body?.latestRequestAt === 'number'
          ? body.latestRequestAt
          : 0;
    const requestedRead =
      write.readFeedId !== undefined && write.readFeedId > currentRead
        ? write.readFeedId
        : currentRead;
    const readFeedId =
      requestedRead > latestFeedId ? latestFeedId : requestedRead;
    return this.writeInTx(tx, {
      userId: write.userId,
      account: write.account,
      domain: write.domain,
      namespaceId: 0,
      eventType: 'GROUP_JOIN_REQUEST_HEAD',
      subjectAccount: '',
      subjectDomain: 'local',
      body: {
        threadId: write.threadId,
        latestFeedId,
        latestRequestAt,
        readFeedId,
      },
    });
  }

  /** Persist one manager-facing group-request projection. Original request timestamps are immutable:
   * terminal intents clear their own expiry, while the projection must retain its seven-day GC boundary. */
  async writeGroupRequestInTx(
    tx: DatabaseTransaction,
    write: {
      managerUserId: number;
      threadId: number;
      memberUserId: number;
      direction: 'APPLICATION' | 'INVITATION';
      requestId: bigint;
      status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
      note: string;
      requestedAt: Date | null;
      expiresAt: Date | null;
    },
  ): Promise<number | null> {
    const [current] = await tx
      .select({
        status: groupRequestProjection.status,
        note: groupRequestProjection.note,
        requestId: groupRequestProjection.requestId,
        requestedAt: groupRequestProjection.requestedAt,
        expiresAt: groupRequestProjection.expiresAt,
      })
      .from(groupRequestProjection)
      .where(
        and(
          eq(groupRequestProjection.managerUserId, write.managerUserId),
          eq(groupRequestProjection.threadId, write.threadId),
          eq(groupRequestProjection.memberUserId, write.memberUserId),
          eq(groupRequestProjection.direction, write.direction),
        ),
      )
      .limit(1);
    const requestedAt = write.requestedAt ?? current?.requestedAt;
    const expiresAt = write.expiresAt ?? current?.expiresAt;
    if (!requestedAt || !expiresAt) return null;
    const note = write.note || current?.note || '';
    if (
      current?.status === write.status &&
      current.note === note &&
      current.requestId === write.requestId &&
      current.requestedAt.getTime() === requestedAt.getTime() &&
      current.expiresAt.getTime() === expiresAt.getTime()
    )
      return null;
    const [owner] = await tx
      .update(account)
      .set({
        stateFeedAllocatedThrough: sql`${account.stateFeedAllocatedThrough} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(account.id, write.managerUserId))
      .returning({ feedId: account.stateFeedAllocatedThrough });
    if (!owner) throw new Error('group-request projection owner missing');
    await tx
      .insert(groupRequestProjection)
      .values({ ...write, note, requestedAt, expiresAt, feedId: owner.feedId })
      .onConflictDoUpdate({
        target: [
          groupRequestProjection.managerUserId,
          groupRequestProjection.threadId,
          groupRequestProjection.memberUserId,
          groupRequestProjection.direction,
        ],
        set: {
          feedId: owner.feedId,
          requestId: write.requestId,
          status: write.status,
          note,
          requestedAt,
          expiresAt,
          updatedAt: new Date(),
        },
      });
    return owner.feedId;
  }

  /** Monotonically advance the account-wide incoming friend/group invitation read watermark. */
  async markIncomingInvitesRead(
    userId: number,
    requestedReadThrough: number,
  ): Promise<number> {
    let pending: PendingClientStateFeedUpdate | undefined;
    const readThroughFeedId = await this.database.db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ allocatedThrough: account.stateFeedAllocatedThrough })
        .from(account)
        .where(eq(account.id, userId))
        .for('update')
        .limit(1);
      if (!owner)
        throw new Error(`client state feed owner ${userId} is missing`);
      if (requestedReadThrough > owner.allocatedThrough)
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'readThroughFeedId exceeds the current state-feed end',
          HttpStatus.BAD_REQUEST,
        );
      const [current] = await tx
        .select({ body: clientStateFeed.body })
        .from(clientStateFeed)
        .where(
          and(
            eq(clientStateFeed.userId, userId),
            eq(clientStateFeed.account, ''),
            eq(clientStateFeed.domain, 'local'),
            eq(clientStateFeed.eventType, 'INCOMING_INVITE_HEAD'),
            eq(clientStateFeed.subjectAccount, ''),
            eq(clientStateFeed.subjectDomain, 'local'),
          ),
        )
        .limit(1);
      const body = current?.body as { readThroughFeedId?: unknown } | undefined;
      const previous =
        typeof body?.readThroughFeedId === 'number' &&
        Number.isSafeInteger(body.readThroughFeedId) &&
        body.readThroughFeedId >= 0
          ? body.readThroughFeedId
          : 0;
      const next = Math.max(previous, requestedReadThrough);
      const feedId = await this.writeInTx(tx, {
        userId,
        account: '',
        domain: 'local',
        namespaceId: 0,
        eventType: 'INCOMING_INVITE_HEAD',
        subjectAccount: '',
        subjectDomain: 'local',
        body: { readThroughFeedId: next },
      });
      if (feedId !== null) pending = { userId, feedId };
      return next;
    });
    if (pending) this.notifyFeedUpdated(pending);
    return readThroughFeedId;
  }

  async recordProfileStateInTx(
    tx: DatabaseTransaction,
    subjectUserId: number,
    consumerUserIds: readonly number[],
  ): Promise<PendingClientStateFeedUpdate[]> {
    const subject = await tx.query.user.findFirst({
      where: eq(user.id, subjectUserId),
      columns: {
        account: true,
        domain: true,
        name: true,
        bio: true,
        avatar: true,
        defaultProfileRev: true,
        namespaceId: true,
      },
    });
    if (!subject) return [];
    const pending: PendingClientStateFeedUpdate[] = [];
    for (const userId of [...new Set(consumerUserIds)].sort((a, b) => a - b)) {
      const feedId = await this.writeInTx(tx, {
        userId,
        account: subject.account,
        domain: subject.domain,
        namespaceId: subject.namespaceId,
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: 'local',
        body: {
          profileRev: subject.defaultProfileRev,
          displayName: subject.name,
          bio: subject.bio,
          avatar: subject.avatar || null,
        },
      });
      if (feedId !== null) pending.push({ userId, feedId });
    }
    return pending;
  }

  /** Remove a member PROFILE only after every client-facing reference owned by this user is gone. */
  async cleanupProfileStateIfUnreferencedInTx(
    tx: DatabaseTransaction,
    ownerUserId: number,
    subjectUserId: number,
  ): Promise<void> {
    const subject = await tx.query.user.findFirst({
      where: eq(user.id, subjectUserId),
      columns: { account: true, domain: true },
    });
    if (!subject) return;
    const domain = subject.domain;
    const references = await tx.execute<{ referenced: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM "GroupRequestProjection" projection
        WHERE projection."managerUserId" = ${ownerUserId}
          AND projection."memberUserId" = ${subjectUserId}
        UNION ALL
        SELECT 1 FROM "ClientStateFeed" intent
        WHERE intent."userId" = ${ownerUserId}
          AND intent."eventType" = 'RELATIONSHIP_INTENT'
          AND ((intent.account = ${subject.account} AND intent.domain = ${domain})
            OR (intent."subjectAccount" = ${subject.account}
              AND intent."subjectDomain" = ${domain}))
        UNION ALL
        SELECT 1 FROM "ClientGroupMetaMemberFeed" member
        WHERE member."accountId" = ${ownerUserId}
          AND member."memberAccount" = ${subject.account}
          AND member."memberDomain" = ${domain}
          AND member.operation = 'UPSERT'
      ) AS referenced
    `);
    if (references.rows[0]?.referenced) return;
    await tx
      .delete(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, ownerUserId),
          eq(clientStateFeed.account, subject.account),
          eq(clientStateFeed.domain, domain),
          eq(clientStateFeed.eventType, 'PROFILE'),
        ),
      );
  }

  async recordGroupStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<PendingClientStateFeedUpdate[]> {
    const groupRows = await tx.execute<{
      groupId: number;
      account: string;
      domain: string;
      displayName: string;
      bio: string;
      avatar: string;
      profileRev: number;
      namespaceId: number;
    }>(sql`
      SELECT group_state.id AS "groupId", group_state.account, group_state.domain,
             group_state."namespaceId",
             group_state.name AS "displayName", group_state.description AS bio,
             group_state.avatar, group_state."defaultProfileRev" AS "profileRev"
      FROM "MessageThread" thread
      JOIN "Group" group_state ON group_state.id = thread."groupId"
      WHERE thread.id = ${threadId} AND thread.type = 'GROUP'
      LIMIT 1
    `);
    const group = groupRows.rows[0];
    if (!group) return [];
    const members = await tx.execute<{
      userId: number;
      account: string;
      domain: string;
      role: string;
      displayName: string;
      avatar: string | null;
      profileResolved: boolean;
      profileRev: number;
      profileMessageSeq: number | null;
      namespaceId: number;
      isLocalAccount: boolean;
      isAuthorized: boolean;
    }>(sql`
      SELECT member.id AS "userId", member.account, member.domain,
             member."namespaceId",
             COALESCE(membership.role, 'MEMBER') AS role,
             COALESCE(exact_profile."displayName", member.account) AS "displayName",
             NULLIF(exact_profile.avatar, '') AS avatar,
             exact_profile.id IS NOT NULL AS "profileResolved",
             CASE WHEN membership."profileMessageSeq" IS NULL
               THEN member."defaultProfileRev"
               ELSE membership."profileRev"
             END AS "profileRev",
             membership."profileMessageSeq" AS "profileMessageSeq",
             EXISTS (SELECT 1 FROM "Account" local_account WHERE local_account.id = member.id)
               AS "isLocalAccount",
             EXISTS (
               SELECT 1 FROM "RelationshipPair" pair
               WHERE pair."threadId" = ${threadId} AND pair.active = true
                 AND ((pair."endpointAType" = 'USER'
                       AND pair."endpointAAccount" = member.account
                       AND pair."endpointADomain" = member.domain
                       AND (member."namespaceId" = 0
                         OR pair."endpointANamespaceId" = member."namespaceId"))
                   OR (pair."endpointBType" = 'USER'
                       AND pair."endpointBAccount" = member.account
                       AND pair."endpointBDomain" = member.domain
                       AND (member."namespaceId" = 0
                         OR pair."endpointBNamespaceId" = member."namespaceId")))
             ) AS "isAuthorized"
      FROM "ThreadMember" membership
      JOIN "User" member ON member.id = membership."userId"
      LEFT JOIN LATERAL (
        SELECT version.id, version."displayName", version.avatar
        FROM "ProfileVersion" version
        WHERE version."userId" = member.id
          AND version."profileRev" = CASE
            WHEN membership."profileMessageSeq" IS NULL
            THEN member."defaultProfileRev"
            ELSE membership."profileRev"
          END
        LIMIT 1
      ) exact_profile ON true
      WHERE membership."threadId" = ${threadId}
        AND membership."left" = false
      ORDER BY member.domain, member.account
    `);
    const memberProjection = members.rows.map((member) => ({
      account: member.account,
      domain: member.domain,
      namespaceId: member.namespaceId,
      body: {
        role: member.role,
        profileRev: member.profileRev,
        profileMessageSeq: member.profileMessageSeq,
        displayName: member.displayName,
        avatar: member.avatar,
        profileResolved: member.profileResolved,
      },
    }));
    const localConsumers = members.rows
      .filter((member) => member.isLocalAccount && member.isAuthorized)
      .map((member) => member.userId)
      .sort((a, b) => a - b);
    const pending: PendingClientStateFeedUpdate[] = [];
    for (const userId of localConsumers) {
      const profileFeedId = await this.writeInTx(tx, {
        userId,
        account: group.account,
        domain: group.domain,
        namespaceId: group.namespaceId,
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: 'local',
        body: {
          profileRev: group.profileRev,
          displayName: group.displayName,
          bio: group.bio,
          avatar: group.avatar || null,
        },
      });
      if (profileFeedId !== null)
        pending.push({ userId, feedId: profileFeedId });
      const groupMetaFeedEndId = await this.groupMetaFeed.reconcileInTx(
        tx,
        userId,
        group.groupId,
        memberProjection,
      );
      const feedId = await this.writeInTx(tx, {
        userId,
        account: group.account,
        domain: group.domain,
        namespaceId: group.namespaceId,
        eventType: 'GROUP_META_FEED_HEAD',
        subjectAccount: '',
        subjectDomain: 'local',
        body: { groupMetaFeedEndId: groupMetaFeedEndId.toString() },
      });
      if (feedId !== null) pending.push({ userId, feedId });
    }
    return pending;
  }

  query(
    userId: number,
    mode: 'full' | 'delta',
    afterFeedId: number,
    targetFeedId: number,
  ) {
    return this.database.db
      .select()
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, userId),
          gt(clientStateFeed.feedId, afterFeedId),
          lte(clientStateFeed.feedId, targetFeedId),
          mode === 'full'
            ? sql`NOT (
                ${clientStateFeed.eventType} = 'THREAD_BLOCK' AND ${clientStateFeed.body}->>'blocked' = 'false'
              )`
            : undefined,
        ),
      )
      .orderBy(asc(clientStateFeed.feedId));
  }
}
