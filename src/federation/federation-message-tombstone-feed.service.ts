import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  deletedMessage,
  federatedPeer,
  federationTombstoneFeedAllocation,
  federationTombstoneServeCursor,
  message,
  messageThread,
  user,
} from '../database/schema.js';
import type { MessageDeleteType } from '../database/enums.js';
import { FederationChangeBuffer } from './federation-change-buffer.js';
import {
  FEDERATION_MEMORY_FEED_CAPACITY,
  FederationFeedFillState,
  type FederationFeedFillQuantumResult,
  FederationMemoryFeedService,
} from './federation-memory-feed.service.js';
import { loadFederationConfig } from './federation.config.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const FILL_QUERY_SIZE = 500;
const RETRY_AFTER_MS = 100;

export interface FederationBufferedTombstone {
  feedId: bigint;
  deletionId: bigint;
  threadId: number;
  messageSeq: number;
}

export interface FederationMessageTombstoneItem {
  feedId: string;
  thread:
    | { type: 'GROUP'; account: string; domain: string }
    | {
        type: 'P2P';
        participants: Array<{ account: string; domain: string }>;
      };
  target: {
    creator: { account: string; domain: string };
    originSeq: number;
  };
  type: MessageDeleteType;
  deletedAt: number;
}

export interface FederationMessageTombstonePage {
  tombstones: FederationMessageTombstoneItem[];
  scannedThrough: string;
  hasMore: boolean;
  retryAfterMs?: number;
}

interface PeerTombstoneFeed {
  buffer: FederationChangeBuffer<FederationBufferedTombstone>;
  keys: Set<string>;
  state: FederationFeedFillState;
  initialized: boolean;
  resetGeneration: number | null;
}

@Injectable()
export class FederationMessageTombstoneFeedService {
  private readonly localDomain = loadFederationConfig().domain;
  private readonly peers = new Map<string, PeerTombstoneFeed>();

  constructor(
    private readonly database: DatabaseService,
    private readonly memoryFeed: FederationMemoryFeedService,
  ) {}

