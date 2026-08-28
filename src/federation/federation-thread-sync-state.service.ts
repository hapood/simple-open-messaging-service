import { Injectable } from '@nestjs/common';
import { and, eq, isNotNull, lt, max, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { federationThreadSyncState, message } from '../database/schema.js';
import { FEDERATION_THREAD_SEQUENCE_MAX } from './federation-thread-round.constants.js';

export interface ReusableReverseMessageBatch {
  sourceSeqs: number[];
  batchOldestSeq: number | null;
  reachedClosureTarget: boolean;
  canSkipMessageQuery: boolean;
}

@Injectable()
export class FederationThreadSyncStateService {
  constructor(private readonly database: DatabaseService) {}

  static async mergeMessageTargetInTx(
    tx: DatabaseTransaction,
    threadId: number,
    peerDomain: string,
    messageTargetSeq: number,
    reverseEnabled: boolean,
  ): Promise<{ created: boolean }> {
    this.assertCoordinate(messageTargetSeq, 'message target seq');
    const reverseNextBeforeSeq = reverseEnabled ? messageTargetSeq + 1 : 0;
    const [closure] = reverseEnabled
      ? await tx
          .select({ originSeq: max(message.originSeq) })
          .from(message)
          .where(
            and(
              eq(message.threadId, threadId),
              eq(message.federationSourceDomain, peerDomain),
              isNotNull(message.originSeq),
              lt(message.originSeq, reverseNextBeforeSeq),
            ),
          )
      : [{ originSeq: null }];
    const reverseClosureOriginSeq = closure?.originSeq ?? null;
    const inserted = await tx
      .insert(federationThreadSyncState)
      .values({
        threadId,
        peerDomain,
        messageTargetSeq,
        messageProcessedThroughSeq: reverseEnabled ? messageTargetSeq : 0,
        deletionTargetSeq: 0,
        reverseNextBeforeSeq,
        reverseClosureOriginSeq,
        historyBoundaryReached: !reverseEnabled,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [
          federationThreadSyncState.threadId,
          federationThreadSyncState.peerDomain,
        ],
      })
      .returning({ threadId: federationThreadSyncState.threadId });
    if (inserted.length > 0) return { created: true };
    await tx
      .update(federationThreadSyncState)
      .set({
        messageTargetSeq: sql`GREATEST(${federationThreadSyncState.messageTargetSeq}, ${messageTargetSeq})`,
        reverseNextBeforeSeq: sql`CASE
          WHEN ${federationThreadSyncState.messageTargetSeq} = 0
            THEN ${reverseNextBeforeSeq}
          ELSE ${federationThreadSyncState.reverseNextBeforeSeq}
        END`,
        reverseClosureOriginSeq: sql`CASE
          WHEN ${federationThreadSyncState.messageTargetSeq} = 0
            THEN ${reverseClosureOriginSeq}
          ELSE ${federationThreadSyncState.reverseClosureOriginSeq}
        END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(federationThreadSyncState.threadId, threadId),
          eq(federationThreadSyncState.peerDomain, peerDomain),
        ),
      );
    return { created: false };
  }

  static async mergeDeletionTargetInTx(
    tx: DatabaseTransaction,
    threadId: number,
    peerDomain: string,
    deletionTargetSeq: number,
  ): Promise<void> {
    this.assertCoordinate(deletionTargetSeq, 'deletion target seq');
    const updated = await tx
      .update(federationThreadSyncState)
      .set({
        deletionTargetSeq: sql`GREATEST(${federationThreadSyncState.deletionTargetSeq}, ${deletionTargetSeq})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(federationThreadSyncState.threadId, threadId),
          eq(federationThreadSyncState.peerDomain, peerDomain),
        ),
      )
      .returning({ threadId: federationThreadSyncState.threadId });
    if (updated.length === 0) {
      throw new Error(
        `federated thread ${threadId} has no synchronization state for ${peerDomain}`,
      );
    }
  }

  static async advanceMessageProcessedThroughInTx(
    tx: DatabaseTransaction,
    threadId: number,
    peerDomain: string,
    processedThroughSeq: number,
    frozenTargetSeq: number,
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
          AND ${federationThreadSyncState.peerDomain} = ${peerDomain}
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
    peerDomain: string,
    processedThroughSeq: number,
    frozenTargetSeq: number,
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
        updatedAt: new Date(),
      })
      .where(
        sql`${federationThreadSyncState.threadId} = ${threadId}
          AND ${federationThreadSyncState.peerDomain} = ${peerDomain}
          AND ${federationThreadSyncState.deletionTargetSeq} >= ${frozenTargetSeq}`,
      )
      .returning({ threadId: federationThreadSyncState.threadId });
    if (!updated) {
      throw new Error(
        `federated mirror thread ${threadId} has no deletion target for this round`,
      );
    }
  }

  /** Commits a completed reverse batch. The visibility publication belongs in the same transaction. */
  static async commitReverseProgressInTx(
    tx: DatabaseTransaction,
    params: {
      threadId: number;
      peerDomain: string;
      frozenBeforeSeq: number;
      frozenClosureOriginSeq: number | null;
      nextBeforeSeq: number;
      historyBoundaryReached: boolean;
    },
  ): Promise<void> {
    this.assertBeforeCursor(
      params.frozenBeforeSeq,
      'reverse frozen before seq',
    );
    this.assertBeforeCursor(params.nextBeforeSeq, 'reverse next before seq');
    this.assertClosureTarget(
      params.frozenClosureOriginSeq,
      params.frozenBeforeSeq,
    );
    if (params.nextBeforeSeq > params.frozenBeforeSeq) {
      throw new Error(
        'reverse next before seq must not exceed its frozen before cursor',
      );
    }
    if (
      !params.historyBoundaryReached &&
      params.frozenClosureOriginSeq !== null &&
      params.nextBeforeSeq <= params.frozenClosureOriginSeq
    ) {
      throw new Error(
        'reverse progress that reaches its closure target must complete history',
      );
    }
    const [updated] = await tx
      .update(federationThreadSyncState)
      .set({
        reverseNextBeforeSeq: params.nextBeforeSeq,
        reverseClosureOriginSeq: params.historyBoundaryReached
          ? null
          : params.frozenClosureOriginSeq,
        historyBoundaryReached: params.historyBoundaryReached,
        updatedAt: new Date(),
      })
      .where(
        sql`${federationThreadSyncState.threadId} = ${params.threadId}
          AND ${federationThreadSyncState.peerDomain} = ${params.peerDomain}
          AND ${federationThreadSyncState.reverseNextBeforeSeq} = ${params.frozenBeforeSeq}
          AND (
            (${params.frozenClosureOriginSeq} IS NULL
              AND ${federationThreadSyncState.reverseClosureOriginSeq} IS NULL)
            OR ${federationThreadSyncState.reverseClosureOriginSeq} = ${params.frozenClosureOriginSeq}
          )`,
      )
      .returning({ threadId: federationThreadSyncState.threadId });
    if (!updated) {
      throw new Error(
        `federated mirror thread ${params.threadId} reverse position changed during the round`,
      );
    }
  }

  async require(threadId: number, peerDomain: string) {
    const state =
      await this.database.db.query.federationThreadSyncState.findFirst({
        where: and(
          eq(federationThreadSyncState.threadId, threadId),
          eq(federationThreadSyncState.peerDomain, peerDomain),
        ),
      });
    if (!state) {
      throw new Error(
        `federated thread ${threadId} has no synchronization state for ${peerDomain}`,
      );
    }
    return state;
  }

  /** Reuses an interrupted reverse round only when a complete local batch is already durable. */
  async deriveReusableReverseBatch(params: {
    threadId: number;
    peerDomain: string;
    beforeSeq: number;
    closureOriginSeq: number | null;
    take: number;
  }): Promise<ReusableReverseMessageBatch> {
    FederationThreadSyncStateService.assertBeforeCursor(
      params.beforeSeq,
      'reverse before seq',
    );
    FederationThreadSyncStateService.assertClosureTarget(
      params.closureOriginSeq,
      params.beforeSeq,
    );
    if (!Number.isSafeInteger(params.take) || params.take <= 0) {
      throw new Error('reverse take must be a positive safe integer');
    }
    const result = await this.database.db.execute<{ sourceSeq: number }>(sql`
      SELECT DISTINCT durable."sourceSeq"
      FROM (
        SELECT message."originSeq" AS "sourceSeq"
        FROM "Message" message
        WHERE message."threadId" = ${params.threadId}
          AND message."federationSourceDomain" = ${params.peerDomain}
          AND message."originSeq" IS NOT NULL
          AND message."originSeq" < ${params.beforeSeq}
          AND (${params.closureOriginSeq} IS NULL
            OR message."originSeq" >= ${params.closureOriginSeq})
        UNION ALL
        SELECT pending."originSeq" AS "sourceSeq"
        FROM "PendingMedia" pending
        WHERE pending."threadId" = ${params.threadId}
          AND pending."originDomain" = ${params.peerDomain}
          AND pending.direction = 'INBOUND'
          AND pending."originSeq" IS NOT NULL
          AND pending."originSeq" < ${params.beforeSeq}
          AND (${params.closureOriginSeq} IS NULL
            OR pending."originSeq" >= ${params.closureOriginSeq})
      ) durable
      ORDER BY durable."sourceSeq" DESC
      LIMIT ${params.take}
    `);
    const sourceSeqs = result.rows.map((row) => row.sourceSeq);
    const reachedClosureTarget =
      params.closureOriginSeq !== null &&
      sourceSeqs.includes(params.closureOriginSeq);
    const canSkipMessageQuery =
      reachedClosureTarget || sourceSeqs.length === params.take;
    return {
      sourceSeqs,
      batchOldestSeq: reachedClosureTarget
        ? params.closureOriginSeq
        : canSkipMessageQuery
          ? sourceSeqs.at(-1)!
          : null,
      reachedClosureTarget,
      canSkipMessageQuery,
    };
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

  private static assertBeforeCursor(value: number, label: string): void {
    const maximum = FEDERATION_THREAD_SEQUENCE_MAX + 1;
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new Error(`${label} must be an integer between 0 and ${maximum}`);
    }
  }

  private static assertClosureTarget(
    closureOriginSeq: number | null,
    beforeSeq: number,
  ): void {
    if (closureOriginSeq === null) return;
    this.assertCoordinate(closureOriginSeq, 'reverse closure origin seq');
    if (closureOriginSeq === 0 || closureOriginSeq >= beforeSeq) {
      throw new Error(
        'reverse closure origin seq must be positive and less than its before cursor',
      );
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
