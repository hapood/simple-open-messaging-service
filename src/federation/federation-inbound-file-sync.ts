import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { DatabaseService } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { QuotaService } from '../quota/quota.service.js';
import { CasOversizeError, UploadService } from '../upload/upload.service.js';
import {
  SseService,
  type MediaProgressFileRef,
} from '../gateway/sse.service.js';
import { extractDigestFileRefs } from '../upload/file-content.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';

type FileSyncKind =
  | 'IMAGE'
  | 'VIDEO'
  | 'FILE'
  | 'AUDIO'
  | 'LINK_CARD'
  | 'BUNDLE';

class FederationDownloadTerminatedError extends Error {
  constructor() {
    super('federation download task was terminated');
  }
}

export function isFederatedMediaContentType(type: ContentType): boolean {
  switch (type) {
    case ContentType.IMAGE:
    case ContentType.FILE:
    case ContentType.VIDEO:
    case ContentType.AUDIO:
    case ContentType.GALLERY:
    case ContentType.LINK:
      return true;
    default:
      return false;
  }
}

export function federationFileSyncKind(type: ContentType): FileSyncKind {
  switch (type) {
    case ContentType.IMAGE:
      return 'IMAGE';
    case ContentType.LINK:
      return 'LINK_CARD';
    case ContentType.VIDEO:
      return 'VIDEO';
    case ContentType.AUDIO:
      return 'AUDIO';
    case ContentType.GALLERY:
      return 'BUNDLE';
    default:
      return 'FILE';
  }
}

