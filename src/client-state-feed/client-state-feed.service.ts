import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PushService } from '../push/push.service.js';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { account, clientStateFeed } from '../database/schema.js';
import { ClientStateFeedType } from '../database/enums.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { SseService } from '../gateway/sse.service.js';
import type { IncomingRequestHead } from '../../shared/relationship-request.js';
import type {
  ThreadMetaHead,
  ThreadTombHead,
} from '../../shared/client-state-feed.js';

/** Independent post-commit client-feed events. Request attention is a
 * domain-specific event kind, not optional fields on a shared update: events
 * from different domains stay separate, each publishing its own wake, and
 * PushService coalesces per session by coordinate. */
export type PendingClientStateFeedUpdate =
  | {
      /** Conversation projections advanced the thread head. */
      kind: 'thread-feed';
      userId: number;
      feedId: number;
      threadFeedEndId: number;
    }
  | {
      /** A thread tombstone head advanced in ClientStateFeed. */
      kind: 'thread-tomb-head';
      userId: number;
      feedId: number;
    }
  | {
      /** A group meta head advanced in ClientStateFeed. */
      kind: 'thread-meta-head';
      userId: number;
      feedId: number;
    }
  | {
      /** A friend request or group invitation round reached this account. */
      kind: 'personal-request-arrival';
      userId: number;
      feedId: number;
    }
  | {
      /** Incoming personal requests were read. */
      kind: 'personal-request-read';
      userId: number;
      feedId: number;
    }
  | GroupRequestArrivalEvent
  | GroupRequestReadEvent;

/** A group join application reached this manager. */
export interface GroupRequestArrivalEvent {
  kind: 'group-request-arrival';
  userId: number;
  feedId: number;
  threadFeedEndId: number;
}

/** Manager join-request attention was consumed or revoked. */
export interface GroupRequestReadEvent {
  kind: 'group-request-read';
  userId: number;
  feedId: number;
  threadFeedEndId: number;
}

/** Transports the account's compacted client state heads; owns no domain lifecycle. */
@Injectable()
export class ClientStateFeedService {
  private readonly logger = new Logger(ClientStateFeedService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
    private readonly push: PushService,
  ) {}

  notifyFeedUpdated(update: PendingClientStateFeedUpdate): void {
    switch (update.kind) {
      case 'personal-request-arrival':
      case 'personal-request-read':
        this.enqueueRequestWake({
          userId: update.userId,
          stateFeedEndId: update.feedId,
          convergence: update.kind === 'personal-request-read',
        });
        break;
      case 'group-request-arrival':
      case 'group-request-read':
        this.enqueueRequestWake({
          userId: update.userId,
          threadFeedEndId: update.threadFeedEndId,
          convergence: update.kind === 'group-request-read',
        });
        this.sse.onThreadFeedUpdated(update.userId, {
          threadFeedEndId: update.threadFeedEndId,
        });
        break;
      case 'thread-feed':
        this.sse.onThreadFeedUpdated(update.userId, {
          threadFeedEndId: update.threadFeedEndId,
        });
        break;
      case 'thread-tomb-head':
      case 'thread-meta-head':
        break;
    }
    this.sse.onStateFeedUpdated(update.userId, { feedId: update.feedId });
  }

  private enqueueRequestWake(target: {
    userId: number;
    stateFeedEndId?: number;
    threadFeedEndId?: number;
    convergence: boolean;
  }): void {
    void this.push
      .enqueueForRequestAttention([target])
      .catch((error: unknown) => {
        this.logger.warn(`Request push wake failed: ${String(error)}`);
      });
  }

  notifyFeedUpdates(updates: Iterable<PendingClientStateFeedUpdate>): void {
    for (const update of updates) this.notifyFeedUpdated(update);
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
    const end = await this.readEndId(userId);
    throw new BusinessException(
      BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the client state feed cursor',
      HttpStatus.OK,
      { resumeAfter: 0, resumeBefore: end + 1 },
    );
  }

