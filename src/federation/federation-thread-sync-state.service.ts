import { Injectable } from '@nestjs/common';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../common/locks/thread-content-lock.js';
import { and, eq, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  federationThreadHistoryGap,
  federationThreadSyncState,
  messageThread,
} from '../database/schema.js';
import { FEDERATION_THREAD_SEQUENCE_MAX } from './federation-thread-round.constants.js';
import { FederationThreadRoundAuthorizationEpochChangedError } from './federation-thread-round-error.js';
import { initializeHistoryReadPositionInTx } from '../message/thread-read-position.service.js';
import { eligiblePreviewOwnerSql } from '../message/thread-preview-eligibility.js';
import { resolvePublisherCoverageInTx } from './federation-message-anchor.js';
import { calculatePublisherReservationOffset } from './federation-message-sequence-policy.js';
import { readAuthorizedSourceHeadInTx } from './federation-authorized-source-head.js';

export interface FederationReverseWindow {
  authorizationEpoch: number;
  gapId: bigint;
  beforeSeq: number;
  throughSeq: number;
  messageSeqOffset: number;
}

@Injectable()
export class FederationThreadSyncStateService {
  constructor(private readonly database: DatabaseService) {}

  static async lockAuthorizationEpochInTx(
    tx: DatabaseTransaction,
    threadId: number,
    authorizationEpoch: number,
  ): Promise<ThreadContentLock> {
    const threadLock = await requireThreadContentLockInTx(tx, threadId);
    const locked = await tx.execute(sql`
      UPDATE "MessageThread"
      SET "authorizationEpoch" = "authorizationEpoch"
      WHERE id = ${threadId}
        AND "authorizationEpoch" = ${authorizationEpoch}
      RETURNING "authorizationEpoch"
    `);
    if ((locked.rows ?? []).length === 0) {
      throw new FederationThreadRoundAuthorizationEpochChangedError();
    }
    return threadLock;
  }

