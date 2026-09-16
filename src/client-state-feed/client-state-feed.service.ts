import { hasEstablishedThreadRelationship } from '../relationship/shared/relationship-authorization.js';
import { groupStateSql } from '../group/shared/group-state.js';

import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import { accountProfileFields } from '../user/account-profile.js';
import { HttpStatus, Injectable, OnModuleDestroy } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import {
  account,
  clientStateFeed,
  groupMeta,
  groupRequestProjection,
  account as user,
} from '../database/schema.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { SseService } from '../gateway/sse.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';

export interface ClientStateFeedWrite {
  userId: number;
  account: string;
  domain: string;
  eventType:
    | 'PROFILE'
    | 'RELATIONSHIP_INTENT'
    | 'GROUP_JOIN_REQUEST_HEAD'
    | 'INCOMING_INVITE_HEAD'
    | 'THREAD_STATE';
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
  threadFeedEndId?: number;
}

/** Device-facing compacted state feed. Account.clientStateFeedEndId is the shared allocator. */
@Injectable()
export class ClientStateFeedService implements OnModuleDestroy {
  private static readonly PUSH_COALESCE_MS = 1_000;
  /** Process-lifetime, monotonic high watermark per client State Feed. It is
   * intentionally not durable: reconnect recovery reads the database-backed
   * feed head. A busy account must not consume another account's window. */
  private readonly pushHighWatermarks = new Map<number, number>();
  private readonly pendingPushTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
  ) {}

  notifyFeedUpdated(pending: PendingClientStateFeedUpdate): void {
    // Conversation mutations can advance both independent feeds. A repeated
    // state head must not suppress a newer read/preview head.
    if (pending.threadFeedEndId !== undefined)
      this.sse.onThreadFeedUpdated(pending.userId, {
        threadFeedEndId: pending.threadFeedEndId,
      });
    const current = this.pushHighWatermarks.get(pending.userId) ?? 0;
    if (pending.feedId <= current) return;
    this.pushHighWatermarks.set(pending.userId, pending.feedId);
    if (this.pendingPushTimers.has(pending.userId)) return;
    const timer = setTimeout(() => {
      this.pendingPushTimers.delete(pending.userId);
      const feedId = this.pushHighWatermarks.get(pending.userId);
      if (feedId === undefined) return;
      this.sse.onStateFeedUpdated(pending.userId, { feedId });
    }, ClientStateFeedService.PUSH_COALESCE_MS);
    timer.unref?.();
    this.pendingPushTimers.set(pending.userId, timer);
  }

  /** Publish one committed high-watermark hint per affected user. */
  notifyFeedUpdates(pending: Iterable<PendingClientStateFeedUpdate>): void {
    const highWatermarks = new Map<number, PendingClientStateFeedUpdate>();
    for (const update of pending) {
      const current = highWatermarks.get(update.userId);
      highWatermarks.set(update.userId, {
        userId: update.userId,
        feedId: Math.max(current?.feedId ?? 0, update.feedId),
        ...(current?.threadFeedEndId !== undefined ||
        update.threadFeedEndId !== undefined
          ? {
              threadFeedEndId: Math.max(
                current?.threadFeedEndId ?? 0,
                update.threadFeedEndId ?? 0,
              ),
            }
          : {}),
      });
    }
    for (const update of highWatermarks.values())
      this.notifyFeedUpdated(update);
  }

  onModuleDestroy(): void {
    for (const timer of this.pendingPushTimers.values()) clearTimeout(timer);
    this.pendingPushTimers.clear();
    this.pushHighWatermarks.clear();
  }

  async readEndId(userId: number): Promise<number> {
    const owner = await this.database.db.query.account.findFirst({
      where: eq(account.id, userId),
      columns: { clientStateFeedEndId: true },
    });
    if (!owner) throw new Error(`client state feed owner ${userId} is missing`);
    return owner.clientStateFeedEndId;
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
    if (write.eventType === 'RELATIONSHIP_INTENT') {
      const threadId = body.localThreadId ?? body.threadId;
      body.established =
        typeof threadId === 'number' &&
        (await hasEstablishedThreadRelationship(tx, write.userId, threadId));
    }

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
        clientStateFeedEndId: sql`${account.clientStateFeedEndId} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(account.id, write.userId))
      .returning({ feedId: account.clientStateFeedEndId });
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

  /** Persist one shared group-request projection. Original request timestamps are immutable:
   * terminal intents clear their own expiry, while the projection must retain its seven-day GC boundary. */
  async writeGroupRequestInTx(
    tx: DatabaseTransaction,
    write: {
      threadId: number;
      memberAccount: string;
      memberDomain: string;
      memberNamespaceId: number;
      memberProfileRev: number;
      direction: 'APPLICATION' | 'INVITATION';
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
        memberProfileRev: groupRequestProjection.memberProfileRev,
        requestedAt: groupRequestProjection.requestedAt,
        expiresAt: groupRequestProjection.expiresAt,
      })
      .from(groupRequestProjection)
      .where(
        and(
          eq(groupRequestProjection.threadId, write.threadId),
          eq(groupRequestProjection.memberAccount, write.memberAccount),
          eq(groupRequestProjection.memberDomain, write.memberDomain),
          eq(groupRequestProjection.memberNamespaceId, write.memberNamespaceId),
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
      current.memberProfileRev === write.memberProfileRev &&
      current.note === note &&
      current.requestedAt.getTime() === requestedAt.getTime() &&
      current.expiresAt.getTime() === expiresAt.getTime()
    )
      return null;
    // The group's per-direction counters number the event; the shared
    // projection row carries that number, and the row is created lazily for
    // groups that have not fanned group meta yet.
    const invitation = write.direction === 'INVITATION';
    const [feed] = await tx
      .insert(groupMeta)
      .values({
        threadId: write.threadId,
        applicationEndId: invitation ? 0 : 1,
        invitationEndId: invitation ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: groupMeta.threadId,
        set: {
          applicationEndId: sql`${groupMeta.applicationEndId} + ${invitation ? 0 : 1}`,
          invitationEndId: sql`${groupMeta.invitationEndId} + ${invitation ? 1 : 0}`,
          updatedAt: new Date(),
        },
      })
      .returning({
        feedId: invitation
          ? groupMeta.invitationEndId
          : groupMeta.applicationEndId,
      });
    if (!feed) throw new Error('group-request projection feed is missing');
    const feedId = feed.feedId;
    await tx
      .insert(groupRequestProjection)
      .values({ ...write, note, requestedAt, expiresAt, feedId })
      .onConflictDoUpdate({
        target: [
          groupRequestProjection.threadId,
          groupRequestProjection.memberAccount,
          groupRequestProjection.memberDomain,
          groupRequestProjection.memberNamespaceId,
          groupRequestProjection.direction,
        ],
        set: {
          feedId,
          memberProfileRev: write.memberProfileRev,
          status: write.status,
          note,
          requestedAt,
          expiresAt,
        },
      });
    return feedId;
  }

  /** Monotonically advance the account-wide incoming friend/group invitation read watermark. */
  async markRelationshipRequestsRead(
    userId: number,
    requestedReadThrough: number,
  ): Promise<number> {
    let pending: PendingClientStateFeedUpdate | undefined;
    const readThroughFeedId = await this.database.db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ allocatedThrough: account.clientStateFeedEndId })
        .from(account)
        .where(eq(account.id, userId))
        .for('no key update')
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
    const subject = await tx.query.account.findFirst({
      where: eq(user.id, subjectUserId),
      extras: {
        name: accountProfileFields().name.as('name'),
        avatar: accountProfileFields().avatar.as('avatar'),
        bio: accountProfileFields().bio.as('bio'),
      },
      columns: {
        account: true,
        domain: true,
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
    subjectUserId: AccountTarget,
  ): Promise<void> {
    const subject = await accountAddressInTx(tx, subjectUserId);
    const domain = subject.domain;
    const references = await tx.execute<{ referenced: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM "GroupRequestProjection" projection
        WHERE projection."memberAccount" = ${subject.account}
          AND projection."memberDomain" = ${subject.domain}
          AND projection."memberNamespaceId" = ${subject.namespaceId}
        UNION ALL
        SELECT 1 FROM "ClientStateFeed" intent
        WHERE intent."userId" = ${ownerUserId}
          AND intent."eventType" = 'RELATIONSHIP_INTENT'
          AND ((intent.account = ${subject.account} AND intent.domain = ${domain})
            OR (intent."subjectAccount" = ${subject.account}
              AND intent."subjectDomain" = ${domain}))
        UNION ALL
        SELECT 1
        FROM "MessageThread" thread
        JOIN "Account" owner_identity ON owner_identity.id = ${ownerUserId}
        JOIN "RelationshipPair" owner_pair
          ON owner_pair."threadId" = thread.id
         AND owner_pair.kind = 'GROUP_MEMBER'
         AND owner_pair.active = true
         AND ((owner_pair."endpointAType" = 'USER'
               AND owner_pair."endpointAAccount" = owner_identity.account
               AND owner_pair."endpointADomain" = owner_identity.domain)
           OR (owner_pair."endpointBType" = 'USER'
               AND owner_pair."endpointBAccount" = owner_identity.account
               AND owner_pair."endpointBDomain" = owner_identity.domain))
        WHERE thread.type = 'GROUP'
          AND (
            SELECT member_fact.operation
            FROM "GroupMetaMemberFeed" member_fact
            WHERE member_fact."threadId" = thread.id
              AND member_fact."memberAccount" = ${subject.account}
              AND member_fact."memberDomain" = ${subject.domain}
              AND group_meta_member_namespace(member_fact."threadId",
                member_fact."memberAccount", member_fact."memberDomain") = ${subject.namespaceId}
            ORDER BY member_fact."feedId" DESC
            LIMIT 1
          ) = 'UPSERT'
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

  /** Publish the compacted group profile after a mirror round commits. */
  async publishGroupProfileToLocalAccountsInTx(
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
             group_state.avatar, group_state."profileRev" AS "profileRev"
      FROM "MessageThread" thread
      JOIN ${groupStateSql} group_state ON group_state.id = thread.id
      WHERE thread.id = ${threadId} AND thread.type = 'GROUP'
      LIMIT 1
    `);
    const group = groupRows.rows[0];
    if (!group) return [];
    const consumers = await tx.execute<{
      userId: number;
    }>(sql`
      SELECT DISTINCT participant."accountId" AS "userId"
      FROM "AccountThreadState" participant
      JOIN "Account" identity ON identity.id = participant."accountId"
      JOIN "RelationshipPair" pair
        ON pair."threadId" = participant."threadId"
       AND pair.kind = 'GROUP_MEMBER'
       AND pair.active = true
       AND ((pair."endpointAType" = 'USER'
             AND pair."endpointAAccount" = identity.account
             AND pair."endpointADomain" = 'local')
         OR (pair."endpointBType" = 'USER'
             AND pair."endpointBAccount" = identity.account
             AND pair."endpointBDomain" = 'local'))
      WHERE participant."threadId" = ${threadId}
        AND identity.domain = 'local'
        AND identity."namespaceId" = 0
      ORDER BY participant."accountId"
    `);
    const pending: PendingClientStateFeedUpdate[] = [];
    for (const { userId } of consumers.rows) {
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
        ),
      )
      .orderBy(asc(clientStateFeed.feedId));
  }
}