  async rejectMissingAfter(peerDomain: string): Promise<never> {
    const [cursor] = await this.database.db
      .select({
        retainedAfter: federationTombstoneServeCursor.retainedAfter,
        acknowledgedThrough: federationTombstoneServeCursor.acknowledgedThrough,
      })
      .from(federationTombstoneServeCursor)
      .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!cursor) throw new Error(`peer ${peerDomain} has no tombstone feed`);
    const resumeAfter =
      cursor.retainedAfter > cursor.acknowledgedThrough
        ? cursor.retainedAfter
        : cursor.acknowledgedThrough;
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; resume from the available tombstone cursor',
      HttpStatus.OK,
      { resumeAfter: resumeAfter.toString() },
    );
  }

  state(peerDomain: string): FederationFeedFillState {
    return this.peer(peerDomain).state;
  }

  fill(peerDomain: string): Promise<FederationFeedFillState> {
    return this.memoryFeed
      .runExclusive(
        peerDomain,
        async () => (await this.fillWhileLocked(peerDomain)).state,
      )
      .catch((error: unknown) => {
        this.peer(peerDomain).state = FederationFeedFillState.NEEDS_FILL;
        throw error;
      });
  }

  fillQuantum(
    peerDomain: string,
    maxWork: number,
  ): Promise<FederationFeedFillQuantumResult> {
    if (!Number.isInteger(maxWork) || maxWork < 0) {
      throw new Error('fill quantum must be a non-negative integer');
    }
    return this.memoryFeed
      .runExclusive(peerDomain, () => this.fillWhileLocked(peerDomain, maxWork))
      .catch((error: unknown) => {
        this.peer(peerDomain).state = FederationFeedFillState.NEEDS_FILL;
        throw error;
      });
  }

  async serve(
    peerDomain: string,
    after: bigint,
    requestedTake?: number,
    trunc?: bigint,
  ): Promise<FederationMessageTombstonePage> {
    const take = this.pageSize(requestedTake);
    if (trunc !== undefined && trunc < after) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'trunc must be greater than or equal to after',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.memoryFeed.runExclusive(peerDomain, async () => {
      await this.fillWhileLocked(peerDomain);
      const peer = this.peer(peerDomain);
      const result = await this.database.db.transaction(async (tx) => {
        const [cursor] = await tx
          .select()
          .from(federationTombstoneServeCursor)
          .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain))
          .for('update', { noWait: true })
          .limit(1);
        if (!cursor) {
          throw new BusinessException(
            BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
            'peer has no tombstone feed cursor',
            HttpStatus.UNAUTHORIZED,
          );
        }
        const availableCursor =
          cursor.retainedAfter > cursor.acknowledgedThrough
            ? cursor.retainedAfter
            : cursor.acknowledgedThrough;
        if (after < availableCursor) {
          throw new BusinessException(
            BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
            'requested tombstone cursor is below the retained floor',
            HttpStatus.OK,
            { resumeAfter: availableCursor.toString() },
          );
        }
        const validCursor =
          after === availableCursor ||
          after === cursor.acknowledgedThrough ||
          after === cursor.lastServedThrough;
        if (!validCursor || after > cursor.allocatedThrough) {
          throw new BusinessException(
            BusinessCode.FEDERATION_FEED_CURSOR_MISMATCH,
            'after is neither the confirmed nor last served tombstone cursor',
            HttpStatus.OK,
            {
              acknowledgedThrough: cursor.acknowledgedThrough.toString(),
              lastServedThrough: cursor.lastServedThrough.toString(),
            },
          );
        }
        const effectiveAfter = after;
        const retry =
          after === cursor.acknowledgedThrough &&
          cursor.lastServedThrough > cursor.acknowledgedThrough;
        const requestEnd = retry
          ? cursor.lastServedThrough
          : trunc === undefined || trunc > cursor.allocatedThrough
            ? cursor.allocatedThrough
            : trunc;
        const boundedEnd =
          requestEnd < effectiveAfter ? effectiveAfter : requestEnd;
        await this.acknowledgeInTx(tx, peerDomain, peer, effectiveAfter);
        const refs = peer.buffer
          .snapshot()
          .filter(
            (entry) =>
              entry.feedId > effectiveAfter && entry.feedId <= boundedEnd,
          )
          .slice(0, take);
        const scannedThrough =
          refs.length === take ? refs.at(-1)!.feedId : boundedEnd;
        const tombstones = await this.serializeInTx(tx, refs);
        await tx
          .update(federationTombstoneServeCursor)
          .set({
            acknowledgedThrough: retry
              ? cursor.acknowledgedThrough
              : effectiveAfter,
            lastServedThrough: scannedThrough,
            updatedAt: new Date(),
          })
          .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain));
        const page: FederationMessageTombstonePage = {
          tombstones,
          scannedThrough: scannedThrough.toString(),
          hasMore: scannedThrough < boundedEnd,
        };
        return {
          page,
          acknowledgedThrough: effectiveAfter,
        };
      });
      this.retireWhileLocked(peer, result.acknowledgedThrough);
      if (!peer.buffer.full) await this.fillWhileLocked(peerDomain);
      const allocatedThrough = await this.readAllocatedThrough(peerDomain);
      if (
        BigInt(result.page.scannedThrough) <
          (trunc === undefined || trunc > allocatedThrough
            ? allocatedThrough
            : trunc) ||
        peer.state === FederationFeedFillState.NEEDS_FILL ||
        peer.state === FederationFeedFillState.FILLING
      ) {
        result.page.hasMore = true;
      }
      if (
        result.page.hasMore &&
        result.page.tombstones.length === 0 &&
        BigInt(result.page.scannedThrough) === after
      ) {
        result.page.retryAfterMs = RETRY_AFTER_MS;
      }
      return result.page;
    });
  }

  private async fillWhileLocked(
    peerDomain: string,
    maxWork = Number.MAX_SAFE_INTEGER,
  ): Promise<FederationFeedFillQuantumResult> {
    const peer = this.peer(peerDomain);
    try {
      await this.refreshGeneration(peerDomain, peer);
      if (peer.buffer.full) {
        peer.state = FederationFeedFillState.FULL;
        return { state: peer.state, work: 0 };
      }
      if (maxWork === 0) return { state: peer.state, work: 0 };
      peer.state = FederationFeedFillState.FILLING;
      let work = 0;
      let hasMore = false;
      for (;;) {
        if (peer.buffer.full || work >= maxWork) {
          hasMore = true;
          break;
        }
        const [cursor] = await this.database.db
          .select({
            sourceScannedThrough:
              federationTombstoneServeCursor.sourceScannedThrough,
          })
          .from(federationTombstoneServeCursor)
          .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain))
          .limit(1);
        if (!cursor) throw new Error(`peer ${peerDomain} has no allocator`);
        const take = Math.min(
          FILL_QUERY_SIZE,
          peer.buffer.capacity - peer.buffer.size,
          maxWork - work,
        );
        const rows = await this.database.db.execute<{
          deletionId: string;
          threadId: number;
          messageSeq: number;
          eligible: boolean;
          waitingForMessageScan: boolean;
        }>(sql`
          SELECT deleted.id::text AS "deletionId",
                 deleted."threadId" AS "threadId",
                 deleted.seq AS "messageSeq",
                 (
                   deleted."federationSourceDomain" IS NULL
                   AND (
                     (thread.type = 'P2P' AND creator."isForeigner" = false)
                     OR (
                       thread.type = 'GROUP'
                       AND (
                         group_user.domain = 'local'
                         OR (creator."isForeigner" = false AND target."originSeq" IS NULL)
                       )
                     )
                   )
                   AND EXISTS (
                     SELECT 1 FROM "FederationMessageDelivery" delivery
                     WHERE delivery."peerDomain" = ${peerDomain}
                       AND delivery."messageId" = target.id
                   )
                 ) AS eligible,
                 (
                   deleted."federationSourceDomain" IS NULL
                   AND (
                     (thread.type = 'P2P' AND creator."isForeigner" = false)
                     OR (
                       thread.type = 'GROUP'
                       AND (
                         group_user.domain = 'local'
                         OR (creator."isForeigner" = false AND target."originSeq" IS NULL)
                       )
                     )
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM "FederationMessageDelivery" delivery
                     WHERE delivery."peerDomain" = ${peerDomain}
                       AND delivery."messageId" = target.id
                   )
                   AND EXISTS (
                     SELECT 1 FROM "ThreadAudience" audience
                     WHERE audience."targetDomain" = ${peerDomain}
                       AND audience."localUserId" IS NULL
                       AND audience."threadId" = deleted."threadId"
                       AND audience."deliverThroughChangeId" IS NULL
                       AND audience."messageScannedThroughSeq" < deleted.seq
                   )
                 ) AS "waitingForMessageScan"
          FROM "DeletedMessage" deleted
          JOIN "Message" target
            ON target."threadId" = deleted."threadId" AND target.seq = deleted.seq
          JOIN "MessageThread" thread ON thread.id = deleted."threadId"
          JOIN "User" creator ON creator.id = target.creator
          LEFT JOIN "User" group_user ON group_user.id = thread."groupUserId"
          WHERE deleted.id > ${cursor.sourceScannedThrough}
          ORDER BY deleted.id
          LIMIT ${take}
        `);
        work += Math.max(rows.rows.length, 1);
        if (rows.rows.length === 0) break;
        const waitingIndex = rows.rows.findIndex(
          (row) => row.waitingForMessageScan,
        );
        const settledRows =
          waitingIndex < 0 ? rows.rows : rows.rows.slice(0, waitingIndex);
        if (settledRows.length === 0) {
          hasMore = true;
          break;
        }
        const candidates = settledRows
          .filter(
            (row) => row.eligible && !peer.keys.has(row.deletionId),
          )
          .map((row) => ({
            deletionId: BigInt(row.deletionId),
            threadId: row.threadId,
            messageSeq: row.messageSeq,
          }));
        const allocated = await this.allocateWhileLocked(
          peerDomain,
          BigInt(settledRows.at(-1)!.deletionId),
          candidates,
        );
        allocated.forEach((entry) => {
          if (peer.buffer.append(entry))
            peer.keys.add(entry.deletionId.toString());
        });
        if (waitingIndex >= 0) {
          hasMore = true;
          break;
        }
        if (rows.rows.length < take) break;
      }
      peer.state = peer.buffer.full
        ? FederationFeedFillState.FULL
        : hasMore
          ? FederationFeedFillState.NEEDS_FILL
          : FederationFeedFillState.CAUGHT_UP;
      return { state: peer.state, work };
    } catch (error) {
      peer.state = FederationFeedFillState.NEEDS_FILL;
      throw error;
    }
  }

  private async acknowledgeInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    _peer: PeerTombstoneFeed,
    through: bigint,
  ): Promise<void> {
    await tx
      .delete(federationTombstoneFeedAllocation)
      .where(
        and(
          eq(federationTombstoneFeedAllocation.peerDomain, peerDomain),
          sql`${federationTombstoneFeedAllocation.feedId} <= ${through}`,
        ),
      );
  }

  private async serializeInTx(
    tx: DatabaseTransaction,
    refs: FederationBufferedTombstone[],
  ): Promise<FederationMessageTombstoneItem[]> {
    const result: FederationMessageTombstoneItem[] = [];
    for (const ref of refs) {
      const [row] = await tx
        .select({
          type: deletedMessage.type,
          localDeletedAt: deletedMessage.createdAt,
          originSeq: message.originSeq,
          seq: message.seq,
          creatorId: message.creator,
          creatorAccount: user.account,
          creatorDomain: user.domain,
          creatorForeigner: user.isForeigner,
          threadType: messageThread.type,
          groupUserId: messageThread.groupUserId,
        })
        .from(deletedMessage)
        .innerJoin(
          message,
          and(
            eq(message.threadId, deletedMessage.threadId),
            eq(message.seq, deletedMessage.seq),
          ),
        )
        .innerJoin(user, eq(user.id, message.creator))
        .innerJoin(messageThread, eq(messageThread.id, message.threadId))
        .where(eq(deletedMessage.id, ref.deletionId))
        .limit(1);
      if (!row) {
        throw new Error(
          `buffered tombstone ${ref.deletionId.toString()} is missing`,
        );
      }
      const creator = {
        account: row.creatorAccount,
        domain: row.creatorForeigner ? row.creatorDomain : this.localDomain,
      };
      let thread: FederationMessageTombstoneItem['thread'];
      if (row.threadType === 'GROUP') {
        const group = await tx.query.user.findFirst({
          where: eq(user.id, row.groupUserId!),
          columns: { account: true, domain: true },
        });
        if (!group) {
          throw new Error(`group identity missing for thread ${ref.threadId}`);
        }
        thread = {
          type: 'GROUP',
          account: group.account,
          domain: group.domain === 'local' ? this.localDomain : group.domain,
        };
      } else {
        const participants = await tx.execute<{
          account: string;
          domain: string;
          isForeigner: boolean;
        }>(sql`
          SELECT member.account, member.domain, member."isForeigner"
          FROM "ThreadParticipant" participant
          JOIN "User" member ON member.id = participant."userId"
          WHERE participant."threadId" = ${ref.threadId}
          ORDER BY member.id
        `);
        thread = {
          type: 'P2P',
          participants: participants.rows.map((participant) => ({
            account: participant.account,
            domain: participant.isForeigner
              ? participant.domain
              : this.localDomain,
          })),
        };
      }
      result.push({
        feedId: ref.feedId.toString(),
        thread,
        target: { creator, originSeq: row.originSeq ?? row.seq },
        type: row.type,
        deletedAt: row.localDeletedAt.getTime(),
      });
    }
    return result;
  }

  private retireWhileLocked(peer: PeerTombstoneFeed, through: bigint): void {
    for (const entry of peer.buffer.retireThrough(through)) {
      peer.keys.delete(entry.deletionId.toString());
    }
    if (peer.state === FederationFeedFillState.FULL) {
      peer.state = FederationFeedFillState.NEEDS_FILL;
    }
  }

  private peer(peerDomain: string): PeerTombstoneFeed {
    let peer = this.peers.get(peerDomain);
    if (!peer) {
      peer = {
        buffer: new FederationChangeBuffer(FEDERATION_MEMORY_FEED_CAPACITY),
        keys: new Set(),
        state: FederationFeedFillState.NEEDS_FILL,
        initialized: false,
        resetGeneration: null,
      };
      this.peers.set(peerDomain, peer);
    }
    return peer;
  }

  private async refreshGeneration(
    peerDomain: string,
    peer: PeerTombstoneFeed,
  ): Promise<void> {
    const [current] = await this.database.db
      .select({ resetGeneration: federatedPeer.resetGeneration })
      .from(federatedPeer)
      .where(eq(federatedPeer.domain, peerDomain))
      .limit(1);
    if (!current) throw new Error(`peer ${peerDomain} is not recognized`);
    if (peer.initialized && peer.resetGeneration === current.resetGeneration) {
      return;
    }
    peer.buffer.clear();
    peer.keys.clear();
    peer.resetGeneration = current.resetGeneration;
    const allocations = await this.database.db
      .select()
      .from(federationTombstoneFeedAllocation)
      .where(eq(federationTombstoneFeedAllocation.peerDomain, peerDomain))
      .orderBy(asc(federationTombstoneFeedAllocation.feedId))
      .limit(peer.buffer.capacity);
    for (const allocation of allocations) {
      const entry: FederationBufferedTombstone = {
        feedId: allocation.feedId,
        deletionId: allocation.deletionId,
        threadId: allocation.threadId,
        messageSeq: allocation.messageSeq,
      };
      if (!peer.buffer.append(entry)) break;
      peer.keys.add(entry.deletionId.toString());
    }
    peer.initialized = true;
  }

  async readAllocatedThrough(peerDomain: string): Promise<bigint> {
    const [row] = await this.database.db
      .select({
        allocatedThrough: federationTombstoneServeCursor.allocatedThrough,
      })
      .from(federationTombstoneServeCursor)
      .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!row) throw new Error(`peer ${peerDomain} has no allocator`);
    return row.allocatedThrough;
  }

  private async allocateWhileLocked(
    peerDomain: string,
    sourceScannedThrough: bigint,
    candidates: ReadonlyArray<{
      deletionId: bigint;
      threadId: number;
      messageSeq: number;
    }>,
  ): Promise<
    Array<{
      feedId: bigint;
      deletionId: bigint;
      threadId: number;
      messageSeq: number;
    }>
  > {
    return this.database.db.transaction(async (tx) => {
      const [allocated] = await tx
        .update(federationTombstoneServeCursor)
        .set({
          allocatedThrough: sql`${federationTombstoneServeCursor.allocatedThrough} + ${candidates.length}`,
          sourceScannedThrough,
          updatedAt: new Date(),
        })
        .where(eq(federationTombstoneServeCursor.peerDomain, peerDomain))
        .returning({
          allocatedThrough: federationTombstoneServeCursor.allocatedThrough,
        });
      if (!allocated) throw new Error(`peer ${peerDomain} has no allocator`);
      const first = allocated.allocatedThrough - BigInt(candidates.length) + 1n;
      const rows = candidates.map((candidate, index) => ({
        ...candidate,
        feedId: first + BigInt(index),
      }));
      if (rows.length > 0)
        await tx.insert(federationTombstoneFeedAllocation).values(
          rows.map((row) => ({
            peerDomain,
            feedId: row.feedId,
            deletionId: row.deletionId,
            threadId: row.threadId,
            messageSeq: row.messageSeq,
          })),
        );
      return rows;
    });
  }

  private pageSize(requested?: number): number {
    if (requested === undefined) return DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'take must be a positive safe integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    return Math.min(requested, MAX_PAGE_SIZE);
  }
}
