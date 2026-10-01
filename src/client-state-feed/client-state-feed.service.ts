import { hasEstablishedThreadRelationship } from '../relationship/shared/relationship-authorization.js';

import { HttpStatus, Injectable, OnModuleDestroy } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import {
  account,
  clientStateFeed,
  groupMeta,
  groupRequestProjection,
} from '../database/schema.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { SseService } from '../gateway/sse.service.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import type { RequestProjectionStatusValue } from '../../shared/request-projection-status.js';

export interface ClientStateFeedWrite {
  userId: number;
  account: string;
  domain: string;
  eventType: 'RELATIONSHIP_INTENT' | 'INCOMING_INVITE_HEAD';
  /** Federation context owning this fact. If either relationship endpoint is federated, both
   * authored directions use that captured namespace; only wholly local facts use namespace 0. */
  namespaceId: number;
  subjectAccount: string;
  subjectNamespaceId: number;
  body: Record<string, unknown>;
  /** Explicit compaction identity for event families whose stable key is not
   *  the address tuple. */
  compactionIdentity?: string;
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
    // Relationship and conversation mutations can advance either feed. A repeated
    // relationship head must not suppress a newer thread snapshot head.
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
    if (write.compactionIdentity !== undefined) return write.compactionIdentity;
    return JSON.stringify([
      write.eventType,
      write.namespaceId,
      write.account,
      write.domain,
      write.subjectAccount,
      write.subjectNamespaceId,
    ]);
  }

  /** Persist one shared group-request projection. Original request timestamps are immutable:
   * terminal intents clear their own expiry, while the projection must retain its seven-day GC boundary. */
  async writeGroupRequestInTx(
    tx: DatabaseTransaction,
    write: {
      threadId: number;
      memberAccount: string;
      profileNamespaceId: number;
      memberProfileRev: number;
      direction: 'APPLICATION' | 'INVITATION';
      status: RequestProjectionStatusValue;
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
          eq(
            groupRequestProjection.profileNamespaceId,
            write.profileNamespaceId,
          ),
          eq(groupRequestProjection.direction, write.direction),
        ),
      )
      .limit(1);
    if (write.status !== 'REQUESTED' && current?.status !== 'REQUESTED')
      return null;
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
          groupRequestProjection.profileNamespaceId,
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
            eq(clientStateFeed.subjectNamespaceId, 0),
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
        subjectNamespaceId: 0,
        body: { readThroughFeedId: next },
      });
      if (feedId !== null) pending = { userId, feedId };
      return next;
    });
    if (pending) this.notifyFeedUpdated(pending);
    return readThroughFeedId;
  }

  query(
    userId: number,
    mode: 'full' | 'delta',
    afterFeedId: number,
    targetFeedId: number,
  ) {
    // Expired request projections are removed on devices. Do not replay their
    // compacted intent heads during a full rebuild (or a delayed delta pull).
    // Other event types are durable snapshots and must remain available.
    return this.database.db
      .select()
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, userId),
          gt(clientStateFeed.feedId, afterFeedId),
          lte(clientStateFeed.feedId, targetFeedId),
          sql`(${clientStateFeed.eventType} <> 'RELATIONSHIP_INTENT' OR ${clientStateFeed.updatedAt} > CURRENT_TIMESTAMP - INTERVAL '7 days')`,
        ),
      )
      .orderBy(asc(clientStateFeed.feedId));
  }
}