/** Drives durable inbound file rows and serializes promotion attempts per batch. */
@Injectable()
export class FederationInboundFileSync {
  private readonly batchLocks = new KeyedMutex();
  private readonly progressTargets = new Map<
    string,
    {
      batchId: string;
      threadId: number;
      seq: number;
      file: MediaProgressFileRef;
      total: number | null;
    }
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly quota: QuotaService,
    private readonly upload: UploadService,
    private readonly downloadScheduler: FederationDownloadScheduler,
    private readonly sse: SseService,
  ) {}

  async runBatch(
    batchId: string,
    fetchChunksFor: (digest: string, offset: number) => AsyncIterable<Buffer>,
    promote: (batchId: string) => Promise<void>,
    fail: (batchId: string) => Promise<void>,
    start?: (batchId: string) => Promise<void>,
  ): Promise<void> {
    await this.batchLocks.runExclusive(batchId, async () => {
      const rows = await this.database.db.query.fileSyncProgress.findMany({
        where: and(
          eq(tables.fileSyncProgress.batchId, batchId),
          eq(tables.fileSyncProgress.status, 'PENDING'),
        ),
      });
      const originDomain = rows[0]?.originDomain;
      const publisherNamespaceId = rows[0]?.publisherNamespaceId;
      if (
        publisherNamespaceId &&
        (await this.quota.isExhausted(publisherNamespaceId, [
          'files',
          'fileBytes',
        ]))
      ) {
        await this.database.db
          .update(tables.fileSyncProgress)
          .set({ errorKind: 'QUOTA_PAUSED', updatedAt: new Date() })
          .where(
            and(
              eq(tables.fileSyncProgress.batchId, batchId),
              eq(tables.fileSyncProgress.status, 'PENDING'),
            ),
          );
        return;
      }
      if (rows.length > 0) await start?.(batchId);
      const results = await Promise.allSettled(
        rows.map((row) => {
          const peerDomain = row.originDomain ?? originDomain;
          if (!peerDomain) {
            return this.driveFile(row.id, row.digest, (offset) =>
              fetchChunksFor(row.digest, offset),
            );
          }
          return this.downloadScheduler
            .schedule(peerDomain, row.digest, () =>
              this.driveFile(row.id, row.digest, (offset) =>
                fetchChunksFor(row.digest, offset),
              ),
            )
            .then(() => this.markCoalescedWaiterReady(row.id));
        }),
      );
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (rejected) {
        const failed = await this.database.db.query.fileSyncProgress.findFirst({
          where: and(
            eq(tables.fileSyncProgress.batchId, batchId),
            eq(tables.fileSyncProgress.status, 'FAILED'),
          ),
          columns: { id: true },
        });
        if (failed) await fail(batchId);
        throw rejected.reason;
      }
      await promote(batchId);
    });
  }

  private async driveFile(
    progressId: bigint,
    digest: string,
    fetchChunks: (offset: number) => AsyncIterable<Buffer>,
  ): Promise<void> {
    const row = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.id, progressId),
      columns: {
        bytesTotal: true,
        originDomain: true,
        publisherNamespaceId: true,
      },
    });
    const _originDomain = row?.originDomain;
    const declaredBytes = row?.bytesTotal ?? 0n;
    try {
      const have = await this.database.db.query.mediaAsset.findFirst({
        where: and(
          eq(tables.mediaAsset.digest, digest),
          eq(tables.mediaAsset.isDeleted, false),
        ),
        columns: { digest: true },
      });
      if (!have) {
        await this.chargeQuota(
          progressId,
          row?.publisherNamespaceId,
          declaredBytes,
        );
        await this.claim(progressId, declaredBytes);
        await this.publishProgress(progressId, 0);
        await this.publishMessageProgress(progressId, true);
        let lastWrite = 0;
        await this.upload.saveCasFromStream(
          (offset) => this.checkedChunks(progressId, fetchChunks(offset)),
          digest,
          {
            declaredBytes:
              declaredBytes > 0n ? Number(declaredBytes) : undefined,
            onProgress: (received) => {
              if (received - lastWrite >= 256 * 1024) {
                lastWrite = received;
                void this.writeProgress(progressId, received);
              }
            },
          },
        );
      }
      const completed = await this.database.db
        .update(tables.fileSyncProgress)
        .set({ status: 'SUCCEEDED', updatedAt: new Date() })
        .where(
          and(
            eq(tables.fileSyncProgress.id, progressId),
            inArray(
              tables.fileSyncProgress.status,
              have ? ['PENDING', 'DOWNLOADING'] : ['DOWNLOADING'],
            ),
          ),
        )
        .returning({ id: tables.fileSyncProgress.id });
      if (completed.length === 0) throw new FederationDownloadTerminatedError();
      await this.publishFileTerminal(progressId, 'ready');
      await this.publishMessageProgress(progressId, false);
      this.progressTargets.delete(progressId.toString());
    } catch (error) {
      await this.handleFailure(progressId, row?.publisherNamespaceId, error);
      throw error;
    }
  }

  private readonly chargedFiles = new Map<bigint, number>();

  private async chargeQuota(
    progressId: bigint,
    namespaceId: number | undefined,
    declaredBytes: bigint,
  ): Promise<void> {
    if (!namespaceId) return;
    const day = Math.floor(Date.now() / 86400000);
    if (this.chargedFiles.get(progressId) === day) return;
    for (const [id, chargedDay] of this.chargedFiles)
      if (chargedDay !== day) this.chargedFiles.delete(id);
    await this.quota.claimFile(namespaceId, 1, declaredBytes);
    this.chargedFiles.set(progressId, day);
  }

  private async claim(
    progressId: bigint,
    declaredBytes: bigint,
  ): Promise<void> {
    const claimed = await this.database.db
      .update(tables.fileSyncProgress)
      .set({
        status: 'DOWNLOADING',
        bytesTotal: declaredBytes,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tables.fileSyncProgress.id, progressId),
          eq(tables.fileSyncProgress.status, 'PENDING'),
        ),
      )
      .returning({ id: tables.fileSyncProgress.id });
    if (claimed.length === 0) throw new FederationDownloadTerminatedError();
  }

  private async *checkedChunks(
    progressId: bigint,
    chunks: AsyncIterable<Buffer>,
  ): AsyncGenerator<Buffer> {
    for await (const chunk of chunks) {
      const current = await this.database.db.query.fileSyncProgress.findFirst({
        where: eq(tables.fileSyncProgress.id, progressId),
        columns: { status: true },
      });
      if (current?.status !== 'DOWNLOADING') {
        throw new FederationDownloadTerminatedError();
      }
      yield chunk;
    }
  }

  private async writeProgress(
    progressId: bigint,
    received: number,
  ): Promise<void> {
    await this.database.db
      .update(tables.fileSyncProgress)
      .set({ bytesReceived: BigInt(received), updatedAt: new Date() })
      .where(eq(tables.fileSyncProgress.id, progressId));
    await this.publishProgress(progressId, received);
  }

  private async publishProgress(
    progressId: bigint,
    received: number,
  ): Promise<void> {
    const target = await this.progressTarget(progressId);
    if (!target) return;
    if (
      !this.sse.hasMediaFileProgressSubscriber(
        target.threadId,
        target.seq,
        target.file.digest,
      )
    )
      return;
    this.sse.onMediaFileDownloadProgress({
      threadId: target.threadId,
      seq: target.seq,
      status: 'downloading',
      file: target.file,
      loaded: received,
      total: target.total,
    });
  }

  private async publishMessageProgress(
    progressId: bigint,
    includeActiveFile: boolean,
  ): Promise<void> {
    const target = await this.progressTarget(progressId);
    if (!target) return;
    if (
      !this.sse.hasMediaMessageProgressSubscriber(target.threadId, target.seq)
    )
      return;
    const [counts] = await this.database.db
      .select({
        totalFiles: sql<number>`COUNT(*)::int`,
        completedFiles: sql<number>`COUNT(*) FILTER (WHERE ${tables.fileSyncProgress.status} = 'SUCCEEDED')::int`,
      })
      .from(tables.fileSyncProgress)
      .where(eq(tables.fileSyncProgress.batchId, target.batchId));
    this.sse.onMediaMessageDownloadProgress({
      threadId: target.threadId,
      seq: target.seq,
      status: 'downloading',
      completedFiles: counts?.completedFiles ?? 0,
      totalFiles: counts?.totalFiles ?? 0,
      activeFile: includeActiveFile ? target.file : null,
    });
  }

  private async publishFileTerminal(
    progressId: bigint,
    status: 'ready' | 'failed',
  ): Promise<void> {
    const target = await this.progressTarget(progressId);
    if (!target) return;
    if (
      !this.sse.hasMediaFileProgressSubscriber(
        target.threadId,
        target.seq,
        target.file.digest,
      )
    )
      return;
    const row = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.id, progressId),
      columns: { bytesReceived: true, bytesTotal: true },
    });
    this.sse.completeMediaFileDownloadProgress({
      threadId: target.threadId,
      seq: target.seq,
      file: target.file,
      status,
      loaded: Number(
        row && status === 'ready' && row.bytesTotal > row.bytesReceived
          ? row.bytesTotal
          : (row?.bytesReceived ?? 0n),
      ),
      total: row && row.bytesTotal > 0n ? Number(row.bytesTotal) : target.total,
    });
  }

  private async progressTarget(progressId: bigint): Promise<{
    threadId: number;
    seq: number;
    file: MediaProgressFileRef;
    batchId: string;
    total: number | null;
  } | null> {
    const key = progressId.toString();
    const cached = this.progressTargets.get(key);
    if (cached) return cached;
    const row = await this.database.db.query.fileSyncProgress.findFirst({
      where: eq(tables.fileSyncProgress.id, progressId),
      columns: { batchId: true, digest: true, bytesTotal: true },
    });
    if (!row?.batchId) return null;
    const pending = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(tables.pendingMedia.batchId, row.batchId),
        eq(tables.pendingMedia.direction, 'INBOUND'),
      ),
      columns: { messageId: true },
    });
    if (!pending?.messageId) return null;
    const message = await this.database.db.query.message.findFirst({
      where: eq(tables.message.id, pending.messageId),
      columns: { threadId: true, seq: true, content: true },
    });
    if (!message) return null;
    const file = extractDigestFileRefs(message.content).find(
      (item) => item.digest === row.digest,
    );
    if (!file) return null;
    const target = {
      batchId: row.batchId,
      threadId: message.threadId,
      seq: message.seq,
      file,
      total: row.bytesTotal > 0n ? Number(row.bytesTotal) : null,
    };
    this.progressTargets.set(key, target);
    return target;
  }

  private async handleFailure(
    progressId: bigint,
    namespaceId: number | undefined,
    error: unknown,
  ): Promise<void> {
    if (error instanceof CasOversizeError && namespaceId) {
      await this.quota.addFileBytesDelta(namespaceId, error.extraBytes);
    }
    const quotaPaused =
      error instanceof BusinessException &&
      error.bizCode === BusinessCode.FEDERATION_QUOTA_EXCEEDED;
    if (error instanceof FederationDownloadTerminatedError) return;
    const failed = await this.database.db
      .update(tables.fileSyncProgress)
      .set({
        status: quotaPaused ? 'PENDING' : 'FAILED',
        errorKind: quotaPaused
          ? 'QUOTA_PAUSED'
          : error instanceof Error
            ? error.message.slice(0, 255)
            : 'error',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tables.fileSyncProgress.id, progressId),
          inArray(tables.fileSyncProgress.status, ['PENDING', 'DOWNLOADING']),
        ),
      )
      .returning({ id: tables.fileSyncProgress.id });
    if (!quotaPaused && failed.length > 0)
      await this.publishFileTerminal(progressId, 'failed');
    this.progressTargets.delete(progressId.toString());
  }

  private async markCoalescedWaiterReady(progressId: bigint): Promise<void> {
    const updated = await this.database.db
      .update(tables.fileSyncProgress)
      .set({ status: 'SUCCEEDED', updatedAt: new Date() })
      .where(
        and(
          eq(tables.fileSyncProgress.id, progressId),
          eq(tables.fileSyncProgress.status, 'PENDING'),
        ),
      )
      .returning({ id: tables.fileSyncProgress.id });
    if (updated.length > 0) {
      await this.publishFileTerminal(progressId, 'ready');
      await this.publishMessageProgress(progressId, false);
    }
    this.progressTargets.delete(progressId.toString());
  }
}
