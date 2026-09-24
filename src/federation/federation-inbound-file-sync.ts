import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { KeyedMutex } from '../common/keyed-mutex.js';
import { DatabaseService } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { QuotaService } from '../quota/quota.service.js';
import { CasOversizeError, UploadService } from '../upload/upload.service.js';
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

  constructor(
    private readonly database: DatabaseService,
    private readonly quota: QuotaService,
    private readonly upload: UploadService,
    private readonly downloadScheduler: FederationDownloadScheduler,
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
      const namespaceId = rows[0]?.namespaceId;
      if (namespaceId && this.quota.isTripped(namespaceId)) return;
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
        namespaceId: true,
        quotaCounted: true,
      },
    });
    const originDomain = row?.originDomain;
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
        await this.chargeQuota(progressId, row?.namespaceId, declaredBytes, row);
        await this.claim(progressId, declaredBytes);
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
    } catch (error) {
      await this.handleFailure(progressId, row?.namespaceId, error);
      throw error;
    }
  }

  private async chargeQuota(
    progressId: bigint,
    namespaceId: number | undefined,
    declaredBytes: bigint,
    row: { quotaCounted: boolean } | undefined,
  ): Promise<void> {
    if (!namespaceId || row?.quotaCounted) return;
    await this.quota.preCheckFile(namespaceId, 1, declaredBytes);
    await this.quota.tickLax(namespaceId, 'files');
    if (declaredBytes > 0n) {
      await this.quota.tickFileBytes(namespaceId, declaredBytes);
    }
    await this.database.db
      .update(tables.fileSyncProgress)
      .set({ quotaCounted: true })
      .where(eq(tables.fileSyncProgress.id, progressId));
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
    await this.database.db
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
      );
  }

  private async markCoalescedWaiterReady(progressId: bigint): Promise<void> {
    await this.database.db
      .update(tables.fileSyncProgress)
      .set({ status: 'SUCCEEDED', updatedAt: new Date() })
      .where(
        and(
          eq(tables.fileSyncProgress.id, progressId),
          eq(tables.fileSyncProgress.status, 'PENDING'),
        ),
      );
  }
}
