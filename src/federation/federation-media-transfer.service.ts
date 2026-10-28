import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { CasOversizeError, UploadService } from '../upload/upload.service.js';
import { FederationDownloadScheduler } from './federation-download-scheduler.js';
import { and, eq } from 'drizzle-orm';
import { mediaAsset } from '../database/schema.js';

/** One admission/accounting boundary for peer-hosted attachment IO in every message path. */
@Injectable()
export class FederationMediaTransferService {
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
    chunks: (offset: number) => AsyncIterable<Buffer>;
    onProgress?: (received: number) => void;
  }): Promise<void> {
    // Every consumer validates its own descriptor, even if another message owns the live IO.
    await this.quota.assertFileSize(input.namespaceId, input.declaredBytes);
    await this.scheduler.schedule(input.peerDomain, input.digest, async () => {
      // Resolve policy at actual start, not queue insertion. Once admitted, IO keeps this bound.
      const maxFileBytes = await this.quota.assertFileSize(
        input.namespaceId,
        input.declaredBytes,
      );
      const have = await this.asset(input.digest);
      if (have) {
        if (have.bytes !== BigInt(input.declaredBytes))
          throw new Error('CAS file size mismatch');
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
      try {
        await this.upload.saveCasFromStream(input.chunks, input.digest, {
          declaredBytes: input.declaredBytes,
          maxFileBytes,
          onProgress: input.onProgress,
        });
      } catch (error) {
        // Only the physical transfer owns excess-byte charges; coalesced waiters never debit again.
        if (error instanceof CasOversizeError)
          await this.quota.addFileBytesDelta(
            input.namespaceId,
            error.extraBytes,
          );
        throw error;
      }
    });
    const asset = await this.asset(input.digest);
    if (!asset || asset.bytes !== BigInt(input.declaredBytes))
      throw new Error('CAS file size mismatch');
  }

  private asset(digest: string) {
    return this.database.db.query.mediaAsset.findFirst({
      where: and(
        eq(mediaAsset.digest, digest),
        eq(mediaAsset.isDeleted, false),
      ),
      columns: { bytes: true },
    });
  }
}
