import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Pool, type Notification, type PoolClient } from 'pg';
import { and, asc, eq, gt, isNull, lte, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ContentType } from '../database/enums.js';
import {
  federatedPeer,
  federationMessageFeedAllocation,
  federationMessageDelivery,
  federationServeCursor,
  message,
  messageThread,
  threadAudience,
  user,
} from '../database/schema.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  FederationChangeBuffer,
  type FederationBufferedChange,
} from './federation-change-buffer.js';
import { FEDERATION_MEMORY_FEED_ADVANCED } from './federation-memory-feed.events.js';

export const FEDERATION_MEMORY_FEED_CAPACITY = 10_000;
const FILL_QUERY_SIZE = 500;

export enum FederationFeedFillState {
  CAUGHT_UP = 'CAUGHT_UP',
  NEEDS_FILL = 'NEEDS_FILL',
  FILLING = 'FILLING',
  FULL = 'FULL',
}

export interface FederationFeedFillQuantumResult {
  state: FederationFeedFillState;
  /** Database scan work consumed by this turn. Empty audience probes count as one unit. */
  work: number;
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(callback: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

interface PeerMemoryFeed {
  readonly buffer: FederationChangeBuffer;
  readonly mutex: AsyncMutex;
  readonly messageKeys: Set<string>;
  readonly loadedThrough: Map<bigint, number>;
  state: FederationFeedFillState;
  initialized: boolean;
  resetGeneration: number | null;
  nextAudienceId: bigint | null;
}

interface OfferResult {
  state: FederationFeedFillState;
  advanced: boolean;
}

interface MessageAllocationCandidate {
  messageId: bigint;
  threadId: number;
  messageSeq: number;
}

/**
 * Process-local cache over durable per-peer allocations. ThreadAudience carries only the current
 * authorization's scan position. A separate durable delivery ledger authorizes later tombstones.
 */
@Injectable()
export class FederationMemoryFeedService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly peers = new Map<string, PeerMemoryFeed>();
  private ownerPool: Pool | null = null;
  private ownerClient: PoolClient | null = null;
  private readonly onNotification = (notification: Notification): void => {
    if (notification.channel !== 'soms_federation_message_committed') return;
    void this.handleCommittedNotification(notification.payload).catch(() => {
      // The next startup rebuild or explicit feed request is the durable recovery path.
    });
  };

  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    const connectionString = process.env.DATABASE_URL?.trim();
    const ownerPool = new Pool({
      ...(connectionString ? { connectionString } : {}),
      max: 1,
    });
    const client = await ownerPool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(`
        SELECT pg_try_advisory_lock(
          hashtext(current_database()),
          hashtext('federation-memory-feed-owner')
        ) AS locked
      `);
      if (!result.rows[0]?.locked) {
        throw new Error(
          'another API process owns the federation memory feed for this database; configure a single federation owner',
        );
      }
      client.on('notification', this.onNotification);
      await client.query('LISTEN soms_federation_message_committed');
      this.ownerPool = ownerPool;
      this.ownerClient = client;
    } catch (error) {
      client.release(true);
      await ownerPool.end();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.ownerClient;
    const ownerPool = this.ownerPool;
    this.ownerClient = null;
    this.ownerPool = null;
    if (client) {
      client.removeListener('notification', this.onNotification);
      // This dedicated connection exists only to own LISTEN + the advisory lock. Destroying its
      // backend releases both atomically and never blocks DatabaseService from ending its own pool.
      client.release(true);
    }
    if (ownerPool) await ownerPool.end();
  }

  fill(peerDomain: string): Promise<FederationFeedFillState> {
    const peer = this.peer(peerDomain);
    return peer.mutex.run(
      async () => (await this.fillInLock(peerDomain, peer)).state,
    );
  }

  fillQuantum(
    peerDomain: string,
    maxWork: number,
  ): Promise<FederationFeedFillQuantumResult> {
    if (!Number.isInteger(maxWork) || maxWork < 0) {
      throw new Error('fill quantum must be a non-negative integer');
    }
    const peer = this.peer(peerDomain);
    return peer.mutex.run(() => this.fillInLock(peerDomain, peer, maxWork));
  }

  /** Hold the peer's process lock across cursor validation, durable ACK and response selection. */
  runExclusive<T>(peerDomain: string, callback: () => Promise<T>): Promise<T> {
    return this.peer(peerDomain).mutex.run(callback);
  }

