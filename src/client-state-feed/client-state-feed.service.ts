import { HttpStatus, Injectable, OnModuleDestroy } from '@nestjs/common';
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { account, clientStateFeed } from '../database/schema.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { SseService } from '../gateway/sse.service.js';
import type { IncomingRequestHead } from '../../shared/relationship-request.js';

export interface PendingClientStateFeedUpdate {
  userId: number;
  feedId: number;
  threadFeedEndId?: number;
}

/** Transports the account's complete incoming request head; owns no request lifecycle. */
@Injectable()
export class ClientStateFeedService implements OnModuleDestroy {
  private static readonly PUSH_COALESCE_MS = 1_000;
  private readonly pushHighWatermarks = new Map<number, number>();
  private readonly pendingPushTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly sse: SseService,
  ) {}

  notifyFeedUpdated(pending: PendingClientStateFeedUpdate): void {
    if (pending.threadFeedEndId !== undefined)
      this.sse.onThreadFeedUpdated(pending.userId, { threadFeedEndId: pending.threadFeedEndId });
    const current = this.pushHighWatermarks.get(pending.userId) ?? 0;
    if (pending.feedId <= current) return;
    this.pushHighWatermarks.set(pending.userId, pending.feedId);
    if (this.pendingPushTimers.has(pending.userId)) return;
    const timer = setTimeout(() => {
      this.pendingPushTimers.delete(pending.userId);
      const feedId = this.pushHighWatermarks.get(pending.userId);
      if (feedId !== undefined) this.sse.onStateFeedUpdated(pending.userId, { feedId });
    }, ClientStateFeedService.PUSH_COALESCE_MS);
    timer.unref?.();
    this.pendingPushTimers.set(pending.userId, timer);
  }

  notifyFeedUpdates(pending: Iterable<PendingClientStateFeedUpdate>): void {
    const heads = new Map<number, PendingClientStateFeedUpdate>();
    for (const update of pending) {
      const current = heads.get(update.userId);
      heads.set(update.userId, {
        userId: update.userId,
        feedId: Math.max(current?.feedId ?? 0, update.feedId),
        ...(current?.threadFeedEndId !== undefined || update.threadFeedEndId !== undefined
          ? { threadFeedEndId: Math.max(current?.threadFeedEndId ?? 0, update.threadFeedEndId ?? 0) }
          : {}),
      });
    }
    for (const head of heads.values()) this.notifyFeedUpdated(head);
  }

  onModuleDestroy(): void {
    for (const timer of this.pendingPushTimers.values()) clearTimeout(timer);
    this.pendingPushTimers.clear();
    this.pushHighWatermarks.clear();
  }

  async readEndId(userId: number): Promise<number> {
    const owner = await this.database.db.query.account.findFirst({
      where: eq(account.id, userId), columns: { clientStateFeedEndId: true },
    });
    if (!owner) throw new Error(`client state feed owner ${userId} is missing`);
    return owner.clientStateFeedEndId;
  }

  async rejectMissingAfter(userId: number): Promise<never> {
    const end = await this.readEndId(userId);
    throw new BusinessException(BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the client state feed cursor', HttpStatus.OK,
      { resumeAfter: 0, resumeBefore: end + 1 });
  }

  /** The caller owns account business locks in canonical order before changing either head.
   * Read the authoritative values here instead of accepting a second mutable head source. */
  async publishRequestHeadInTx(tx: DatabaseTransaction, userId: number): Promise<number | null> {
    const [owner] = await tx.select({
      requestEndId: account.requestEndId, requestReadId: account.requestReadId,
    }).from(account).where(eq(account.id, userId)).for('no key update');
    if (!owner) throw new Error('client state feed owner missing');
    const body: IncomingRequestHead = {
      requestEndId: owner.requestEndId.toString(), requestReadId: owner.requestReadId.toString(),
    };
    const [current] = await tx.select({ body: clientStateFeed.body })
      .from(clientStateFeed).where(eq(clientStateFeed.userId, userId))
      .orderBy(desc(clientStateFeed.feedId)).limit(1);
    const previous = current?.body as IncomingRequestHead | undefined;
    if (previous?.requestEndId === body.requestEndId && previous.requestReadId === body.requestReadId)
      return null;
    const [allocated] = await tx.update(account).set({
      clientStateFeedEndId: sql`${account.clientStateFeedEndId} + 1`, updatedAt: new Date(),
    }).where(eq(account.id, userId)).returning({ feedId: account.clientStateFeedEndId });
    if (!allocated) throw new Error('client state feed owner missing');
    await tx.insert(clientStateFeed).values({ userId, feedId: allocated.feedId, body });
    return allocated.feedId;
  }

  query(userId: number, _mode: 'full' | 'delta', afterFeedId: number, targetFeedId: number) {
    return this.database.db.select().from(clientStateFeed).where(and(
      eq(clientStateFeed.userId, userId), gt(clientStateFeed.feedId, afterFeedId),
      lte(clientStateFeed.feedId, targetFeedId),
    ));
  }
}
