import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { fileSyncProgress, pendingMedia } from '../database/schema.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';

/**
 * Rebuilds the volatile download queue from durable inbound state after all modules have initialized.
 * Clean FAILED tasks are intentionally excluded; only pending work and transfers interrupted by a
 * process exit are resumed automatically.
 */
@Injectable()
export class FederationDownloadRecoveryService
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(FederationDownloadRecoveryService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly inboundMediaBatches: FederationInboundMediaBatchService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
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
            inArray(pendingMedia.status, ['pending', 'downloading']),
            or(
              inArray(fileSyncProgress.status, ['PENDING', 'DOWNLOADING']),
              isNotNull(pendingMedia.dependsOnOriginSeq),
            ),
          ),
        );

      for (const { batchId } of batches) {
        try {
          await this.inboundMediaBatches.recoverInboundBatch(batchId);
        } catch (error) {
          this.logger.error(
            `Failed to resume inbound media batch ${batchId}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      if (batches.length > 0) {
        this.logger.log(
          `Scheduled ${batches.length} persisted inbound media batch(es) for recovery`,
        );
      }
    } catch (error) {
      // Federation media recovery must not prevent the API from starting. The durable rows remain
      // available for an administrator retry if the startup scan itself fails.
      this.logger.error(
        'Failed to scan persisted inbound media downloads for recovery',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Re-drive only batches paused by the peer's daily file quota after an administrator raises it. */
  async wakeQuotaPaused(namespaceId: number): Promise<number> {
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
          eq(fileSyncProgress.namespaceId, namespaceId),
          eq(fileSyncProgress.status, 'PENDING'),
          eq(fileSyncProgress.errorKind, 'QUOTA_PAUSED'),
        ),
      );

    for (const { batchId } of batches) {
      await this.inboundMediaBatches.recoverInboundBatch(batchId);
    }
    return batches.length;
  }
}