  fillWhileLocked(peerDomain: string): Promise<FederationFeedFillState> {
    return this.fillInLock(peerDomain, this.peer(peerDomain)).then(
      (result) => result.state,
    );
  }

  readAfterWhileLocked(
    peerDomain: string,
    after: bigint,
    take: number,
  ): FederationBufferedChange[] {
    return this.peer(peerDomain).buffer.readAfter(after, take);
  }

  retireWhileLocked(peerDomain: string, through: bigint): number {
    const peer = this.peer(peerDomain);
    const retired = peer.buffer.retireThrough(through);
    for (const entry of retired)
      peer.messageKeys.delete(this.messageKey(entry));
    if (retired.length > 0 && peer.state === FederationFeedFillState.FULL) {
      peer.state = FederationFeedFillState.NEEDS_FILL;
    }
    return retired.length;
  }

  /** Active post-commit path. It uses the same scanner immediately; a missed hook is recovered by the
   * durable database notification or the next startup/request rebuild, and predecessors cannot overtake. */
  async offerCommitted(
    peerDomain: string,
    threadId: number,
    messageSeq: number,
  ): Promise<FederationFeedFillState> {
    return (
      await this.offerCommittedWithResult(peerDomain, threadId, messageSeq)
    ).state;
  }

  private async offerCommittedWithResult(
    peerDomain: string,
    threadId: number,
    messageSeq: number,
  ): Promise<OfferResult> {
    const peer = this.peer(peerDomain);
    return peer.mutex.run(async () => {
      const allocatedBefore = peer.buffer.allocatedThrough;
      await this.refreshPeerGenerationInLock(peerDomain, peer);
      void threadId;
      void messageSeq;
      await this.fillInLock(peerDomain, peer);
      return {
        state: peer.state,
        advanced: peer.buffer.allocatedThrough !== allocatedBefore,
      };
    });
  }

  async readAfter(
    peerDomain: string,
    after: bigint,
    take: number,
  ): Promise<FederationBufferedChange[]> {
    const peer = this.peer(peerDomain);
    return peer.mutex.run(async () => {
      await this.initializeInLock(peerDomain, peer);
      return peer.buffer.readAfter(after, take);
    });
  }

