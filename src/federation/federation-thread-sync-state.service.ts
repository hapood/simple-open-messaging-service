import { Injectable, Logger } from '@nestjs/common';
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
import { calculatePublisherReservationOffset } from './federation-message-sequence-policy.js';
import { readAuthorizedSourceHeadInTx } from './federation-authorized-source-head.js';

export interface FederationReverseWindow {
  authorizationEpoch: number;
  gapId: bigint | null;
  beforeSeq: number;
  throughSeq: number;
  messageSeqOffset: number | null;
}

export type ResolveReverseMessageOffset = (
  originSeq: number,
) => Promise<number | null>;

@Injectable()
export class FederationThreadSyncStateService {
  private static readonly logger = new Logger(
    FederationThreadSyncStateService.name,
  );

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
      const reverseRequired =
        params.reverseEnabled && params.messageTargetSeq >= 1;
      await tx.insert(federationThreadSyncState).values({
        threadId: params.threadId,
        namespaceId: params.namespaceId,
        messageTargetSeq: params.messageTargetSeq,
        deletionTargetSeq: params.deletionTargetSeq,
        messageProcessedThroughSeq: 0,
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

    const nextMessageTargetSeq = Math.max(
      state.messageTargetSeq,
      params.messageTargetSeq,
    );
    const nextDeletionTargetSeq = Math.max(
      state.deletionTargetSeq,
      params.deletionTargetSeq,
    );
    const epochChanged = state.authorizationEpoch !== thread.authorizationEpoch;
    await tx
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
        ),
      );
    return {
      created: false,
      epochChanged,
      reverseRequired:
        params.reverseEnabled &&
        nextMessageTargetSeq > state.messageProcessedThroughSeq,
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

  /** Select request bounds from remaining gaps without persisting scheduling state. */
  async resolveReverseWindow(
    threadId: number,
    namespaceId: number,
  ): Promise<FederationReverseWindow | null> {
    const stateResult = await this.database.db.execute<{
      authorizationEpoch: number;
      messageTargetSeq: number;
      messageProcessedThroughSeq: number;
    }>(sql`
      SELECT thread."authorizationEpoch", state."messageTargetSeq",
        state."messageProcessedThroughSeq"
      FROM "FederationThreadSyncState" state
      JOIN "MessageThread" thread ON thread.id = state."threadId"
      WHERE state."threadId" = ${threadId} AND state."namespaceId" = ${namespaceId}
      LIMIT 1
    `);
    const state = stateResult.rows[0];
    if (state && state.messageTargetSeq > state.messageProcessedThroughSeq) {
      const beforeSeq = state.messageTargetSeq + 1;
      FederationThreadSyncStateService.assertBeforeCursor(
        beforeSeq,
        'reverse upper boundary',
      );
      return {
        authorizationEpoch: state.authorizationEpoch,
        gapId: null,
        beforeSeq,
        throughSeq: state.messageProcessedThroughSeq + 1,
        messageSeqOffset: null,
      };
    }

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
      gapId: bigint | null;
      beforeSeq: number;
      scannedThrough: number;
      throughSeq: number;
      closesGap: boolean;
      hasMessages?: boolean;
      writeMessages: (
        threadLock: ThreadContentLock,
        resolveOffset: ResolveReverseMessageOffset,
      ) => Promise<void>;
    },
  ): Promise<number> {
    const threadLock = await requireThreadContentLockInTx(tx, params.threadId);
    const epoch = await tx.execute<{
      authorizationEpoch: number;
      curSeq: number;
    }>(sql`
      UPDATE "MessageThread"
      SET "authorizationEpoch" = "authorizationEpoch"
      WHERE id = ${params.threadId}
        AND "authorizationEpoch" = ${params.authorizationEpoch}
      RETURNING "authorizationEpoch", "curSeq"
    `);
    const thread = epoch.rows[0];
    if (!thread)
      throw new FederationThreadRoundAuthorizationEpochChangedError();

    const endSeq = params.beforeSeq - 1;
    const scannedThrough = params.scannedThrough;
    if (scannedThrough < params.throughSeq || scannedThrough >= params.beforeSeq) {
      throw new Error('reverse batch is outside the active reverse window');
    }

    const stateResult = await tx.execute<{
      messageProcessedThroughSeq: number;
    }>(sql`
      SELECT "messageProcessedThroughSeq"
      FROM "FederationThreadSyncState"
      WHERE "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
      FOR NO KEY UPDATE
    `);
    const processedThrough =
      stateResult.rows[0]?.messageProcessedThroughSeq ?? 0;

    const coveredBelowScan = await tx.execute<{ endSeq: number }>(sql`
      SELECT COALESCE(MAX("endSeq"), 0)::integer AS "endSeq"
      FROM "FederationThreadHistoryGap"
      WHERE "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
        AND "endSeq" < ${scannedThrough}
    `);
    const reservedThrough = Math.max(
      processedThrough,
      coveredBelowScan.rows[0]?.endSeq ?? 0,
    );

    // Lock only gaps overlapping this scanned page. Completed rows in that
    // range may be deleted while reconciling the batch.
    const gapRows = await tx.execute<{
      id: string;
      startSeq: number;
      endSeq: number;
      messageSeqOffset: number;
      recoverable: boolean;
    }>(sql`
      SELECT id::text AS id, "startSeq", "endSeq", "messageSeqOffset", recoverable
      FROM "FederationThreadHistoryGap"
      WHERE "threadId" = ${params.threadId}
        AND "namespaceId" = ${params.namespaceId}
        AND "startSeq" <= ${endSeq}
        AND "endSeq" >= ${scannedThrough}
      ORDER BY "startSeq" ASC, id ASC
      FOR UPDATE
    `);

    interface InMemoryGap {
      id: bigint | null;
      startSeq: number;
      endSeq: number;
      messageSeqOffset: number;
      recoverable: boolean;
    }

    const gaps: InMemoryGap[] = gapRows.rows.map((row) => ({
      id: BigInt(row.id),
      startSeq: row.startSeq,
      endSeq: row.endSeq,
      messageSeqOffset: row.messageSeqOffset,
      recoverable: row.recoverable,
    }));

    const computeCoveredThrough = (): number => {
      let maxEnd = reservedThrough;
      for (const gap of gaps) {
        if (gap.endSeq > maxEnd) maxEnd = gap.endSeq;
      }
      return maxEnd;
    };

    const ensureNewTailGap = async (): Promise<InMemoryGap> => {
      const coveredThrough = computeCoveredThrough();
      const newStartSeq = coveredThrough + 1;
      const messageSeqOffset = calculatePublisherReservationOffset({
        firstOriginSeq: newStartSeq,
        curSeq: thread.curSeq,
      });
      await this.reserveReverseSequenceRangeInTx(
        tx,
        params.threadId,
        endSeq,
        messageSeqOffset,
      );
      const created: InMemoryGap = {
        id: null,
        startSeq: newStartSeq,
        endSeq,
        messageSeqOffset,
        recoverable: true,
      };
      gaps.push(created);
      return created;
    };

    const resolveOffset: ResolveReverseMessageOffset = async (
      originSeq: number,
    ): Promise<number | null> => {
      const matched = gaps.find(
        (gap) => gap.startSeq <= originSeq && originSeq <= gap.endSeq,
      );
      if (matched && !matched.recoverable) {
        FederationThreadSyncStateService.logger.warn(
          `reverse batch message originSeq=${originSeq} falls in unrecoverable gap ${matched.startSeq}-${matched.endSeq} for thread=${params.threadId} namespace=${params.namespaceId}`,
        );
        throw new Error(
          `reverse batch message originSeq=${originSeq} falls in an unrecoverable gap`,
        );
      }
      if (matched) return matched.messageSeqOffset;

      const hasGapToRight = gaps.some((gap) => gap.startSeq > originSeq);
      if (hasGapToRight || originSeq <= processedThrough) {
        this.logger.warn(
          `reverse batch message originSeq=${originSeq} has no matching gap for thread=${params.threadId} namespace=${params.namespaceId} (processedThrough=${processedThrough}, hasGapToRight=${hasGapToRight}); skipping`,
        );
        return null;
      }

      const created = await ensureNewTailGap();
      return created.messageSeqOffset;
    };

    await params.writeMessages(threadLock, resolveOffset);

    // If the batch scanned a brand-new tail without any messages hitting it,
    // still reserve the tail when a lower un-scanned hole remains.
    const coveredAfterMessages = computeCoveredThrough();
    if (
      endSeq > coveredAfterMessages &&
      scannedThrough > coveredAfterMessages + 1
    ) {
      await ensureNewTailGap();
    }

    // Reconcile in-memory gaps against the scanned interval [scannedThrough, endSeq].
    for (const gap of gaps) {
      if (!gap.recoverable) continue;
      if (gap.id === null) {
        if (scannedThrough > gap.startSeq) {
          await tx
            .insert(federationThreadHistoryGap)
            .values({
              threadId: params.threadId,
              namespaceId: params.namespaceId,
              startSeq: gap.startSeq,
              endSeq: scannedThrough - 1,
              messageSeqOffset: gap.messageSeqOffset,
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
            });
        }
        continue;
      }

      if (endSeq < gap.startSeq || scannedThrough > gap.endSeq) continue;

      if (scannedThrough <= gap.startSeq && endSeq >= gap.endSeq) {
        await tx
          .delete(federationThreadHistoryGap)
          .where(
            and(
              eq(federationThreadHistoryGap.threadId, params.threadId),
              eq(federationThreadHistoryGap.namespaceId, params.namespaceId),
              eq(federationThreadHistoryGap.id, gap.id),
            ),
          );
      } else if (
        scannedThrough > gap.startSeq &&
        scannedThrough <= gap.endSeq &&
        endSeq >= gap.endSeq
      ) {
        await tx
          .update(federationThreadHistoryGap)
          .set({ endSeq: scannedThrough - 1, updatedAt: new Date() })
          .where(
            and(
              eq(federationThreadHistoryGap.id, gap.id),
              eq(federationThreadHistoryGap.threadId, params.threadId),
              eq(federationThreadHistoryGap.namespaceId, params.namespaceId),
              eq(federationThreadHistoryGap.endSeq, gap.endSeq),
            ),
          );
      }
    }

    await tx
      .update(federationThreadSyncState)
      .set({
        messageProcessedThroughSeq: sql`GREATEST(${federationThreadSyncState.messageProcessedThroughSeq}, ${endSeq})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(federationThreadSyncState.threadId, params.threadId),
          eq(federationThreadSyncState.namespaceId, params.namespaceId),
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
      gapId: bigint | null;
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
    if (params.gapId !== null) {
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
    }
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
    const endSeq = params.beforeSeq - 1;
    await tx
      .update(federationThreadSyncState)
      .set({
        messageProcessedThroughSeq: sql`GREATEST(${federationThreadSyncState.messageProcessedThroughSeq}, LEAST(${federationThreadSyncState.messageTargetSeq}, ${endSeq}))`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(federationThreadSyncState.threadId, params.threadId),
          eq(federationThreadSyncState.namespaceId, params.namespaceId),
        ),
      );
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
