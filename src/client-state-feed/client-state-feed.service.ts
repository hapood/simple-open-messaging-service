import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { clientStateFeed, user } from '../database/schema.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { SseService } from '../gateway/sse.service.js';
import { mutuallyAuthorizedSql } from '../invite/relationship-authorization.js';
import { ClientGroupMetaFeedService } from './client-group-meta-feed.service.js';

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
    | 'THREAD_BLOCK';
  subjectAccount: string;
  subjectDomain: string;
  body: Record<string, unknown>;
}

export interface PendingClientStateFeedUpdate {
  userId: number;
  feedId: number;
}

/** Device-facing compacted state feed. User.stateFeedAllocatedThrough is the shared allocator. */
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

  async readEndId(userId: number): Promise<number> {
    const owner = await this.database.db.query.user.findFirst({
      where: eq(user.id, userId),
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
    const [current] = await tx
      .select({
        body: clientStateFeed.body,
      })
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, write.userId),
          eq(clientStateFeed.account, write.account),
          eq(clientStateFeed.domain, write.domain),
          eq(clientStateFeed.eventType, write.eventType),
          eq(clientStateFeed.subjectAccount, write.subjectAccount),
          eq(clientStateFeed.subjectDomain, write.subjectDomain),
        ),
      )
      .limit(1);
    if (current && isDeepStrictEqual(current.body, write.body)) return null;
    const [owner] = await tx
      .update(user)
      .set({
        stateFeedAllocatedThrough: sql`${user.stateFeedAllocatedThrough} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(user.id, write.userId))
      .returning({ feedId: user.stateFeedAllocatedThrough });
    if (!owner) throw new Error('client state feed owner missing');
    await tx
      .insert(clientStateFeed)
      .values({ ...write, feedId: owner.feedId })
      .onConflictDoUpdate({
        target: [
          clientStateFeed.userId,
          clientStateFeed.account,
          clientStateFeed.domain,
          clientStateFeed.eventType,
          clientStateFeed.subjectAccount,
          clientStateFeed.subjectDomain,
        ],
        set: {
          feedId: owner.feedId,
          body: write.body,
          updatedAt: new Date(),
        },
      });
    return owner.feedId;
  }

  /** Merge the account-wide unread watermark for one group's compacted application head. */
  async writeGroupJoinRequestHeadInTx(
    tx: DatabaseTransaction,
    write: {
      userId: number;
      account: string;
      domain: string;
      threadId: number;
      latestRequestId?: bigint;
      latestRequestAt?: number;
      readRequestId?: bigint;
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
          eq(clientStateFeed.subjectDomain, ''),
        ),
      )
      .limit(1);
    const body = current?.body as
      | { before?: unknown; latestRequestAt?: unknown; readRequestId?: unknown }
      | undefined;
    const currentLatest =
      typeof body?.before === 'string' ? BigInt(body.before) - 1n : 0n;
    const currentRead =
      typeof body?.readRequestId === 'string' ? BigInt(body.readRequestId) : 0n;
    const latestRequestId =
      write.latestRequestId !== undefined &&
      write.latestRequestId > currentLatest
        ? write.latestRequestId
        : currentLatest;
    const latestRequestAt =
      write.latestRequestId !== undefined &&
      write.latestRequestId >= currentLatest &&
      write.latestRequestAt !== undefined
        ? write.latestRequestAt
        : typeof body?.latestRequestAt === 'number'
          ? body.latestRequestAt
          : 0;
    const requestedRead =
      write.readRequestId !== undefined && write.readRequestId > currentRead
        ? write.readRequestId
        : currentRead;
    const readRequestId =
      requestedRead > latestRequestId ? latestRequestId : requestedRead;
    return this.writeInTx(tx, {
      userId: write.userId,
      account: write.account,
      domain: write.domain,
      eventType: 'GROUP_JOIN_REQUEST_HEAD',
      subjectAccount: '',
      subjectDomain: '',
      body: {
        threadId: write.threadId,
        before: (latestRequestId + 1n).toString(),
        latestRequestAt,
        readRequestId: readRequestId.toString(),
      },
    });
  }

  /** Monotonically advance the account-wide incoming friend/group invitation read watermark. */
  async markIncomingInvitesRead(
    userId: number,
    requestedReadThrough: number,
  ): Promise<number> {
    let pending: PendingClientStateFeedUpdate | undefined;
    const readThroughFeedId = await this.database.db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ allocatedThrough: user.stateFeedAllocatedThrough })
        .from(user)
        .where(eq(user.id, userId))
        .for('update')
        .limit(1);
      if (!owner) throw new Error(`client state feed owner ${userId} is missing`);
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
            eq(clientStateFeed.domain, ''),
            eq(clientStateFeed.eventType, 'INCOMING_INVITE_HEAD'),
            eq(clientStateFeed.subjectAccount, ''),
            eq(clientStateFeed.subjectDomain, ''),
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
        domain: '',
        eventType: 'INCOMING_INVITE_HEAD',
        subjectAccount: '',
        subjectDomain: '',
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
        profileRev: true,
      },
    });
    if (!subject) return [];
    const pending: PendingClientStateFeedUpdate[] = [];
    for (const userId of [...new Set(consumerUserIds)].sort((a, b) => a - b)) {
      const feedId = await this.writeInTx(tx, {
        userId,
        account: subject.account,
        domain: subject.domain === 'local' ? '' : subject.domain,
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: '',
        body: {
          profileRev: subject.profileRev,
          displayName: subject.name,
          bio: subject.bio,
          avatar: subject.avatar || null,
        },
      });
      if (feedId !== null) pending.push({ userId, feedId });
    }
    return pending;
  }

  async recordGroupStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<PendingClientStateFeedUpdate[]> {
    const groupRows = await tx.execute<{
      groupUserId: number;
      account: string;
      domain: string;
      displayName: string;
      bio: string;
      avatar: string;
      profileRev: number;
    }>(sql`
      SELECT thread."groupUserId" AS "groupUserId", group_user.account, group_user.domain,
             group_user.name AS "displayName", group_user.bio,
             group_user.avatar, group_user."profileRev" AS "profileRev"
      FROM "MessageThread" thread
      JOIN "User" group_user ON group_user.id = thread."groupUserId"
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
      profileRev: number;
    }>(sql`
      SELECT member.id AS "userId", member.account, member.domain,
             COALESCE(participant.role, 'MEMBER') AS role,
             member.name AS "displayName", NULLIF(member.avatar, '') AS avatar,
             CASE WHEN member."isForeigner" THEN COALESCE(member."remoteProfileRev", 0)
                  ELSE member."profileRev" END AS "profileRev"
      FROM "ThreadParticipant" participant
      JOIN "User" member ON member.id = participant."userId"
      JOIN "Group" group_state ON group_state."groupUserId" = ${group.groupUserId}
      WHERE participant."threadId" = ${threadId}
        AND (member.id = group_state."ownerId"
          OR ${mutuallyAuthorizedSql(sql`member.id`, group.groupUserId)})
      ORDER BY member.domain, member.account
    `);
    const memberProjection = members.rows.map((member) => ({
      account: member.account,
      domain: member.domain === 'local' ? '' : member.domain,
      body: {
        userId: member.userId,
        role: member.role,
        profileRev: member.profileRev,
        displayName: member.displayName,
        avatar: member.avatar,
      },
    }));
    const localConsumers = members.rows
      .filter((member) => member.domain === 'local')
      .map((member) => member.userId)
      .sort((a, b) => a - b);
    const pending: PendingClientStateFeedUpdate[] = [];
    for (const userId of localConsumers) {
      const profileFeedId = await this.writeInTx(tx, {
        userId,
        account: group.account,
        domain: group.domain === 'local' ? '' : group.domain,
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: '',
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
        group.groupUserId,
        memberProjection,
      );
      const feedId = await this.writeInTx(tx, {
        userId,
        account: group.account,
        domain: group.domain === 'local' ? '' : group.domain,
        eventType: 'GROUP_META_FEED_HEAD',
        subjectAccount: '',
        subjectDomain: '',
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
                (${clientStateFeed.eventType} = 'RELATIONSHIP_INTENT' AND ${clientStateFeed.body}->>'status' = 'REVOKED')
                OR (${clientStateFeed.eventType} = 'THREAD_BLOCK' AND ${clientStateFeed.body}->>'blocked' = 'false')
              )`
            : undefined,
        ),
      )
      .orderBy(asc(clientStateFeed.feedId));
  }
}
