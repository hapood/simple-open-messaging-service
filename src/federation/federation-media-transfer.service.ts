import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { CasOversizeError, UploadService } from '../upload/upload.service.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import { and, eq, gt, ne } from 'drizzle-orm';
import { isStoredMediaMetadata } from '../upload/stored-media-metadata.js';
import { fileSyncProgress, mediaAsset } from '../database/schema.js';

/** One admission/accounting boundary for peer-hosted attachment IO in every message path. */
@Injectable()
export class FederationMediaTransferService {
  private readonly logger = new Logger(FederationMediaTransferService.name);
  private readonly charged = new Map<string, number>();
  constructor(
    private readonly database: DatabaseService,
    private readonly quota: QuotaService,
    private readonly upload: UploadService,
    private readonly scheduler: FederationDownloadScheduler,
  ) {}

  async receive(input: {
    namespaceId: number;
    peerDomain: string;
    digest: string;
    declaredBytes: number;
    chunks: (offset: number, signal: AbortSignal) => AsyncIterable<Buffer>;
    signal: AbortSignal;
    onProgress?: (received: number) => void;
  }): Promise<void> {
    // Every consumer validates its own descriptor, even if another message owns the live IO.
    input.signal.throwIfAborted();
    await this.quota.assertFileSize(input.namespaceId, input.declaredBytes);
    input.signal.throwIfAborted();
    await this.scheduler.schedule(
      input.peerDomain,
      input.digest,
      async (report, signal) => {
        // Resolve policy at actual start, not queue insertion. Once admitted, IO keeps this bound.
        const maxFileBytes = await this.quota.assertFileSize(
          input.namespaceId,
          input.declaredBytes,
        );
        signal.throwIfAborted();
        const have = await this.asset(input.digest);
        signal.throwIfAborted();
        if (have) {
          if (have.bytes !== BigInt(input.declaredBytes))
            throw new Error('CAS file size mismatch');
          if (!isStoredMediaMetadata(have.meta))
            await this.upload.ensureLocalMetadata(input.digest, signal);
          return;
        }
        const day = Math.floor(Date.now() / 86400000);
        for (const [key, chargedDay] of this.charged)
          if (chargedDay !== day) this.charged.delete(key);
        // A changed descriptor is not a retry of the same admitted object. Do not let an
        // earlier undersized declaration exempt a later larger declaration from charging.
        const key = JSON.stringify([
          input.namespaceId,
          input.digest,
          input.declaredBytes,
        ]);
        if (this.charged.get(key) !== day) {
          await this.quota.claimFile(
            input.namespaceId,
            1,
            BigInt(input.declaredBytes),
          );
          this.charged.set(key, day);
        }
        signal.throwIfAborted();
        try {
          await this.upload.saveCasFromStream(
            (offset) => input.chunks(offset, signal),
            input.digest,
            {
              declaredBytes: input.declaredBytes,
              signal,
              maxFileBytes,
              onProgress: (received) => {
                if (signal.aborted) return;
                report({ received, total: input.declaredBytes });
              },
            },
          );
        } catch (error) {
          // Only the physical transfer owns excess-byte charges; coalesced waiters never debit again.
          if (error instanceof CasOversizeError) {
            try {
              await this.quota.addFileBytesDelta(
                input.namespaceId,
                error.extraBytes,
              );
            } catch (accountingError) {
              throw new AggregateError(
                [error, accountingError],
                'oversized media transfer accounting failed',
              );
            }
          }
          throw error;
        }
      },
      input.declaredBytes,
      input.signal,
      input.onProgress
        ? ({ received }) => input.onProgress!(received)
        : undefined,
    );
    input.signal.throwIfAborted();
    const asset = await this.asset(input.digest);
    input.signal.throwIfAborted();
    if (!asset || asset.bytes !== BigInt(input.declaredBytes))
      throw new Error('CAS file size mismatch');
  }

  /** Recover cleanup even when successful promotion already removed temporary coordination. */
  async recoverCompletedDownloads(signal: AbortSignal): Promise<void> {
    let after = '';
    while (true) {
      signal.throwIfAborted();
      const rows = await this.database.db
        .selectDistinct({ digest: fileSyncProgress.digest })
        .from(fileSyncProgress)
        .where(
          and(
            eq(fileSyncProgress.status, 'COMPLETED'),
            gt(fileSyncProgress.digest, after),
          ),
        )
        .orderBy(fileSyncProgress.digest)
        .limit(100);
      signal.throwIfAborted();
      if (rows.length === 0) return;
      for (const { digest } of rows) {
        signal.throwIfAborted();
        try {
          await this.cleanupCompletedDownload(digest);
        } catch (error) {
          this.logger.error(
            `Completed download ${digest} temporary cleanup failed`,
            error,
          );
        }
      }
      after = rows[rows.length - 1].digest;
    }
  }

  /** Called only after a durable task completion. Failed/pending siblings still own the checkpoint. */
  async cleanupCompletedDownload(digest: string): Promise<void> {
    await this.upload.withCasDigestLock(digest, async () => {
      const unfinished =
        await this.database.db.query.fileSyncProgress.findFirst({
          where: and(
            eq(fileSyncProgress.digest, digest),
            ne(fileSyncProgress.status, 'COMPLETED'),
          ),
          columns: { id: true },
        });
      if (unfinished) return;
      // Never discard the only recoverable source if the published asset was reclaimed.
      const asset = await this.asset(digest);
      if (!asset) return;
      await this.upload.removePublishedCasTemporary(digest, asset.bytes);
    });
  }

  waitForStoppedDigest(digest: string): Promise<void> {
    return this.scheduler.waitForDigest(digest);
  }

  private asset(digest: string) {
    return this.database.db.query.mediaAsset.findFirst({
      where: and(
        eq(mediaAsset.digest, digest),
        eq(mediaAsset.isDeleted, false),
      ),
      columns: { bytes: true, meta: true },
    });
  }
}
