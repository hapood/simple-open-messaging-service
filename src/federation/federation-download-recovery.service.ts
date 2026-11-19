import { Interval } from '@nestjs/schedule';
import { QuotaService } from '../quota/quota.service.js';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { fileSyncProgress, pendingMedia } from '../database/schema.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';
import { KeypairService } from './keypair.service.js';
import { FederationMediaTransferService } from './federation-media-transfer.service.js';

/**
 * Rebuilds the volatile download queue from durable inbound state after all modules have initialized.
 * Pending work is resumed; completed files finish materialization. Failed file outcomes may
 * repair interrupted message settlement, but are never reset or downloaded automatically.
 */
@Injectable()
export class FederationDownloadRecoveryService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(FederationDownloadRecoveryService.name);
  private readonly shutdown = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();

  async beforeApplicationShutdown(): Promise<void> {
    this.shutdown.abort(new Error('download recovery shutting down'));
    // Recovery performs database work, so drain before application-shutdown hooks
    // close infrastructure. Physical transfers remain owned by file sync.
    const results = await Promise.allSettled([...this.operations]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' &&
      result.reason !== this.shutdown.signal.reason
        ? [result.reason as unknown]
        : [],
    );
    if (errors.length)
      throw new AggregateError(errors, 'download recovery shutdown failed');
  }

  private async track<T>(operation: () => Promise<T>): Promise<T> {
    this.shutdown.signal.throwIfAborted();
    const work = Promise.resolve().then(() => {
      this.shutdown.signal.throwIfAborted();
      return operation();
    });
    this.operations.add(work);
    try {
      return await work;
    } finally {
      this.operations.delete(work);
    }
  }

  constructor(
    private readonly database: DatabaseService,
    private readonly inboundMediaBatches: FederationInboundMediaBatchService,
    private readonly keypair: KeypairService,
    private readonly quota: QuotaService,
    private readonly transfers: FederationMediaTransferService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    try {
      await this.track(() => this.recoverPersistedBatches());
    } catch (error) {
      if (error === this.shutdown.signal.reason) return;
      // Startup remains available; durable rows can be recovered by an administrator.
      this.logger.error(
        'Failed to scan persisted inbound media downloads for recovery',
        error,
      );
    }
  }

  private async recoverPersistedBatches(): Promise<void> {
    await this.keypair.waitUntilInitialized();
    this.shutdown.signal.throwIfAborted();
    const batches = await this.database.db
      .selectDistinct({ batchId: pendingMedia.batchId })
      .from(pendingMedia)
      .leftJoin(
        fileSyncProgress,
        eq(fileSyncProgress.batchId, pendingMedia.batchId),
      )
      .where(
        and(
          eq(pendingMedia.direction, 'INBOUND'),
          isNotNull(fileSyncProgress.id),
        ),
      );

    this.shutdown.signal.throwIfAborted();
    for (const { batchId } of batches) {
      this.shutdown.signal.throwIfAborted();
      try {
        await this.inboundMediaBatches.recoverInboundBatch(batchId);
      } catch (error) {
        if (this.shutdown.signal.aborted) throw error;
        this.logger.error(
          `Failed to resume inbound media batch ${batchId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    this.shutdown.signal.throwIfAborted();
    await this.transfers.recoverCompletedDownloads(this.shutdown.signal);
    this.shutdown.signal.throwIfAborted();
    if (batches.length > 0) {
      this.logger.log(
        `Scheduled ${batches.length} persisted inbound media batch(es) for recovery`,
      );
    }
  }

  private scanningPaused = false;

  /** A bounded local recheck resumes paused downloads after policy edits, grants, or UTC reset. */
  @Interval(30_000)
  async resumeQuotaPaused(): Promise<void> {
    if (this.scanningPaused || this.shutdown.signal.aborted) return;
    this.scanningPaused = true;
    try {
      await this.track(() => this.scanQuotaPaused());
    } catch (error) {
      if (error === this.shutdown.signal.reason) return;
      this.logger.warn(
        `quota-paused download recheck failed: ${String(error)}`,
      );
    } finally {
      this.scanningPaused = false;
    }
  }

  private async scanQuotaPaused(): Promise<void> {
    const rows = await this.database.db
      .selectDistinct({ nsid: fileSyncProgress.publisherNamespaceId })
      .from(fileSyncProgress)
      .where(
        and(
          eq(fileSyncProgress.status, 'PENDING'),
          eq(fileSyncProgress.errorKind, 'QUOTA_PAUSED'),
        ),
      );
    this.shutdown.signal.throwIfAborted();
    for (const { nsid } of rows) {
      this.shutdown.signal.throwIfAborted();
      if (nsid === null) continue;
      const exhausted = await this.quota.isExhausted(nsid, [
        'files',
        'fileBytes',
      ]);
      this.shutdown.signal.throwIfAborted();
      if (!exhausted) await this.recoverQuotaPaused(nsid);
    }
  }

  /** Re-drive only batches paused by the peer's daily file quota after an administrator raises it. */
  async wakeQuotaPaused(namespaceId: number): Promise<number> {
    return this.track(() => this.recoverQuotaPaused(namespaceId));
  }

  private async recoverQuotaPaused(namespaceId: number): Promise<number> {
    const batches = await this.database.db
      .selectDistinct({ batchId: pendingMedia.batchId })
      .from(pendingMedia)
      .innerJoin(
        fileSyncProgress,
        eq(fileSyncProgress.batchId, pendingMedia.batchId),
      )
      .where(
        and(
          eq(pendingMedia.direction, 'INBOUND'),
          eq(fileSyncProgress.publisherNamespaceId, namespaceId),
          eq(fileSyncProgress.status, 'PENDING'),
          eq(fileSyncProgress.errorKind, 'QUOTA_PAUSED'),
        ),
      );

    this.shutdown.signal.throwIfAborted();
    for (const { batchId } of batches) {
      this.shutdown.signal.throwIfAborted();
      await this.inboundMediaBatches.recoverInboundBatch(batchId);
    }
    this.shutdown.signal.throwIfAborted();
    return batches.length;
  }
}
