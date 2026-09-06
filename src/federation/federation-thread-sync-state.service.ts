import { Injectable } from '@nestjs/common';
import {
  lockThreadContentInTx,
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../relationship/thread-content-lock.js';
import { and, desc, eq, sql } from 'drizzle-orm';
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

export interface FederationReverseWindow {
  authorizationEpoch: number;
  gapId: bigint | null;
  beforeSeq: number;
  throughSeq: number | null;
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
      throw new Error('federation round authorization epoch changed');
    }
    return threadLock;
  }

  static async reconcileThreadHeadInTx(
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
    await requireThreadContentLockInTx(tx, params.threadId, params.threadLock);

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
      deletionRecoveryThroughSeq: number | null;
      deletionRecoveryMaxMessageSeq: number | null;
      authorizationEpoch: number;
      activeGapId: string | null;
      historyBoundaryReached: boolean;
    }>(sql`
      SELECT "messageTargetSeq", "messageProcessedThroughSeq",
        "deletionTargetSeq", "deletionProcessedThroughSeq",
        "deletionRecoveryThroughSeq", "deletionRecoveryMaxMessageSeq",
        "authorizationEpoch", "activeGapId", "historyBoundaryReached"
      FROM "FederationThreadSyncState"
      WHERE "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
      FOR UPDATE
    `);
    const state = stateResult.rows[0];
    if (!state) {
      const reverseEndSeq = params.messageTargetSeq - 1;
      let activeGapId: bigint | null = null;
      if (params.reverseEnabled && reverseEndSeq >= 1) {
        const messageSeqOffset = thread.curSeq;
        const [gap] = await tx
          .insert(federationThreadHistoryGap)
          .values({
            threadId: params.threadId,
            namespaceId: params.namespaceId,
            startSeq: 1,
            endSeq: reverseEndSeq,
            messageSeqOffset,
            recoverable: true,
            updatedAt: new Date(),
          })
          .returning({ id: federationThreadHistoryGap.id });
        activeGapId = gap.id;
        await this.reserveReverseSequenceRangeInTx(
          tx,
          params.threadId,
          reverseEndSeq,
          messageSeqOffset,
        );
      }
      await tx.insert(federationThreadSyncState).values({
        threadId: params.threadId,
        namespaceId: params.namespaceId,
        messageTargetSeq: params.messageTargetSeq,
        deletionTargetSeq: params.deletionTargetSeq,
        // The newest advertised message is intentionally left to the forward
        // query. Only the older closed interval is represented by a gap.
        messageProcessedThroughSeq: params.reverseEnabled
          ? Math.max(0, params.messageTargetSeq - 1)
          : 0,
        // A newly initialized mirror has no earlier authorized segment. A local
        // authority may already retain submissions while rebuilding its source
        // cursor, so it must replay that source's historical withdrawal facts.
        deletionProcessedThroughSeq: params.reverseEnabled
          ? params.deletionTargetSeq
          : 0,
        authorizationEpoch: thread.authorizationEpoch,
        activeGapId,
        historyBoundaryReached: activeGapId === null,
        updatedAt: new Date(),
      });
      return {
        created: true,
        epochChanged: false,
        reverseRequired: activeGapId !== null,
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
    const nextMessageProcessedThroughSeq = params.reverseEnabled
      ? Math.max(state.messageProcessedThroughSeq, nextMessageTargetSeq - 1)
      : state.messageProcessedThroughSeq;
    const nextDeletionTargetSeq = Math.max(
      state.deletionTargetSeq,
      params.deletionTargetSeq,
    );
    const recoveryRequired =
      nextDeletionTargetSeq > state.deletionProcessedThroughSeq;
    let activeGapId: bigint | null = null;
    const obsoleteGapIds: bigint[] = [];
    if (params.reverseEnabled) {
      const newGapStartSeq = state.messageProcessedThroughSeq + 1;
      const newGapEndSeq = nextMessageProcessedThroughSeq;
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
        const messageSeqOffset = thread.curSeq + 1 - newGapStartSeq;
        this.assertOffset(messageSeqOffset);
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
        const exact = mergeable.find(
          (gap) =>
            gap.startSeq === mergedStartSeq && gap.endSeq === mergedEndSeq,
        );
        if (exact) {
          activeGapId = BigInt(exact.id);
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
          activeGapId = merged.id;
        }
        obsoleteGapIds.push(
          ...mergeable
            .map((gap) => BigInt(gap.id))
            .filter((id) => id !== activeGapId),
        );
      } else {
        const [latestGap] = await tx
          .select({ id: federationThreadHistoryGap.id })
          .from(federationThreadHistoryGap)
          .where(
            and(
              and(
                eq(federationThreadHistoryGap.threadId, params.threadId),
                eq(federationThreadHistoryGap.namespaceId, params.namespaceId),
              ),
              eq(federationThreadHistoryGap.recoverable, true),
            ),
          )
          .orderBy(desc(federationThreadHistoryGap.endSeq))
          .limit(1);
        activeGapId = latestGap?.id ?? null;
      }
    }

    const [updated] = await tx
      .update(federationThreadSyncState)
      .set({
        messageTargetSeq: nextMessageTargetSeq,
        messageProcessedThroughSeq: nextMessageProcessedThroughSeq,
        deletionTargetSeq: nextDeletionTargetSeq,
        deletionRecoveryThroughSeq: recoveryRequired
          ? nextDeletionTargetSeq
          : null,
        deletionRecoveryMaxMessageSeq: recoveryRequired
          ? state.messageProcessedThroughSeq
          : null,
        authorizationEpoch: thread.authorizationEpoch,
        activeGapId,
        historyBoundaryReached: activeGapId === null,
        updatedAt: new Date(),
      })
      .where(
        and(
          and(
            eq(federationThreadSyncState.threadId, params.threadId),
            eq(federationThreadSyncState.namespaceId, params.namespaceId),
          ),
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
    if (params.reverseEnabled && nextMessageProcessedThroughSeq >= 1) {
      await this.reserveReverseSequenceRangeInTx(
        tx,
        params.threadId,
        nextMessageProcessedThroughSeq,
        thread.curSeq + 1 - (state.messageProcessedThroughSeq + 1),
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
    return {
      created: false,
      epochChanged: true,
      reverseRequired: activeGapId !== null,
    };
  }

  static async advanceMessageProcessedThroughInTx(
    tx: DatabaseTransaction,
    threadId: number,
    processedThroughSeq: number,
    frozenTargetSeq: number,
    namespaceId: number,
  ): Promise<void> {
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
  ): Promise<void> {
    this.assertProcessedAdvance(
      processedThroughSeq,
      frozenTargetSeq,
      'deletion',
    );
    const [updated] = await tx
      .update(federationThreadSyncState)
      .set({
        deletionProcessedThroughSeq: sql`GREATEST(${federationThreadSyncState.deletionProcessedThroughSeq}, ${processedThroughSeq})`,
        deletionRecoveryThroughSeq: sql`CASE
          WHEN ${federationThreadSyncState.deletionRecoveryThroughSeq} IS NOT NULL
            AND GREATEST(${federationThreadSyncState.deletionProcessedThroughSeq}, ${processedThroughSeq}) >= ${federationThreadSyncState.deletionRecoveryThroughSeq}
          THEN NULL
          ELSE ${federationThreadSyncState.deletionRecoveryThroughSeq}
        END`,
        deletionRecoveryMaxMessageSeq: sql`CASE
          WHEN ${federationThreadSyncState.deletionRecoveryThroughSeq} IS NOT NULL
            AND GREATEST(${federationThreadSyncState.deletionProcessedThroughSeq}, ${processedThroughSeq}) >= ${federationThreadSyncState.deletionRecoveryThroughSeq}
          THEN NULL
          ELSE ${federationThreadSyncState.deletionRecoveryMaxMessageSeq}
        END`,
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

  /** Reconstruct the process-local reverse cursor from immutable gap boundaries and durable STUBs. */
  async resolveReverseWindow(
    threadId: number,
    namespaceId: number,
  ): Promise<FederationReverseWindow> {
    const state = await this.require(threadId, namespaceId);
    if (state.historyBoundaryReached) {
      return {
        authorizationEpoch: state.authorizationEpoch,
        gapId: null,
        beforeSeq: 0,
        throughSeq: null,
        messageSeqOffset: 0,
      };
    }
    if (state.activeGapId === null) {
      throw new Error('unfinished reverse history has no active gap');
    }
    const gapId = state.activeGapId;
    const result = await this.database.db.execute<{
      startSeq: number;
      endSeq: number;
      messageSeqOffset: number;
    }>(sql`
      SELECT "startSeq", "endSeq", "messageSeqOffset"
      FROM "FederationThreadHistoryGap"
      WHERE id = ${gapId}
        AND "threadId" = ${threadId}
        AND "namespaceId" = ${namespaceId}
        AND recoverable = true
    `);
    const gap = result.rows[0];
    if (!gap) throw new Error('active federation history gap is invalid');
    const beforeSeq = gap.endSeq + 1;
    FederationThreadSyncStateService.assertBeforeCursor(
      beforeSeq,
      'reverse upper boundary',
    );

    return {
      authorizationEpoch: state.authorizationEpoch,
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
      applyDependencies?: (threadLock: ThreadContentLock) => Promise<void>;
    },
  ): Promise<void> {
    const threadLock = await requireThreadContentLockInTx(tx, params.threadId);
    const epoch = await tx.execute<{ authorizationEpoch: number }>(sql`
      UPDATE "MessageThread"
      SET "authorizationEpoch" = "authorizationEpoch"
      WHERE id = ${params.threadId}
        AND "authorizationEpoch" = ${params.authorizationEpoch}
      RETURNING "authorizationEpoch"
    `);
    if (!epoch.rows[0])
      throw new Error('reverse round authorization epoch changed');

    const stateResult = await tx.execute<{
      activeGapId: string | null;
    }>(sql`
      SELECT "activeGapId"
      FROM "FederationThreadSyncState"
      WHERE "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
        AND "authorizationEpoch" = ${params.authorizationEpoch}
      FOR UPDATE
    `);
    const state = stateResult.rows[0];
    if (!state) throw new Error('reverse synchronization state changed');
    if (
      state.activeGapId === null ||
      BigInt(state.activeGapId) !== params.gapId
    ) {
      throw new Error('active reverse gap changed');
    }

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
    if (!gap) throw new Error('active reverse gap changed');
    if (
      params.beforeSeq !== gap.endSeq + 1 ||
      params.throughSeq !== gap.startSeq ||
      params.scannedThrough < gap.startSeq ||
      params.scannedThrough >= params.beforeSeq
    ) {
      throw new Error('reverse batch is outside the active gap');
    }
    const closesGap = params.scannedThrough === gap.startSeq;
    if (params.closesGap !== closesGap) {
      throw new Error('reverse response completion disagrees with active gap');
    }

    await params.applyDependencies?.(threadLock);

    if (!closesGap) {
      const [updatedGap] = await tx
        .update(federationThreadHistoryGap)
        .set({ endSeq: params.scannedThrough - 1, updatedAt: new Date() })
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
      return;
    }

    const completedGapId = params.gapId;
    const [nextGap] = await tx
      .select({ id: federationThreadHistoryGap.id })
      .from(federationThreadHistoryGap)
      .where(
        sql`${federationThreadHistoryGap.threadId} = ${params.threadId}
          AND ${federationThreadHistoryGap.namespaceId} = ${params.namespaceId}
          AND ${federationThreadHistoryGap.recoverable} = true
          AND (${completedGapId}::bigint IS NULL
            OR ${federationThreadHistoryGap.id} <> ${completedGapId})`,
      )
      .orderBy(desc(federationThreadHistoryGap.endSeq))
      .limit(1);
    const [updated] = await tx
      .update(federationThreadSyncState)
      .set({
        activeGapId: nextGap?.id ?? null,
        historyBoundaryReached: nextGap === undefined,
        updatedAt: new Date(),
      })
      .where(
        and(
          and(
            eq(federationThreadSyncState.threadId, params.threadId),
            eq(federationThreadSyncState.namespaceId, params.namespaceId),
          ),
          eq(
            federationThreadSyncState.authorizationEpoch,
            params.authorizationEpoch,
          ),
        ),
      )
      .returning({ threadId: federationThreadSyncState.threadId });
    if (!updated) throw new Error('reverse synchronization state changed');

    // The state owns a RESTRICT reference to its active gap. Move that reference
    // before deleting the completed row.
    if (completedGapId !== null) {
      await tx
        .delete(federationThreadHistoryGap)
        .where(
          and(
            and(
              eq(federationThreadHistoryGap.threadId, params.threadId),
              eq(federationThreadHistoryGap.namespaceId, params.namespaceId),
            ),
            eq(federationThreadHistoryGap.id, completedGapId),
          ),
        );
    }
  }

  static async markReverseGapUnavailableInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      namespaceId: number;
      authorizationEpoch: number;
      gapId: bigint;
    },
  ): Promise<void> {
    await lockThreadContentInTx(tx, params.threadId);
    const epoch = await tx.execute(sql`
      UPDATE "MessageThread"
      SET "authorizationEpoch" = "authorizationEpoch"
      WHERE id = ${params.threadId}
        AND "authorizationEpoch" = ${params.authorizationEpoch}
      RETURNING "authorizationEpoch"
    `);
    if ((epoch.rows ?? []).length === 0) {
      throw new Error('reverse round authorization epoch changed');
    }
    const state = await tx.execute<{ activeGapId: string | null }>(sql`
      SELECT "activeGapId"
      FROM "FederationThreadSyncState"
      WHERE "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
        AND "authorizationEpoch" = ${params.authorizationEpoch}
      FOR UPDATE
    `);
    if (
      state.rows[0]?.activeGapId === null ||
      state.rows[0]?.activeGapId === undefined ||
      BigInt(state.rows[0].activeGapId) !== params.gapId
    ) {
      throw new Error('active reverse gap changed');
    }
    await tx
      .update(federationThreadHistoryGap)
      .set({ recoverable: false, updatedAt: new Date() })
      .where(
        and(
          and(
            eq(federationThreadHistoryGap.threadId, params.threadId),
            eq(federationThreadHistoryGap.namespaceId, params.namespaceId),
          ),
          eq(federationThreadHistoryGap.id, params.gapId),
        ),
      );
    const [nextGap] = await tx
      .select({ id: federationThreadHistoryGap.id })
      .from(federationThreadHistoryGap)
      .where(
        and(
          and(
            eq(federationThreadHistoryGap.threadId, params.threadId),
            eq(federationThreadHistoryGap.namespaceId, params.namespaceId),
          ),
          eq(federationThreadHistoryGap.recoverable, true),
        ),
      )
      .orderBy(desc(federationThreadHistoryGap.endSeq))
      .limit(1);
    const [updated] = await tx
      .update(federationThreadSyncState)
      .set({
        activeGapId: nextGap?.id ?? null,
        historyBoundaryReached: nextGap === undefined,
        updatedAt: new Date(),
      })
      .where(
        and(
          and(
            eq(federationThreadSyncState.threadId, params.threadId),
            eq(federationThreadSyncState.namespaceId, params.namespaceId),
          ),
          eq(
            federationThreadSyncState.authorizationEpoch,
            params.authorizationEpoch,
          ),
        ),
      )
      .returning({ threadId: federationThreadSyncState.threadId });
    if (!updated) throw new Error('reverse synchronization state changed');
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

  /** Reserve the skipped publisher interval before the newest item is allocated forward. */
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
      SET "curSeq" = GREATEST("curSeq", ${localEndSeq})
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