  /** The caller owns account business locks in canonical order before changing either head.
   * Read the authoritative values here instead of accepting a second mutable head source. */
  async publishRequestHeadInTx(
    tx: DatabaseTransaction,
    userId: number,
  ): Promise<number | null> {
    const [owner] = await tx
      .select({
        requestEndId: account.requestEndId,
        requestReadId: account.requestReadId,
      })
      .from(account)
      .where(eq(account.id, userId))
      .for('no key update');
    if (!owner) throw new Error('client state feed owner missing');
    const body: IncomingRequestHead = {
      requestEndId: owner.requestEndId.toString(),
      requestReadId: owner.requestReadId.toString(),
    };
    const [current] = await tx
      .select({ body: clientStateFeed.body })
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, userId),
          eq(clientStateFeed.type, ClientStateFeedType.REQUEST_HEAD),
          eq(clientStateFeed.threadId, 0),
        ),
      )
      .limit(1);
    const previous = current?.body as IncomingRequestHead | undefined;
    if (
      previous?.requestEndId === body.requestEndId &&
      previous.requestReadId === body.requestReadId
    )
      return null;
    return this.upsertItemInTx(
      tx,
      userId,
      ClientStateFeedType.REQUEST_HEAD,
      0,
      body,
    );
  }

  /** Caller holds the account feed allocator lock for userId. */
  async publishThreadTombHeadInTx(
    tx: DatabaseTransaction,
    userId: number,
    threadId: number,
    tombstoneEndSeq: number,
  ): Promise<number | null> {
    if (!Number.isSafeInteger(tombstoneEndSeq) || tombstoneEndSeq < 0)
      throw new Error('invalid tombstoneEndSeq for client state feed');
    const [current] = await tx
      .select({ body: clientStateFeed.body })
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, userId),
          eq(clientStateFeed.type, ClientStateFeedType.THREAD_TOMB_HEAD),
          eq(clientStateFeed.threadId, threadId),
        ),
      )
      .limit(1);
    const previous = current?.body as ThreadTombHead | undefined;
    if (previous && previous.tombstoneEndSeq >= tombstoneEndSeq) return null;
    const body: ThreadTombHead = { threadId, tombstoneEndSeq };
    return this.upsertItemInTx(
      tx,
      userId,
      ClientStateFeedType.THREAD_TOMB_HEAD,
      threadId,
      body,
    );
  }

  /** Caller holds the account feed allocator lock for userId. */
  async publishThreadMetaHeadInTx(
    tx: DatabaseTransaction,
    userId: number,
    threadId: number,
    groupMetaFeedEndId: number,
  ): Promise<number | null> {
    if (!Number.isSafeInteger(groupMetaFeedEndId) || groupMetaFeedEndId < 0)
      throw new Error('invalid groupMetaFeedEndId for client state feed');
    const [current] = await tx
      .select({ body: clientStateFeed.body })
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, userId),
          eq(clientStateFeed.type, ClientStateFeedType.THREAD_META_HEAD),
          eq(clientStateFeed.threadId, threadId),
        ),
      )
      .limit(1);
    const previous = current?.body as ThreadMetaHead | undefined;
    if (previous && Number(previous.groupMetaFeedEndId) >= groupMetaFeedEndId)
      return null;
    const body: ThreadMetaHead = {
      threadId,
      groupMetaFeedEndId: String(groupMetaFeedEndId),
    };
    return this.upsertItemInTx(
      tx,
      userId,
      ClientStateFeedType.THREAD_META_HEAD,
      threadId,
      body,
    );
  }

  private async upsertItemInTx(
    tx: DatabaseTransaction,
    userId: number,
    type: ClientStateFeedType,
    threadId: number,
    body: IncomingRequestHead | ThreadTombHead | ThreadMetaHead,
  ): Promise<number> {
    const [allocated] = await tx
      .update(account)
      .set({
        clientStateFeedEndId: sql`${account.clientStateFeedEndId} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(account.id, userId))
      .returning({ feedId: account.clientStateFeedEndId });
    if (!allocated) throw new Error('client state feed owner missing');
    await tx
      .insert(clientStateFeed)
      .values({
        userId,
        feedId: allocated.feedId,
        type,
        threadId,
        body,
      })
      .onConflictDoUpdate({
        target: [
          clientStateFeed.userId,
          clientStateFeed.type,
          clientStateFeed.threadId,
        ],
        set: {
          feedId: allocated.feedId,
          body,
          updatedAt: new Date(),
        },
      });
    return allocated.feedId;
  }

  query(
    userId: number,
    _mode: 'full' | 'delta',
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
      );
  }
}