  /** Content advertisements advance an existing authorization, never initialize it. */
  static async updateThreadHeadInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      namespaceId: number;
      messageTargetSeq: number;
      deletionTargetSeq: number;
      threadLock: ThreadContentLock;
    },
  ): Promise<boolean> {
    this.assertCoordinate(params.messageTargetSeq, 'message target seq');
    this.assertCoordinate(params.deletionTargetSeq, 'deletion target seq');
    await requireThreadContentLockInTx(tx, params.threadId, params.threadLock);
    const result = await tx.execute(sql`
      UPDATE "FederationThreadSyncState" state
      SET "messageTargetSeq" = GREATEST(state."messageTargetSeq", ${params.messageTargetSeq}),
        "deletionTargetSeq" = GREATEST(state."deletionTargetSeq", ${params.deletionTargetSeq}),
        "updatedAt" = CURRENT_TIMESTAMP
      FROM "MessageThread" thread
      WHERE state."threadId" = ${params.threadId}
        AND state."namespaceId" = ${params.namespaceId}
        AND thread.id = state."threadId"
        AND state."authorizationEpoch" = thread."authorizationEpoch"
      RETURNING state."threadId"
    `);
    return result.rows.length > 0;
  }

  static async reconcileRelationshipAuthorizationInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      namespaceId: number;
      messageTargetSeq: number;
      deletionTargetSeq: number;
      reverseEnabled: boolean;
      threadLock?: ThreadContentLock;
    },
  ): Promise<{
    created: boolean;
    epochChanged: boolean;
    reverseRequired: boolean;
  }> {
    this.assertCoordinate(params.messageTargetSeq, 'message target seq');
    this.assertCoordinate(params.deletionTargetSeq, 'deletion target seq');
    const threadLock = await requireThreadContentLockInTx(
      tx,
      params.threadId,
      params.threadLock,
    );

    const [thread] = await tx
      .select({
        authorizationEpoch: messageThread.authorizationEpoch,
        curSeq: messageThread.curSeq,
      })
      .from(messageThread)
      .where(eq(messageThread.id, params.threadId))
      .limit(1);
    if (!thread) throw new Error('federation synchronization thread missing');

    const stateResult = await tx.execute<{
      messageTargetSeq: number;
      messageProcessedThroughSeq: number;
      deletionProcessedThroughSeq: number;
      deletionTargetSeq: number;
      authorizationEpoch: number;
    }>(sql`
      SELECT "messageTargetSeq", "messageProcessedThroughSeq",
        "deletionTargetSeq", "deletionProcessedThroughSeq",
        "authorizationEpoch"
      FROM "FederationThreadSyncState"
      WHERE "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
      FOR NO KEY UPDATE
    `);
    const state = stateResult.rows[0];
    if (!state) {
      const reverseEndSeq = params.messageTargetSeq;
      let reverseRequired = false;
      if (params.reverseEnabled && reverseEndSeq >= 1) {
        const messageSeqOffset = calculatePublisherReservationOffset({
          firstOriginSeq: 1,
          curSeq: thread.curSeq,
        });
        await tx.insert(federationThreadHistoryGap).values({
          threadId: params.threadId,
          namespaceId: params.namespaceId,
          startSeq: 1,
          endSeq: reverseEndSeq,
          messageSeqOffset,
          recoverable: true,
          updatedAt: new Date(),
        });
        await this.reserveReverseSequenceRangeInTx(
          tx,
          params.threadId,
          reverseEndSeq,
          messageSeqOffset,
        );
        await this.initializeHistoryReadPositionsInTx(
          tx,
          threadLock,
          params.threadId,
          reverseEndSeq + messageSeqOffset,
        );
        reverseRequired = true;
      }
      await tx.insert(federationThreadSyncState).values({
        threadId: params.threadId,
        namespaceId: params.namespaceId,
        messageTargetSeq: params.messageTargetSeq,
        deletionTargetSeq: params.deletionTargetSeq,
        // Reverse timelines keep this at 0; forward member submissions advance it.
        messageProcessedThroughSeq: 0,
        // Only applied deletion facts advance this cursor.
        deletionProcessedThroughSeq: 0,
        authorizationEpoch: thread.authorizationEpoch,
        updatedAt: new Date(),
      });
      return {
        created: true,
        epochChanged: false,
        reverseRequired,
      };
    }

    if (state.authorizationEpoch === thread.authorizationEpoch) {
      await tx
        .update(federationThreadSyncState)
        .set({
          messageTargetSeq: sql`GREATEST(${federationThreadSyncState.messageTargetSeq}, ${params.messageTargetSeq})`,
          deletionTargetSeq: sql`GREATEST(${federationThreadSyncState.deletionTargetSeq}, ${params.deletionTargetSeq})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(federationThreadSyncState.threadId, params.threadId),
            eq(federationThreadSyncState.namespaceId, params.namespaceId),
          ),
        );
      return {
        created: false,
        epochChanged: false,
        reverseRequired: false,
      };
    }

    const nextMessageTargetSeq = Math.max(
      state.messageTargetSeq,
      params.messageTargetSeq,
    );
    const nextDeletionTargetSeq = Math.max(
      state.deletionTargetSeq,
      params.deletionTargetSeq,
    );
    let reverseRequired = false;
    const obsoleteGapIds: bigint[] = [];
    let historyReadBoundary: number | null = null;
    let newGapMessageSeqOffset: number | null = null;
    if (params.reverseEnabled) {
      const { coveredThroughSeq } = await resolvePublisherCoverageInTx(
        threadLock,
        params.namespaceId,
      );
      const newGapStartSeq = coveredThroughSeq + 1;
      const newGapEndSeq = nextMessageTargetSeq;
      if (newGapStartSeq <= newGapEndSeq) {
        const overlaps = await tx.execute<{
          id: string;
          startSeq: number;
          endSeq: number;
          messageSeqOffset: number;
        }>(sql`
          SELECT id, "startSeq", "endSeq", "messageSeqOffset"
          FROM "FederationThreadHistoryGap"
          WHERE "threadId" = ${params.threadId}
            AND "namespaceId" = ${params.namespaceId}
            AND recoverable = true
            AND "startSeq"::bigint <= ${newGapEndSeq}::bigint + 1
            AND "endSeq"::bigint + 1 >= ${newGapStartSeq}
          FOR UPDATE
        `);
        const messageSeqOffset = calculatePublisherReservationOffset({
          firstOriginSeq: newGapStartSeq,
          curSeq: thread.curSeq,
        });
        this.assertOffset(messageSeqOffset);
        newGapMessageSeqOffset = messageSeqOffset;
        const conflictingOverlap = overlaps.rows.find(
          (gap) =>
            gap.messageSeqOffset !== messageSeqOffset &&
            gap.startSeq <= newGapEndSeq &&
            gap.endSeq >= newGapStartSeq,
        );
        if (conflictingOverlap) {
          throw new Error(
            'overlapping federation history gaps have different message seq offsets',
          );
        }
        const mergeable = overlaps.rows.filter(
          (gap) => gap.messageSeqOffset === messageSeqOffset,
        );
        const mergedStartSeq = Math.min(
          newGapStartSeq,
          ...mergeable.map((gap) => gap.startSeq),
        );
        const mergedEndSeq = Math.max(
          newGapEndSeq,
          ...mergeable.map((gap) => gap.endSeq),
        );
        historyReadBoundary = mergedEndSeq + messageSeqOffset;
        const exact = mergeable.find(
          (gap) =>
            gap.startSeq === mergedStartSeq && gap.endSeq === mergedEndSeq,
        );
        let keptGapId: bigint;
        if (exact) {
          keptGapId = BigInt(exact.id);
        } else {
          const [merged] = await tx
            .insert(federationThreadHistoryGap)
            .values({
              threadId: params.threadId,
              namespaceId: params.namespaceId,
              startSeq: mergedStartSeq,
              endSeq: mergedEndSeq,
              messageSeqOffset,
              recoverable: true,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                federationThreadHistoryGap.threadId,
                federationThreadHistoryGap.namespaceId,
                federationThreadHistoryGap.startSeq,
                federationThreadHistoryGap.endSeq,
              ],
              set: { recoverable: true, updatedAt: new Date() },
            })
            .returning({ id: federationThreadHistoryGap.id });
          keptGapId = merged.id;
        }
        obsoleteGapIds.push(
          ...mergeable
            .map((gap) => BigInt(gap.id))
            .filter((id) => id !== keptGapId),
        );
        reverseRequired = true;
      } else {
        const [latestGap] = await tx
          .select({ id: federationThreadHistoryGap.id })
          .from(federationThreadHistoryGap)
          .where(
            and(
              eq(federationThreadHistoryGap.threadId, params.threadId),
              eq(federationThreadHistoryGap.namespaceId, params.namespaceId),
              eq(federationThreadHistoryGap.recoverable, true),
            ),
          )
          .limit(1);
        reverseRequired = latestGap !== undefined;
      }
    }

    const [updated] = await tx
      .update(federationThreadSyncState)
      .set({
        messageTargetSeq: nextMessageTargetSeq,
        deletionTargetSeq: nextDeletionTargetSeq,
        authorizationEpoch: thread.authorizationEpoch,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(federationThreadSyncState.threadId, params.threadId),
          eq(federationThreadSyncState.namespaceId, params.namespaceId),
          eq(
            federationThreadSyncState.authorizationEpoch,
            state.authorizationEpoch,
          ),
        ),
      )
      .returning({ threadId: federationThreadSyncState.threadId });
    if (!updated) {
      throw new Error('federation synchronization epoch changed');
    }
    if (newGapMessageSeqOffset !== null) {
      await this.reserveReverseSequenceRangeInTx(
        tx,
        params.threadId,
        nextMessageTargetSeq,
        newGapMessageSeqOffset,
      );
    }
    if (obsoleteGapIds.length > 0) {
      await tx.execute(sql`
        DELETE FROM "FederationThreadHistoryGap"
        WHERE "threadId" = ${params.threadId}
          AND "namespaceId" = ${params.namespaceId}
          AND id IN (${sql.join(
            obsoleteGapIds.map((id) => sql`${id}`),
            sql`, `,
          )})
      `);
    }
    if (historyReadBoundary !== null) {
      await this.initializeHistoryReadPositionsInTx(
        tx,
        threadLock,
        params.threadId,
        historyReadBoundary,
      );
    }
    return {
      created: false,
      epochChanged: true,
      reverseRequired,
    };
  }

  /** The caller has reserved this window's local starting position under the
   * content lock. Do not derive initialization from whichever gap is rightmost. */
  private static async initializeHistoryReadPositionsInTx(
    tx: DatabaseTransaction,
    threadLock: ThreadContentLock,
    threadId: number,
    initialReadSeq: number,
  ): Promise<void> {
    this.assertCoordinate(initialReadSeq, 'initial local read seq');
    const owners = await tx.execute<{
      accountId: number;
      initialReadSeq: number;
    }>(sql`
      SELECT s."accountId",
        LEAST(${initialReadSeq}, COALESCE(s."messageVisibleThroughSeq", ${initialReadSeq}))::integer AS "initialReadSeq"
      FROM "AccountThreadState" s
      JOIN "Account" a ON a.id = s."accountId"
      JOIN "MessageThread" t ON t.id = s."threadId"
      WHERE t.id = ${threadId}
        AND ${eligiblePreviewOwnerSql(sql`s`, sql`t`, sql`a`)}
      ORDER BY s."accountId"
      FOR NO KEY UPDATE OF s`);
    for (const owner of owners.rows) {
      await initializeHistoryReadPositionInTx(
        tx,
        threadLock,
        owner.accountId,
        owner.initialReadSeq,
      );
    }
  }

  static async advanceMessageProcessedThroughInTx(
    tx: DatabaseTransaction,
    threadId: number,
    processedThroughSeq: number,
    frozenTargetSeq: number,
    namespaceId: number,
    threadLock?: ThreadContentLock,
  ): Promise<void> {
    await requireThreadContentLockInTx(tx, threadId, threadLock);
    this.assertProcessedAdvance(
      processedThroughSeq,
      frozenTargetSeq,
      'message',
    );
    const [updated] = await tx
      .update(federationThreadSyncState)
      .set({
        messageProcessedThroughSeq: sql`GREATEST(${federationThreadSyncState.messageProcessedThroughSeq}, ${processedThroughSeq})`,
        updatedAt: new Date(),
      })
      .where(
        sql`${federationThreadSyncState.threadId} = ${threadId}
          AND ${federationThreadSyncState.namespaceId} = ${namespaceId}
          AND ${federationThreadSyncState.messageTargetSeq} >= ${frozenTargetSeq}`,
      )
      .returning({ threadId: federationThreadSyncState.threadId });
    if (!updated) {
      throw new Error(
        `federated mirror thread ${threadId} has no message target for this round`,
      );
    }
  }

  static async advanceDeletionProcessedThroughInTx(
    tx: DatabaseTransaction,
    threadId: number,
    processedThroughSeq: number,
    frozenTargetSeq: number,
    namespaceId: number,
    threadLock?: ThreadContentLock,
  ): Promise<void> {
    await requireThreadContentLockInTx(tx, threadId, threadLock);
    this.assertProcessedAdvance(
      processedThroughSeq,
      frozenTargetSeq,
      'deletion',
    );
    const [updated] = await tx
      .update(federationThreadSyncState)
      .set({
        deletionProcessedThroughSeq: sql`GREATEST(${federationThreadSyncState.deletionProcessedThroughSeq}, ${processedThroughSeq})`,
        updatedAt: new Date(),
      })
      .where(
        sql`${federationThreadSyncState.threadId} = ${threadId}
          AND ${federationThreadSyncState.namespaceId} = ${namespaceId}
          AND ${federationThreadSyncState.deletionTargetSeq} >= ${frozenTargetSeq}`,
      )
      .returning({ threadId: federationThreadSyncState.threadId });
    if (!updated) {
      throw new Error(
        `federated mirror thread ${threadId} has no deletion target for this round`,
      );
    }
  }

  async require(threadId: number, namespaceId: number) {
    const state =
      await this.database.db.query.federationThreadSyncState.findFirst({
        where: and(
          eq(federationThreadSyncState.threadId, threadId),
          eq(federationThreadSyncState.namespaceId, namespaceId),
        ),
      });
    if (!state) {
      throw new Error(
        `federated thread ${threadId} has no synchronization state`,
      );
    }
    return state;
  }

  /** Read the publisher's hop coordinate, never the reserved local sequence head. */
  async readCurrentMessageSeq(
    threadId: number,
    namespaceId: number,
  ): Promise<number> {
    const result = await this.database.db.execute<{ seq: number }>(sql`
      SELECT COALESCE(MAX(message."originSeq"), 0)::integer AS seq
      FROM "Message" message
      JOIN "MessageThread" thread ON thread.id = message."threadId"
      WHERE message."threadId" = ${threadId}
        AND (message."publisherNamespaceId" = ${namespaceId}
          OR (message."publisherNamespaceId" = 0
            AND message."originServerTime" IS NOT NULL
            AND (thread."authorityNamespaceId" = ${namespaceId}
              OR (thread.type = 'P2P' AND EXISTS (
                SELECT 1 FROM "RelationshipPair" pair
                WHERE pair."threadId" = thread.id AND pair.kind = 'P2P'
                  AND pair."endpointBNamespaceId" = ${namespaceId}
              )))))
    `);
    return result.rows[0]?.seq ?? 0;
  }

  /** Align one remote source from the retained authorization snapshot.
   * Relationship activation and each message round share this initialization. */
  static async prepareMessageRoundInTx(
    tx: DatabaseTransaction,
    threadId: number,
    namespaceId: number,
    held?: ThreadContentLock,
  ): Promise<void> {
    if (namespaceId <= 0) return;
    const threadLock = await requireThreadContentLockInTx(tx, threadId, held);
    const head = await readAuthorizedSourceHeadInTx(threadLock, namespaceId);
    if (!head) return;
    await this.reconcileRelationshipAuthorizationInTx(tx, {
      threadId,
      namespaceId,
      messageTargetSeq: head.messageEndSeq,
      deletionTargetSeq: head.tombstoneEndSeq,
      reverseEnabled: head.reverseEnabled,
      threadLock,
    });
  }

  async prepareMessageRound(
    threadId: number,
    namespaceId: number,
  ): Promise<void> {
    await this.database.db.transaction((tx) =>
      FederationThreadSyncStateService.prepareMessageRoundInTx(
        tx,
        threadId,
        namespaceId,
      ),
    );
  }

  /** Turn newly advertised ordinary messages into reserved reverse slots. */
  async reserveReverseTail(
    threadId: number,
    namespaceId: number,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const threadLock = await requireThreadContentLockInTx(tx, threadId);
      const result = await tx.execute<{
        messageTargetSeq: number;
        curSeq: number;
        type: 'P2P' | 'GROUP';
        authorityNamespaceId: number;
      }>(sql`
        SELECT state."messageTargetSeq",
          thread."curSeq", thread.type, thread."authorityNamespaceId"
        FROM "FederationThreadSyncState" state
        JOIN "MessageThread" thread ON thread.id = state."threadId"
        WHERE state."threadId" = ${threadId} AND state."namespaceId" = ${namespaceId}
          AND state."authorizationEpoch" = thread."authorizationEpoch"
        FOR NO KEY UPDATE OF state
      `);
      const state = result.rows[0];
      if (!state)
        throw new FederationThreadRoundAuthorizationEpochChangedError();
      if (state.type === 'GROUP' && state.authorityNamespaceId === 0)
        throw new Error(
          'member submission streams cannot reserve reverse gaps',
        );
      const { coveredThroughSeq } = await resolvePublisherCoverageInTx(
        threadLock,
        namespaceId,
      );
      const startSeq = coveredThroughSeq + 1;
      const endSeq = state.messageTargetSeq;
      if (startSeq > endSeq) return;
      const messageSeqOffset = calculatePublisherReservationOffset({
        firstOriginSeq: startSeq,
        curSeq: state.curSeq,
      });
      // Merge only an adjacent gap with the same mapping. Local messages between
      // reservations require distinct offsets and therefore distinct intervals.
      const adjacent = await tx.execute<{ id: string; startSeq: number }>(sql`
        SELECT id, "startSeq" FROM "FederationThreadHistoryGap"
        WHERE "threadId" = ${threadId} AND "namespaceId" = ${namespaceId}
          AND recoverable = true AND "endSeq" = ${startSeq - 1}
          AND "messageSeqOffset" = ${messageSeqOffset}
        FOR NO KEY UPDATE
      `);
      const previous = adjacent.rows[0];
      if (previous) {
        await tx
          .update(federationThreadHistoryGap)
          .set({ endSeq, updatedAt: new Date() })
          .where(eq(federationThreadHistoryGap.id, BigInt(previous.id)));
      } else {
        await tx.insert(federationThreadHistoryGap).values({
          threadId,
          namespaceId,
          startSeq,
          endSeq,
          messageSeqOffset,
          recoverable: true,
          updatedAt: new Date(),
        });
      }
      await FederationThreadSyncStateService.reserveReverseSequenceRangeInTx(
        tx,
        threadId,
        endSeq,
        messageSeqOffset,
      );
    });
  }

  /** Select request bounds from remaining gaps without persisting scheduling state. */
  async resolveReverseWindow(
    threadId: number,
    namespaceId: number,
  ): Promise<FederationReverseWindow | null> {
    const result = await this.database.db.execute<{
      authorizationEpoch: number;
      gapId: string;
      startSeq: number;
      endSeq: number;
      messageSeqOffset: number;
    }>(sql`
      SELECT thread."authorizationEpoch", gap.id::text AS "gapId",
        gap."startSeq", gap."endSeq", gap."messageSeqOffset"
      FROM "FederationThreadHistoryGap" gap
      JOIN "MessageThread" thread ON thread.id = gap."threadId"
      WHERE gap."threadId" = ${threadId} AND gap."namespaceId" = ${namespaceId}
        AND gap.recoverable = true
      ORDER BY gap."endSeq" DESC, gap.id DESC
      LIMIT 1
    `);
    const gap = result.rows[0];
    if (!gap) return null;
    const gapId = BigInt(gap.gapId);
    const beforeSeq = gap.endSeq + 1;
    FederationThreadSyncStateService.assertBeforeCursor(
      beforeSeq,
      'reverse upper boundary',
    );

    return {
      authorizationEpoch: gap.authorizationEpoch,
      gapId,
      beforeSeq,
      throughSeq: gap.startSeq,
      messageSeqOffset: gap.messageSeqOffset,
    };
  }

  static async commitReverseBatchInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      namespaceId: number;
      authorizationEpoch: number;
      gapId: bigint;
      beforeSeq: number;
      scannedThrough: number;
      throughSeq: number;
      closesGap: boolean;
      writeMessages: (threadLock: ThreadContentLock) => Promise<void>;
    },
  ): Promise<number> {
    const threadLock = await requireThreadContentLockInTx(tx, params.threadId);
    const epoch = await tx.execute<{ authorizationEpoch: number }>(sql`
      UPDATE "MessageThread"
      SET "authorizationEpoch" = "authorizationEpoch"
      WHERE id = ${params.threadId}
        AND "authorizationEpoch" = ${params.authorizationEpoch}
      RETURNING "authorizationEpoch"
    `);
    if (!epoch.rows[0])
      throw new FederationThreadRoundAuthorizationEpochChangedError();

    // This transaction may physically delete the completed gap, so acquire
    // its deletion-strength lock up front. No separate scheduling pointer exists.
    const gapResult = await tx.execute<{
      startSeq: number;
      endSeq: number;
    }>(sql`
      SELECT "startSeq", "endSeq"
      FROM "FederationThreadHistoryGap"
      WHERE id = ${params.gapId}
        AND "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
        AND recoverable = true
      FOR UPDATE
    `);
    const gap = gapResult.rows[0];
    if (!gap) throw new Error('requested reverse gap no longer exists');
    if (params.beforeSeq !== gap.endSeq + 1)
      throw new Error('requested reverse gap boundary changed');
    if (
      params.throughSeq !== gap.startSeq ||
      params.scannedThrough < gap.startSeq ||
      params.scannedThrough >= params.beforeSeq
    ) {
      throw new Error('reverse batch is outside the active gap');
    }
    if (params.closesGap !== (params.scannedThrough === gap.startSeq)) {
      throw new Error('reverse response completion disagrees with active gap');
    }

    await params.writeMessages(threadLock);
    const scannedThrough = params.scannedThrough;
    const closesGap = scannedThrough === gap.startSeq;
    if (!closesGap) {
      const [updatedGap] = await tx
        .update(federationThreadHistoryGap)
        .set({ endSeq: scannedThrough - 1, updatedAt: new Date() })
        .where(
          and(
            eq(federationThreadHistoryGap.id, params.gapId),
            and(
              eq(federationThreadHistoryGap.threadId, params.threadId),
              eq(federationThreadHistoryGap.namespaceId, params.namespaceId),
            ),
            eq(federationThreadHistoryGap.endSeq, gap.endSeq),
          ),
        )
        .returning({ id: federationThreadHistoryGap.id });
      if (!updatedGap) throw new Error('active reverse gap changed');
      return scannedThrough;
    }

    await tx
      .delete(federationThreadHistoryGap)
      .where(
        and(
          eq(federationThreadHistoryGap.threadId, params.threadId),
          eq(federationThreadHistoryGap.namespaceId, params.namespaceId),
          eq(federationThreadHistoryGap.id, params.gapId),
        ),
      );
    return scannedThrough;
  }

  static async markReverseGapUnavailableInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      namespaceId: number;
      authorizationEpoch: number;
      gapId: bigint;
      beforeSeq: number;
    },
  ): Promise<Array<{ left: number; right: number }>> {
    this.assertBeforeCursor(params.beforeSeq, 'unavailable reverse before seq');
    if (params.beforeSeq < 2)
      throw new Error('unavailable reverse interval is empty');
    await requireThreadContentLockInTx(tx, params.threadId);
    const epoch = await tx.execute(sql`
      UPDATE "MessageThread"
      SET "authorizationEpoch" = "authorizationEpoch"
      WHERE id = ${params.threadId}
        AND "authorizationEpoch" = ${params.authorizationEpoch}
      RETURNING "authorizationEpoch"
    `);
    if ((epoch.rows ?? []).length === 0) {
      throw new FederationThreadRoundAuthorizationEpochChangedError();
    }
    const current = await tx.execute(sql`
      SELECT id FROM "FederationThreadHistoryGap"
      WHERE id = ${params.gapId}
        AND "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
        AND "endSeq" = ${params.beforeSeq - 1}
        AND recoverable = true
    `);
    if (current.rows.length !== 1)
      throw new Error(
        'requested reverse gap is missing or its boundary changed',
      );
    const updated = await tx.execute<{ left: number; right: number }>(sql`
      UPDATE "FederationThreadHistoryGap"
      SET recoverable = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
        AND "endSeq" < ${params.beforeSeq}
        AND recoverable = true
      RETURNING "startSeq" + "messageSeqOffset" - 1 AS "left",
        "endSeq" + "messageSeqOffset" AS "right"
    `);
    return updated.rows;
  }

  private static assertCoordinate(value: number, label: string): void {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > FEDERATION_THREAD_SEQUENCE_MAX
    ) {
      throw new Error(
        `${label} must be an integer between 0 and ${FEDERATION_THREAD_SEQUENCE_MAX}`,
      );
    }
  }

  /** Reserve every publisher slot, including the newest reverse-tail item. */
  private static async reserveReverseSequenceRangeInTx(
    tx: DatabaseTransaction,
    threadId: number,
    endSeq: number,
    messageSeqOffset: number,
  ): Promise<void> {
    this.assertOffset(messageSeqOffset);
    const localEndSeq = endSeq + messageSeqOffset;
    this.assertCoordinate(localEndSeq, 'reserved local message seq');
    await tx.execute(sql`
      UPDATE "MessageThread"
      SET "curSeq" = GREATEST("curSeq", ${localEndSeq}), "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${threadId}
    `);
  }

  private static assertOffset(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('message seq offset must be a non-negative integer');
    }
  }

  private static assertBeforeCursor(value: number, label: string): void {
    const maximum = FEDERATION_THREAD_SEQUENCE_MAX + 1;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new Error(`${label} must be an integer between 0 and ${maximum}`);
    }
  }

  private static assertProcessedAdvance(
    processedThroughSeq: number,
    frozenTargetSeq: number,
    kind: 'message' | 'deletion',
  ): void {
    this.assertCoordinate(processedThroughSeq, `${kind} processed seq`);
    this.assertCoordinate(frozenTargetSeq, `${kind} frozen target seq`);
    if (processedThroughSeq > frozenTargetSeq) {
      throw new Error(
        `${kind} processed seq must not exceed its frozen target`,
      );
    }
  }
}
