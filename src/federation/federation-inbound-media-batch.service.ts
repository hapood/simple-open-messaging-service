import {
  ConflictException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { requireInboundPendingMedia } from '../message/pending-media-row.js';
import { FederationInboundFileSync } from './federation-inbound-file-sync.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationPendingMediaPromoter } from './federation-pending-media-promoter.js';
import type { Message } from '../message/message.service.js';
import { resolveMessageMediaRoute } from './media/media-download-context.js';
import { restageInboundMedia } from './media/restage-inbound-media.js';

function parseInboundDownloadAuth(
  value: unknown,
): { fromAccount: string; fromDomain: string; toAccount: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const auth = value as Record<string, unknown>;
  if (
    typeof auth.fromAccount !== 'string' ||
    typeof auth.fromDomain !== 'string' ||
    typeof auth.toAccount !== 'string' ||
    !auth.fromAccount ||
    !auth.fromDomain ||
    !auth.toAccount
  ) {
    return;
  }
  return {
    fromAccount: auth.fromAccount,
    fromDomain: auth.fromDomain,
    toAccount: auth.toAccount,
  };
}

/**
 * Owns the durable lifecycle of an admitted inbound media batch: drive downloads, recover or retry
 * stalled files, fail spent jobs, and materialize completed Message STUBs.
 */
@Injectable()
export class FederationInboundMediaBatchService {
  private readonly logger = new Logger(FederationInboundMediaBatchService.name);
  // Lifecycle commands never queue. Retain ownership through physical IO and settlement
  // draining; callbacks must not acquire this slot while stop waits for them to finish.
  private readonly lifecycle = new Map<
    string,
    'stopping' | 'retrying' | 'recovering'
  >();

  private async runLifecycle<T>(
    key: string,
    phase: 'stopping' | 'retrying' | 'recovering',
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.lifecycle.has(key))
      throw new BusinessException(
        BusinessCode.ALREADY_EXISTS,
        'download lifecycle is busy',
        409,
      );
    this.lifecycle.set(key, phase);
    try {
      return await operation();
    } finally {
      this.lifecycle.delete(key);
    }
  }

  constructor(
    private readonly database: DatabaseService,
    private readonly fileSync: FederationInboundFileSync,
    private readonly promoter: FederationPendingMediaPromoter,
    private readonly mediaRanges: FederationMediaRangeClient,
    private readonly sse: SseService,
  ) {}

  async runFileSyncBatch(
    batchId: string,
    fetchChunksFor: (
      digest: string,
      offset: number,
      declaredBytes: number,
      signal: AbortSignal,
    ) => AsyncIterable<Buffer>,
  ): Promise<void> {
    await this.fileSync.runBatch(
      batchId,
      fetchChunksFor,
      (id) => this.promotePendingMessage(id),
      (id) => this.failPendingMessage(id),
      async (id) => {
        const progress = await this.readBatchProgressSummary(id);
        if (progress) this.publishMessageProgress(progress, 'downloading');
      },
    );
  }

  async stopInboundBatch(batchId: string): Promise<void> {
    return this.runLifecycle(batchId, 'stopping', () =>
      this.stopInboundBatchLocked(batchId),
    );
  }

  private async stopInboundBatchLocked(batchId: string): Promise<void> {
    let stopped: boolean | undefined;
    await this.fileSync.stopBatch(batchId, async () => {
      stopped = await this.database.db.transaction(async (tx) => {
        const owner = await tx.query.fileSyncProgress.findFirst({
          where: eq(tables.fileSyncProgress.batchId, batchId),
          columns: { messageId: true },
        });
        if (owner) {
          // Message-before-task ordering also serializes promotion and retry. A stage
          // is temporary coordination, not the authority for stopping durable tasks.
          await tx.execute(
            sql`SELECT id FROM "Message" WHERE id = ${owner.messageId} FOR NO KEY UPDATE`,
          );
          const foreignOwner = await tx.query.fileSyncProgress.findFirst({
            where: and(
              eq(tables.fileSyncProgress.batchId, batchId),
              sql`${tables.fileSyncProgress.messageId} <> ${owner.messageId}`,
            ),
            columns: { id: true },
          });
          if (foreignOwner)
            throw new ConflictException(
              'download batch contains mixed message owners',
            );
          const changed = await tx
            .update(tables.fileSyncProgress)
            .set({
              status: 'FAILED',
              errorKind: 'USER_STOPPED',
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(tables.fileSyncProgress.batchId, batchId),
                eq(tables.fileSyncProgress.messageId, owner.messageId),
                eq(tables.fileSyncProgress.status, 'PENDING'),
              ),
            )
            .returning({ id: tables.fileSyncProgress.id });
          if (changed.length === 0) return false;
          await tx
            .update(tables.message)
            .set({ localState: 'FAILED', updatedAt: new Date() })
            .where(
              and(
                eq(tables.message.id, owner.messageId),
                eq(tables.message.localState, 'STUB'),
              ),
            );
          return true;
        }
        return false;
      });
    });
    if (!stopped) return;
    const completion = await this.readBatchProgressSummary(batchId);
    if (completion) this.completeProgressTargets(completion, 'failed');
  }

  async retryInboundBatch(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    return this.runLifecycle(batchId, 'retrying', async () => {
      await this.fileSync.stopBatch(batchId);
      return this.retryInboundBatchLocked(batchId);
    });
  }

  private async retryInboundBatchLocked(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    const batch = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(tables.pendingMedia.batchId, batchId),
        eq(tables.pendingMedia.direction, 'INBOUND'),
      ),
    });
    const owner =
      batch?.messageId !== null && batch?.messageId !== undefined
        ? batch
        : await this.database.db.query.fileSyncProgress.findFirst({
            where: eq(tables.fileSyncProgress.batchId, batchId),
            columns: { messageId: true },
          });
    if (owner?.messageId !== null && owner?.messageId !== undefined) {
      const msg = await this.database.db.query.message.findFirst({
        where: eq(tables.message.id, owner.messageId),
      });
      if (!msg) throw new ConflictException('download message is missing');
      if (msg.localState === 'FAILED') {
        return (
          (await this.retryInboundMessageLocked(msg)) ?? {
            batchId,
            resetFiles: 0,
          }
        );
      }
    }
    return this.resumeInboundBatch(batchId, ['FAILED']);
  }

  /** Shared by administrator retry and the authenticated client's failed-attachment retry. */
  async retryInboundMessage(
    msg: Message,
  ): Promise<{ batchId: string; resetFiles: number } | null> {
    const pending = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(tables.pendingMedia.messageId, msg.id),
        eq(tables.pendingMedia.direction, 'INBOUND'),
      ),
      columns: { batchId: true },
    });
    return this.runLifecycle(
      pending?.batchId ?? `message:${msg.id}`,
      'retrying',
      async () => {
        if (pending) {
          const current = await this.database.db.query.message.findFirst({
            where: eq(tables.message.id, msg.id),
            columns: { localState: true, isDeleted: true },
          });
          // A second request holding an old FAILED message must not cancel a retry already running.
          if (!current || current.localState !== 'FAILED' || current.isDeleted)
            return null;
          await this.fileSync.stopBatch(pending.batchId);
        }
        return this.retryInboundMessageLocked(msg);
      },
    );
  }

  private async retryInboundMessageLocked(
    msg: Message,
  ): Promise<{ batchId: string; resetFiles: number } | null> {
    if (msg.localState !== 'FAILED' || msg.isDeleted) return null;
    const route = await resolveMessageMediaRoute(this.database, msg);
    const staged = await restageInboundMedia(this.database, msg, route);
    if (!staged) return null;
    void this.runFileSyncBatch(
      staged.batchId,
      (digest, offset, declaredBytes, signal) =>
        this.mediaRanges.fetch(
          route.peerDomain,
          digest,
          route.fromAccount,
          route.fromDomain,
          route.toAccount,
          route.sourceSeq,
          offset,
          declaredBytes,
          signal,
        ),
    ).catch((error: unknown) => {
      this.logger.warn(`Inbound download execution ended: ${String(error)}`);
    });
    return staged;
  }

  async recoverInboundBatch(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    return this.runLifecycle(batchId, 'recovering', async () => {
      await this.fileSync.stopBatch(batchId);
      const failed = await this.database.db.query.fileSyncProgress.findFirst({
        where: and(
          eq(tables.fileSyncProgress.batchId, batchId),
          eq(tables.fileSyncProgress.status, 'FAILED'),
        ),
        columns: { id: true },
      });
      if (failed) {
        // Repair a crash between the file outcome commit and message settlement, never retry it.
        await this.failPendingMessage(batchId);
        return { batchId, resetFiles: 0 };
      }
      return this.resumeInboundBatch(batchId, ['PENDING']);
    });
  }

  /** Materialize an existing message after its attachments complete. */
  async promotePendingMessage(batchId: string): Promise<void> {
    const completion = await this.readBatchProgressSummary(batchId);
    const promoted = await this.promoter.promote(batchId);
    if (!promoted) return;
    if (completion) this.completeProgressTargets(completion, 'ready');
  }

  private async failPendingMessage(batchId: string): Promise<void> {
    const completion = await this.readBatchProgressSummary(batchId);
    const failed = await this.database.db.transaction(async (tx) => {
      const owner = await tx.query.fileSyncProgress.findFirst({
        where: and(
          eq(tables.fileSyncProgress.batchId, batchId),
          eq(tables.fileSyncProgress.status, 'FAILED'),
        ),
        columns: { messageId: true },
      });
      if (!owner) return null;
      await tx.execute(
        sql`SELECT id FROM "Message" WHERE id = ${owner.messageId} FOR NO KEY UPDATE`,
      );
      const progress = await tx.query.fileSyncProgress.findFirst({
        where: and(
          eq(tables.fileSyncProgress.batchId, batchId),
          eq(tables.fileSyncProgress.messageId, owner.messageId),
          eq(tables.fileSyncProgress.status, 'FAILED'),
        ),
        columns: { id: true },
      });
      // Recheck the task outcome under its message lock: retry may have reset it while
      // we waited. Coordination is not needed to project a durable task failure.
      if (!progress) return null;
      const [transitioned] = await tx
        .update(tables.message)
        .set({ localState: 'FAILED', updatedAt: new Date() })
        .where(
          and(
            eq(tables.message.id, owner.messageId),
            eq(tables.message.localState, 'STUB'),
          ),
        )
        .returning({ id: tables.message.id });
      return transitioned;
    });
    if (failed) {
      if (completion) this.completeProgressTargets(completion, 'failed');
    }
  }

  private async readBatchProgressSummary(batchId: string): Promise<{
    message: { threadId: number; seq: number };
    completedFiles: number;
    totalFiles: number;
  } | null> {
    const task = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.batchId, batchId),
      columns: { messageId: true },
    });
    // File tasks retain ownership after materialization removes coordination.
    // Coordination remains a fallback for diagnosing a batch with missing tasks.
    const owner =
      task ??
      (await this.database.db.query.pendingMedia.findFirst({
        where: and(
          eq(tables.pendingMedia.batchId, batchId),
          eq(tables.pendingMedia.direction, 'INBOUND'),
        ),
        columns: { messageId: true },
      }));
    if (!owner?.messageId) return null;
    const message = await this.database.db.query.message.findFirst({
      where: eq(tables.message.id, owner.messageId),
      columns: { threadId: true, seq: true },
    });
    if (!message) return null;
    if (
      !this.sse.hasMediaMessageProgressSubscriber(message.threadId, message.seq)
    )
      return null;
    const [counts] = await this.database.db
      .select({
        totalFiles: sql<number>`COUNT(*)::int`,
        completedFiles: sql<number>`COUNT(*) FILTER (WHERE ${tables.fileSyncProgress.status} = 'COMPLETED')::int`,
      })
      .from(tables.fileSyncProgress)
      .where(eq(tables.fileSyncProgress.batchId, batchId));
    return {
      message,
      completedFiles: counts?.completedFiles ?? 0,
      totalFiles: counts?.totalFiles ?? 0,
    };
  }

  private publishMessageProgress(
    completion: {
      message: { threadId: number; seq: number };
      completedFiles: number;
      totalFiles: number;
    },
    status: 'downloading' | 'ready' | 'failed',
  ): void {
    this.sse.onMediaMessageDownloadProgress({
      threadId: completion.message.threadId,
      seq: completion.message.seq,
      status,
      completedFiles: completion.completedFiles,
      totalFiles: completion.totalFiles,
      activeFile: null,
    });
  }

  private completeProgressTargets(
    completion: {
      message: { threadId: number; seq: number };
      completedFiles: number;
      totalFiles: number;
    },
    status: 'ready' | 'failed',
  ): void {
    this.sse.completeMediaMessageDownloadProgress({
      threadId: completion.message.threadId,
      seq: completion.message.seq,
      status,
      completedFiles:
        status === 'ready' ? completion.totalFiles : completion.completedFiles,
      totalFiles: completion.totalFiles,
      activeFile: null,
    });
  }

  private async resumeInboundBatch(
    batchId: string,
    resetStatuses: Array<'PENDING' | 'FAILED'>,
  ): Promise<{ batchId: string; resetFiles: number }> {
    const batchRow = await this.database.db.query.pendingMedia.findFirst({
      where: eq(tables.pendingMedia.batchId, batchId),
    });
    if (!batchRow || batchRow.direction !== 'INBOUND') {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `inbound media batch ${batchId} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    const batch = requireInboundPendingMedia(batchRow);
    const stagedMessage = await this.database.db.query.message.findFirst({
      where: eq(tables.message.id, batch.messageId),
      columns: { originSeq: true, localState: true },
    });
    if (stagedMessage?.localState === 'READY')
      return { batchId, resetFiles: 0 };

    const files = await this.database.db.query.fileSyncProgress.findMany({
      where: eq(tables.fileSyncProgress.batchId, batchId),
      columns: { status: true },
    });
    if (
      files.length > 0 &&
      files.every((file) => file.status === 'COMPLETED')
    ) {
      // Local materialization needs no remote download route. The promoter rechecks
      // durable outcomes under the message lock before committing and removing coordination.
      await this.promotePendingMessage(batchId);
      return { batchId, resetFiles: 0 };
    }

    const progress = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.batchId, batchId),
      columns: { payload: true },
    });
    const persistedAuth = parseInboundDownloadAuth(progress?.payload);
    const fromAccount = persistedAuth?.fromAccount;
    const fromDomain = persistedAuth?.fromDomain;
    const toAccount = persistedAuth?.toAccount;
    if (
      !fromAccount ||
      !fromDomain ||
      !toAccount ||
      stagedMessage?.originSeq == null
    ) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        `inbound media batch ${batchId} has no persisted download route`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const reset = await this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM "Message" WHERE id = ${batch.messageId} FOR NO KEY UPDATE`,
      );
      const current = await tx.query.pendingMedia.findFirst({
        where: and(
          eq(tables.pendingMedia.id, batch.id),
          eq(tables.pendingMedia.messageId, batch.messageId),
        ),
        columns: { id: true },
      });
      if (!current) return [];
      const reset = await tx
        .update(tables.fileSyncProgress)
        .set({ status: 'PENDING', errorKind: null, updatedAt: new Date() })
        .where(
          and(
            eq(tables.fileSyncProgress.batchId, batchId),
            inArray(tables.fileSyncProgress.status, resetStatuses),
          ),
        )
        .returning({ id: tables.fileSyncProgress.id });
      await tx
        .update(tables.message)
        .set({ localState: 'STUB', updatedAt: new Date() })
        .where(
          and(
            eq(tables.message.id, batch.messageId),
            eq(tables.message.localState, 'FAILED'),
          ),
        );
      return reset;
    });
    const originSeq = stagedMessage.originSeq;
    void this.runFileSyncBatch(
      batchId,
      (digest, offset, declaredBytes, signal) =>
        this.mediaRanges.fetch(
          batch.originDomain,
          digest,
          fromAccount,
          fromDomain,
          toAccount,
          originSeq,
          offset,
          declaredBytes,
          signal,
        ),
    ).catch((error: unknown) => {
      this.logger.warn(`Inbound download execution ended: ${String(error)}`);
    });

    return { batchId, resetFiles: reset.length };
  }
}