  async acknowledgeInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    through: bigint,
  ): Promise<FederationBufferedChange[]> {
    const peer = this.peer(peerDomain);
    await this.initializeInLock(peerDomain, peer);
    const acknowledged = peer.buffer
      .snapshot()
      .filter((entry) => entry.feedId <= through);
    await tx
      .delete(federationMessageFeedAllocation)
      .where(
        and(
          eq(federationMessageFeedAllocation.peerDomain, peerDomain),
          lte(federationMessageFeedAllocation.feedId, through),
        ),
      );
    return acknowledged;
  }

  async retire(peerDomain: string, through: bigint): Promise<number> {
    const peer = this.peer(peerDomain);
    return peer.mutex.run(async () => {
      const retired = peer.buffer.retireThrough(through);
      for (const entry of retired) {
        peer.messageKeys.delete(this.messageKey(entry));
      }
      if (retired.length > 0 && peer.state === FederationFeedFillState.FULL) {
        peer.state = FederationFeedFillState.NEEDS_FILL;
      }
      return retired.length;
    });
  }

  state(peerDomain: string): FederationFeedFillState {
    return this.peer(peerDomain).state;
  }

  size(peerDomain: string): number {
    return this.peer(peerDomain).buffer.size;
  }

  private peer(peerDomain: string): PeerMemoryFeed {
    let peer = this.peers.get(peerDomain);
    if (!peer) {
      peer = {
        buffer: new FederationChangeBuffer(FEDERATION_MEMORY_FEED_CAPACITY),
        mutex: new AsyncMutex(),
        messageKeys: new Set(),
        state: FederationFeedFillState.NEEDS_FILL,
        initialized: false,
        resetGeneration: null,
        loadedThrough: new Map(),
        nextAudienceId: null,
      };
      this.peers.set(peerDomain, peer);
    }
    return peer;
  }

  private async fillInLock(
    peerDomain: string,
    peer: PeerMemoryFeed,
    maxWork = Number.MAX_SAFE_INTEGER,
  ): Promise<FederationFeedFillQuantumResult> {
    try {
      await this.refreshPeerGenerationInLock(peerDomain, peer);
      await this.initializeInLock(peerDomain, peer);
      await this.syncPersistedAllocationsInLock(peerDomain, peer);
      if (peer.buffer.full) {
        peer.state = FederationFeedFillState.FULL;
        return { state: peer.state, work: 0 };
      }
      if (maxWork === 0) return { state: peer.state, work: 0 };
      peer.state = FederationFeedFillState.FILLING;
      const result = await this.fillAudiencesInLock(peerDomain, peer, maxWork);
      peer.state = peer.buffer.full
        ? FederationFeedFillState.FULL
        : result.hasMore
          ? FederationFeedFillState.NEEDS_FILL
          : FederationFeedFillState.CAUGHT_UP;
      return { state: peer.state, work: result.work };
    } catch (error) {
      peer.state = FederationFeedFillState.NEEDS_FILL;
      throw error;
    }
  }

  private async handleCommittedNotification(payload?: string): Promise<void> {
    if (!payload) return;
    const parsed = JSON.parse(payload) as { threadId?: unknown; seq?: unknown };
    if (
      !Number.isInteger(parsed.threadId) ||
      !Number.isInteger(parsed.seq) ||
      Number(parsed.threadId) < 1 ||
      Number(parsed.seq) < 0
    ) {
      return;
    }
    const threadId = Number(parsed.threadId);
    const messageSeq = Number(parsed.seq);
    const audiences = await this.database.db
      .selectDistinct({ peerDomain: threadAudience.targetDomain })
      .from(threadAudience)
      .where(
        and(
          eq(threadAudience.threadId, threadId),
          isNull(threadAudience.localUserId),
          isNull(threadAudience.deliverThroughChangeId),
        ),
      );
    await Promise.all(
      audiences.map(async ({ peerDomain }) => {
        const result = await this.offerCommittedWithResult(
          peerDomain,
          threadId,
          messageSeq,
        );
        if (result.advanced) {
          this.events?.emit(FEDERATION_MEMORY_FEED_ADVANCED, { peerDomain });
        }
      }),
    );
  }

  private async initializeInLock(
    peerDomain: string,
    peer: PeerMemoryFeed,
  ): Promise<void> {
    if (peer.initialized) return;
    const [cursor] = await this.database.db
      .select({
        resetGeneration: federatedPeer.resetGeneration,
      })
      .from(federationServeCursor)
      .innerJoin(
        federatedPeer,
        eq(federatedPeer.domain, federationServeCursor.peerDomain),
      )
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!cursor) throw new Error(`peer ${peerDomain} has no serve cursor`);
    const allocations = await this.database.db
      .select({
        feedId: federationMessageFeedAllocation.feedId,
        threadId: federationMessageFeedAllocation.threadId,
        messageId: federationMessageFeedAllocation.messageId,
        messageSeq: federationMessageFeedAllocation.messageSeq,
      })
      .from(federationMessageFeedAllocation)
      .innerJoin(
        federationServeCursor,
        eq(
          federationServeCursor.peerDomain,
          federationMessageFeedAllocation.peerDomain,
        ),
      )
      .innerJoin(
        message,
        eq(message.id, federationMessageFeedAllocation.messageId),
      )
      .where(
        and(
          eq(federationMessageFeedAllocation.peerDomain, peerDomain),
          gt(
            federationMessageFeedAllocation.feedId,
            federationServeCursor.acknowledgedThrough,
          ),
        ),
      )
      .orderBy(asc(federationMessageFeedAllocation.feedId))
      .limit(peer.buffer.capacity + 1);
    if (allocations.length > peer.buffer.capacity) {
      throw new Error(
        `peer ${peerDomain} has more unacknowledged message allocations than memory capacity`,
      );
    }
    for (const allocation of allocations) {
      this.append(peer, {
        feedId: allocation.feedId,
        threadId: allocation.threadId,
        messageId: allocation.messageId,
        messageSeq: allocation.messageSeq,
      });
    }
    peer.resetGeneration = cursor.resetGeneration;
    peer.initialized = true;
  }

  private async refreshPeerGenerationInLock(
    peerDomain: string,
    peer: PeerMemoryFeed,
  ): Promise<void> {
    if (!peer.initialized) return;
    const [cursor] = await this.database.db
      .select({ resetGeneration: federatedPeer.resetGeneration })
      .from(federationServeCursor)
      .innerJoin(
        federatedPeer,
        eq(federatedPeer.domain, federationServeCursor.peerDomain),
      )
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!cursor) throw new Error(`peer ${peerDomain} has no serve cursor`);
    if (cursor.resetGeneration === peer.resetGeneration) return;
    peer.buffer.clear();
    peer.messageKeys.clear();
    peer.loadedThrough.clear();
    peer.nextAudienceId = null;
    peer.state = FederationFeedFillState.NEEDS_FILL;
    peer.initialized = false;
    peer.resetGeneration = null;
  }

  private async syncPersistedAllocationsInLock(
    peerDomain: string,
    peer: PeerMemoryFeed,
  ): Promise<void> {
    if (peer.buffer.full) return;
    const after = peer.buffer.allocatedThrough ?? 0n;
    const allocations = await this.database.db
      .select({
        feedId: federationMessageFeedAllocation.feedId,
        threadId: federationMessageFeedAllocation.threadId,
        messageId: federationMessageFeedAllocation.messageId,
        messageSeq: federationMessageFeedAllocation.messageSeq,
      })
      .from(federationMessageFeedAllocation)
      .innerJoin(
        federationServeCursor,
        eq(
          federationServeCursor.peerDomain,
          federationMessageFeedAllocation.peerDomain,
        ),
      )
      .where(
        and(
          eq(federationMessageFeedAllocation.peerDomain, peerDomain),
          gt(federationMessageFeedAllocation.feedId, after),
          gt(
            federationMessageFeedAllocation.feedId,
            federationServeCursor.acknowledgedThrough,
          ),
        ),
      )
      .orderBy(asc(federationMessageFeedAllocation.feedId))
      .limit(peer.buffer.capacity - peer.buffer.size);
    allocations.forEach((allocation) => this.append(peer, allocation));
  }

  private async fillAudiencesInLock(
    peerDomain: string,
    peer: PeerMemoryFeed,
    maxWork: number,
  ): Promise<{ work: number; hasMore: boolean }> {
    const groupIdentity = alias(user, 'message_feed_group_identity');
    const audiences = await this.database.db
      .select({
        id: threadAudience.id,
        threadId: threadAudience.threadId,
        fromSeq: sql<number>`${threadAudience.messageScannedThroughSeq} + 1`,
        throughSeq: threadAudience.deliverThroughChangeId,
        acknowledgedSeq: threadAudience.messageScannedThroughSeq,
        currentSeq: messageThread.curSeq,
        groupDomain: groupIdentity.domain,
      })
      .from(threadAudience)
      .innerJoin(
        messageThread,
        eq(messageThread.id, threadAudience.threadId),
      )
      .leftJoin(groupIdentity, eq(groupIdentity.id, messageThread.groupUserId))
      .where(
        and(
          eq(threadAudience.targetDomain, peerDomain),
          isNull(threadAudience.localUserId),
          isNull(threadAudience.deliverThroughChangeId),
        ),
      )
      .orderBy(asc(threadAudience.id));

    const startIndex =
      peer.nextAudienceId === null
        ? 0
        : Math.max(
            0,
            audiences.findIndex(
              (audience) => audience.id === peer.nextAudienceId,
            ),
          );
    const ordered = audiences
      .slice(startIndex)
      .concat(audiences.slice(0, startIndex));
    let work = 0;
    let hasMore = false;

    for (
      let audienceIndex = 0;
      audienceIndex < ordered.length;
      audienceIndex++
    ) {
      const audience = ordered[audienceIndex];
      peer.nextAudienceId =
        ordered[(audienceIndex + 1) % ordered.length]?.id ?? null;
      if (peer.buffer.full) return { work, hasMore: true };
      const loaded =
        peer.loadedThrough.get(audience.id) ??
        audience.acknowledgedSeq ??
        audience.currentSeq;
      const upper = audience.currentSeq;
      if (loaded >= upper) continue;
      let cursor = loaded;
      while (cursor < upper && !peer.buffer.full) {
        if (work >= maxWork) {
          hasMore = true;
          break;
        }
        const take = Math.min(
          FILL_QUERY_SIZE,
          peer.buffer.capacity - peer.buffer.size,
          maxWork - work,
        );
        const rows = await this.database.db
          .select({
            messageId: message.id,
            threadId: message.threadId,
            messageSeq: message.seq,
            contentType: message.contentType,
            originSeq: message.originSeq,
            creatorForeigner: user.isForeigner,
          })
          .from(message)
          .innerJoin(user, eq(user.id, message.creator))
          .where(
            and(
              eq(message.threadId, audience.threadId),
              gt(message.seq, cursor),
              lte(message.seq, upper),
            ),
          )
          .orderBy(asc(message.seq))
          .limit(take);
        work += Math.max(rows.length, 1);
        if (rows.length === 0) {
          cursor = upper;
          peer.loadedThrough.set(audience.id, upper);
          break;
        }
        const candidates = rows.filter(
          (row) =>
            row.contentType !== ContentType.SYSTEM &&
            (audience.groupDomain === null ||
              audience.groupDomain === 'local' ||
              (!row.creatorForeigner && row.originSeq === null)) &&
            !peer.messageKeys.has(
              row.messageId.toString(),
            ),
        );
        const allocated = await this.allocateOpenAudienceWhileLocked(
          peerDomain,
          audience.id,
          candidates,
          rows.at(-1)!.messageSeq,
        );
        if (!allocated) break;
        for (const row of allocated) {
          this.append(peer, {
            feedId: row.feedId,
            threadId: row.threadId,
            messageId: row.messageId,
            messageSeq: row.messageSeq,
          });
        }
        cursor = rows.at(-1)!.messageSeq;
        peer.loadedThrough.set(audience.id, cursor);
      }
      if (cursor < upper) hasMore = true;
      if (work >= maxWork) {
        hasMore = true;
        break;
      }
    }
    return { work, hasMore };
  }

  /** Lock the current audience while assigning IDs and advancing its scan position. Closing the
   * audience takes the same row lock after draining, so no allocation can cross the revoke boundary. */
  private async allocateOpenAudienceWhileLocked(
    peerDomain: string,
    audienceId: bigint,
    candidates: readonly MessageAllocationCandidate[],
    scannedThrough: number,
  ): Promise<Array<MessageAllocationCandidate & { feedId: bigint }> | null> {
    return this.database.db.transaction(async (tx) => {
      const [audience] = await tx
        .select({ closedAt: threadAudience.deliverThroughChangeId })
        .from(threadAudience)
        .where(
          and(
            eq(threadAudience.id, audienceId),
            eq(threadAudience.targetDomain, peerDomain),
            isNull(threadAudience.localUserId),
          ),
        )
        .for('update')
        .limit(1);
      if (!audience || audience.closedAt !== null) return null;
      let first = 0n;
      if (candidates.length > 0) {
        const [allocated] = await tx
          .update(federationServeCursor)
          .set({
            allocatedThrough: sql`${federationServeCursor.allocatedThrough} + ${candidates.length}`,
            updatedAt: new Date(),
          })
          .where(eq(federationServeCursor.peerDomain, peerDomain))
          .returning({ last: federationServeCursor.allocatedThrough });
        if (!allocated)
          throw new Error(`peer ${peerDomain} has no discovery target`);
        first = allocated.last - BigInt(candidates.length) + 1n;
      }
      const rows = candidates.map((candidate, index) => ({
        ...candidate,
        feedId: first + BigInt(index),
      }));
      if (rows.length > 0)
        await tx.insert(federationMessageFeedAllocation).values(
          rows.map((row) => ({
            peerDomain,
            feedId: row.feedId,
            messageId: row.messageId,
            threadId: row.threadId,
            messageSeq: row.messageSeq,
          })),
        );
      if (rows.length > 0)
        await tx
          .insert(federationMessageDelivery)
          .values(
            rows.map((row) => ({
              peerDomain,
              messageId: row.messageId,
            })),
          )
          .onConflictDoNothing();
      await tx
        .update(threadAudience)
        .set({ messageScannedThroughSeq: scannedThrough })
        .where(eq(threadAudience.id, audienceId));
      return rows;
    });
  }

  /** Caller must hold this peer's runExclusive lock. Shared by message and tombstone buffers. */
  async allocateSharedWhileLocked(
    peerDomain: string,
    count: number,
  ): Promise<{ first: bigint; last: bigint }> {
    if (count === 0) return { first: 0n, last: -1n };
    const [allocated] = await this.database.db
      .update(federationServeCursor)
      .set({
        allocatedThrough: sql`${federationServeCursor.allocatedThrough} + ${count}`,
        updatedAt: new Date(),
      })
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .returning({ last: federationServeCursor.allocatedThrough });
    if (!allocated)
      throw new Error(`peer ${peerDomain} has no discovery target`);
    return {
      first: allocated.last - BigInt(count) + 1n,
      last: allocated.last,
    };
  }

  private append(peer: PeerMemoryFeed, entry: FederationBufferedChange): void {
    const key = this.messageKey(entry);
    if (peer.messageKeys.has(key)) return;
    if (!peer.buffer.append(entry)) {
      peer.state = FederationFeedFillState.FULL;
      return;
    }
    peer.messageKeys.add(key);
  }

  private messageKey(entry: FederationBufferedChange): string {
    return entry.messageId.toString();
  }
}
