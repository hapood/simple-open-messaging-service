import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Pool, type Notification, type PoolClient } from 'pg';
import { and, asc, eq, gt, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { ContentType } from '../database/enums.js';
import {
  federatedPeer,
  federationAudienceEpoch,
  federationServeCursor,
  federationThreadCheckpoint,
  message,
  messageThread,
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
}

interface OfferResult {
  state: FederationFeedFillState;
  advanced: boolean;
}

/**
 * Process-local source feed. PostgreSQL stores only reconstruction epochs/checkpoints and the small
 * peer cursor rows; message references remain in bounded chunked buffers until the peer acknowledges.
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
    return peer.mutex.run(() => this.fillInLock(peerDomain, peer));
  }

  /** Hold the peer's process lock across cursor validation, durable ACK and response selection. */
  runExclusive<T>(peerDomain: string, callback: () => Promise<T>): Promise<T> {
    return this.peer(peerDomain).mutex.run(callback);
  }

  fillWhileLocked(peerDomain: string): Promise<FederationFeedFillState> {
    return this.fillInLock(peerDomain, this.peer(peerDomain));
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
      await this.initializeInLock(peerDomain, peer);
      if (peer.state === FederationFeedFillState.NEEDS_FILL) {
        await this.fillInLock(peerDomain, peer);
      }
      if (peer.buffer.full) {
        peer.state = FederationFeedFillState.FULL;
        return {
          state: peer.state,
          advanced: peer.buffer.allocatedThrough !== allocatedBefore,
        };
      }
      const [epoch] = await this.database.db
        .select({
          id: federationAudienceEpoch.id,
          acknowledgedSeq: federationThreadCheckpoint.acknowledgedSeq,
        })
        .from(federationAudienceEpoch)
        .innerJoin(
          federationThreadCheckpoint,
          eq(federationThreadCheckpoint.epochId, federationAudienceEpoch.id),
        )
        .where(
          and(
            eq(federationAudienceEpoch.peerDomain, peerDomain),
            eq(federationAudienceEpoch.threadId, threadId),
            lte(federationAudienceEpoch.fromSeq, messageSeq),
            or(
              isNull(federationAudienceEpoch.throughSeq),
              sql`${federationAudienceEpoch.throughSeq} >= ${messageSeq}`,
            ),
          ),
        )
        .orderBy(asc(federationAudienceEpoch.id))
        .limit(1);
      if (!epoch) {
        return {
          state: peer.state,
          advanced: peer.buffer.allocatedThrough !== allocatedBefore,
        };
      }
      const loaded = peer.loadedThrough.get(epoch.id) ?? epoch.acknowledgedSeq;
      if (messageSeq <= loaded) {
        return {
          state: peer.state,
          advanced: peer.buffer.allocatedThrough !== allocatedBefore,
        };
      }
      // Include any predecessor whose post-commit hook was delayed. Per-thread seq makes this scan
      // commit-safe, and assigning the complete range under the peer mutex prevents overtaking.
      const rows = await this.database.db
        .select({
          messageId: message.id,
          threadId: message.threadId,
          messageSeq: message.seq,
        })
        .from(message)
        .where(
          and(
            eq(message.threadId, threadId),
            gt(message.seq, loaded),
            lte(message.seq, messageSeq),
            ne(message.contentType, ContentType.SYSTEM),
          ),
        )
        .orderBy(asc(message.seq))
        .limit(peer.buffer.capacity - peer.buffer.size);
      const candidates = rows.filter(
        (row) =>
          !peer.messageKeys.has(
            `${epoch.id.toString()}:${row.messageId.toString()}`,
          ),
      );
      const allocated = await this.allocate(peerDomain, candidates.length);
      for (let index = 0; index < candidates.length; index++) {
        const row = candidates[index];
        this.append(peer, {
          changeId: allocated.first + BigInt(index),
          epochId: epoch.id,
          threadId: row.threadId,
          messageId: row.messageId,
          messageSeq: row.messageSeq,
        });
      }
      const reached = rows.at(-1)?.messageSeq;
      if (reached !== undefined) peer.loadedThrough.set(epoch.id, reached);
      peer.state = peer.buffer.full
        ? FederationFeedFillState.FULL
        : reached === messageSeq
          ? FederationFeedFillState.CAUGHT_UP
          : FederationFeedFillState.NEEDS_FILL;
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
      .filter((entry) => entry.changeId <= through);
    const byEpoch = new Map<bigint, number>();
    for (const entry of acknowledged) {
      if (entry.epochId === 0n) continue;
      byEpoch.set(
        entry.epochId,
        Math.max(byEpoch.get(entry.epochId) ?? -1, entry.messageSeq),
      );
    }
    for (const [epochId, acknowledgedSeq] of byEpoch) {
      await tx
        .update(federationThreadCheckpoint)
        .set({
          acknowledgedSeq: sql`GREATEST(${federationThreadCheckpoint.acknowledgedSeq}, ${acknowledgedSeq})`,
          updatedAt: new Date(),
        })
        .where(eq(federationThreadCheckpoint.epochId, epochId));
    }
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
        loadedThrough: new Map(),
        state: FederationFeedFillState.NEEDS_FILL,
        initialized: false,
        resetGeneration: null,
      };
      this.peers.set(peerDomain, peer);
    }
    return peer;
  }

  private async fillInLock(
    peerDomain: string,
    peer: PeerMemoryFeed,
  ): Promise<FederationFeedFillState> {
    try {
      await this.refreshPeerGenerationInLock(peerDomain, peer);
      await this.initializeInLock(peerDomain, peer);
      if (peer.buffer.full) {
        peer.state = FederationFeedFillState.FULL;
        return peer.state;
      }
      peer.state = FederationFeedFillState.FILLING;
      await this.fillEpochsInLock(peerDomain, peer);
      peer.state = peer.buffer.full
        ? FederationFeedFillState.FULL
        : FederationFeedFillState.CAUGHT_UP;
      return peer.state;
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
    const epochs = await this.database.db
      .selectDistinct({ peerDomain: federationAudienceEpoch.peerDomain })
      .from(federationAudienceEpoch)
      .where(
        and(
          eq(federationAudienceEpoch.threadId, threadId),
          lte(federationAudienceEpoch.fromSeq, messageSeq),
          or(
            isNull(federationAudienceEpoch.throughSeq),
            sql`${federationAudienceEpoch.throughSeq} >= ${messageSeq}`,
          ),
        ),
      );
    await Promise.all(
      epochs.map(async ({ peerDomain }) => {
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
    peer.state = FederationFeedFillState.NEEDS_FILL;
    peer.initialized = false;
    peer.resetGeneration = null;
  }

  private async fillEpochsInLock(
    peerDomain: string,
    peer: PeerMemoryFeed,
  ): Promise<void> {
    const epochs = await this.database.db
      .select({
        id: federationAudienceEpoch.id,
        threadId: federationAudienceEpoch.threadId,
        fromSeq: federationAudienceEpoch.fromSeq,
        throughSeq: federationAudienceEpoch.throughSeq,
        acknowledgedSeq: federationThreadCheckpoint.acknowledgedSeq,
        currentSeq: messageThread.curSeq,
      })
      .from(federationAudienceEpoch)
      .innerJoin(
        federationThreadCheckpoint,
        eq(federationThreadCheckpoint.epochId, federationAudienceEpoch.id),
      )
      .innerJoin(
        messageThread,
        eq(messageThread.id, federationAudienceEpoch.threadId),
      )
      .where(eq(federationAudienceEpoch.peerDomain, peerDomain))
      .orderBy(asc(federationAudienceEpoch.id));

    for (const epoch of epochs) {
      if (peer.buffer.full) return;
      const loaded = peer.loadedThrough.get(epoch.id) ?? epoch.acknowledgedSeq;
      const upper = epoch.throughSeq ?? epoch.currentSeq;
      if (loaded >= upper) continue;
      const take = Math.min(
        FILL_QUERY_SIZE,
        peer.buffer.capacity - peer.buffer.size,
      );
      let cursor = loaded;
      while (cursor < upper && !peer.buffer.full) {
        const rows = await this.database.db
          .select({
            messageId: message.id,
            threadId: message.threadId,
            messageSeq: message.seq,
          })
          .from(message)
          .where(
            and(
              eq(message.threadId, epoch.threadId),
              gt(message.seq, cursor),
              lte(message.seq, upper),
              ne(message.contentType, ContentType.SYSTEM),
            ),
          )
          .orderBy(asc(message.seq))
          .limit(Math.min(take, peer.buffer.capacity - peer.buffer.size));
        if (rows.length === 0) {
          cursor = upper;
          peer.loadedThrough.set(epoch.id, upper);
          break;
        }
        const candidates = rows.filter(
          (row) =>
            !peer.messageKeys.has(
              `${epoch.id.toString()}:${row.messageId.toString()}`,
            ),
        );
        const allocated = await this.allocate(peerDomain, candidates.length);
        for (let index = 0; index < candidates.length; index++) {
          const row = candidates[index];
          this.append(peer, {
            changeId: allocated.first + BigInt(index),
            epochId: epoch.id,
            threadId: row.threadId,
            messageId: row.messageId,
            messageSeq: row.messageSeq,
          });
        }
        cursor = rows.at(-1)!.messageSeq;
        peer.loadedThrough.set(epoch.id, cursor);
      }
    }
  }

  private async allocate(
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
    return `${entry.epochId.toString()}:${entry.messageId.toString()}`;
  }
}
