import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { requireInboundPendingMedia } from '../message/pending-media-row.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { FederationInboundFileSync } from './federation-inbound-file-sync.js';
import { FederationMediaRangeClient } from './federation-media-range-client.js';
import { FederationPendingMediaPromoter } from './federation-pending-media-promoter.js';

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
 * stalled files, fail spent jobs, and promote completed Message STUBs and their quote dependents.
 */
@Injectable()
export class FederationInboundMediaBatchService {
  constructor(
    private readonly database: DatabaseService,
    private readonly fileSync: FederationInboundFileSync,
    private readonly promoter: FederationPendingMediaPromoter,
    private readonly mediaRanges: FederationMediaRangeClient,
    private readonly participants: AccountThreadStateService,
    private readonly sse: SseService,
  ) {}

  async runFileSyncBatch(
    batchId: string,
    fetchChunksFor: (digest: string, offset: number) => AsyncIterable<Buffer>,
  ): Promise<void> {
    await this.fileSync.runBatch(
      batchId,
      fetchChunksFor,
      (id) => this.promotePendingMessage(id),
      (id) => this.failPendingMessage(id),
      async (id) => {
        const claimed = await this.claimDownloading(id);
        if (claimed) await this.publishMessageStatus(claimed, 'downloading');
      },
    );
  }

  async retryInboundBatch(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    return this.resumeInboundBatch(batchId, ['DOWNLOADING', 'FAILED']);
  }

  async recoverInboundBatch(
    batchId: string,
  ): Promise<{ batchId: string; resetFiles: number }> {
    return this.resumeInboundBatch(batchId, ['DOWNLOADING']);
  }

  /** Materialize a completed STUB and recursively wake durable quotes waiting on it. */
  async promotePendingMessage(batchId: string): Promise<void> {
    const promoted = await this.promoter.promote(batchId);
    if (!promoted) return;
    await this.publishMessageStatus(promoted, 'ready');

    for (const dependentBatchId of promoted.dependentBatchIds) {
      await this.promotePendingMessage(dependentBatchId);
    }
  }

  private async failPendingMessage(batchId: string): Promise<void> {
    const failed = await this.database.db.transaction(async (tx) => {
      const row = await tx.query.pendingMedia.findFirst({
        where: and(
          eq(tables.pendingMedia.batchId, batchId),
          eq(tables.pendingMedia.direction, 'INBOUND'),
        ),
      });
      if (!row) return null;
      const batch = requireInboundPendingMedia(row);
      const progress = await tx.query.fileSyncProgress.findFirst({
        where: and(
          eq(tables.fileSyncProgress.batchId, batchId),
          eq(tables.fileSyncProgress.status, 'FAILED'),
        ),
        columns: { errorKind: true },
      });
      const message = await tx.query.message.findFirst({
        where: eq(tables.message.id, batch.messageId),
        columns: { threadId: true, seq: true },
      });
      await tx
        .update(tables.message)
        .set({ localState: 'FAILED', updatedAt: new Date() })
        .where(
          and(
            eq(tables.message.id, batch.messageId),
            eq(tables.message.localState, 'STUB'),
          ),
        );
      await tx
        .delete(tables.fileSyncProgress)
        .where(eq(tables.fileSyncProgress.batchId, batchId));
      await tx
        .update(tables.pendingMedia)
        .set({
          status: 'failed',
          failReason: (progress?.errorKind ?? 'download failed').slice(0, 255),
          updatedAt: new Date(),
        })
        .where(eq(tables.pendingMedia.id, batch.id));
      return message;
    });
    if (failed) await this.publishMessageStatus(failed, 'failed');
  }

  private async claimDownloading(
    batchId: string,
  ): Promise<{ threadId: number; seq: number } | null> {
    return this.database.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(tables.pendingMedia)
        .set({ status: 'downloading', updatedAt: new Date() })
        .where(
          and(
            eq(tables.pendingMedia.batchId, batchId),
            eq(tables.pendingMedia.direction, 'INBOUND'),
            eq(tables.pendingMedia.status, 'pending'),
          ),
        )
        .returning({ messageId: tables.pendingMedia.messageId });
      if (claimed?.messageId == null) return null;
      return (
        (await tx.query.message.findFirst({
          where: eq(tables.message.id, claimed.messageId),
          columns: { threadId: true, seq: true },
        })) ?? null
      );
    });
  }

  async publishMessageStatus(
    message: { threadId: number; seq: number },
    status: 'pending' | 'downloading' | 'ready' | 'failed',
  ): Promise<void> {
    try {
      const recipients = await this.participants.getActiveParticipantUserIds(
        message.threadId,
      );
      for (const recipient of recipients) {
        if (!recipient.blocked) {
          this.sse.onMediaStatus(recipient.userId, { ...message, status });
        }
      }
    } catch {
      // Signal-only wake: mount/reconnect queries remain authoritative.
    }
  }

  private async resumeInboundBatch(
    batchId: string,
    resetStatuses: Array<'DOWNLOADING' | 'FAILED'>,
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
    if (batch.status === 'ready') {
      return { batchId, resetFiles: 0 };
    }
    const stagedMessage = await this.database.db.query.message.findFirst({
      where: eq(tables.message.id, batch.messageId),
      columns: { originSeq: true },
    });
    if (batch.dependsOnOriginSeq !== null) {
      await this.promotePendingMessage(batchId);
      return { batchId, resetFiles: 0 };
    }

    const reset = await this.database.db
      .update(tables.fileSyncProgress)
      .set({ status: 'PENDING', errorKind: null, updatedAt: new Date() })
      .where(
        and(
          eq(tables.fileSyncProgress.batchId, batchId),
          inArray(tables.fileSyncProgress.status, resetStatuses),
        ),
      )
      .returning({ id: tables.fileSyncProgress.id });

    await this.database.db
      .update(tables.pendingMedia)
      .set({ status: 'pending', failReason: null, updatedAt: new Date() })
      .where(eq(tables.pendingMedia.id, batch.id));

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

    const originSeq = stagedMessage.originSeq;
    void this.runFileSyncBatch(batchId, (digest, offset) =>
      this.mediaRanges.fetch(
        batch.originDomain,
        digest,
        fromAccount,
        fromDomain,
        toAccount,
        originSeq,
        offset,
      ),
    ).catch(() => undefined);

    return { batchId, resetFiles: reset.length };
  }
}
