import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { mediaAsset } from '../database/schema.js';

/**
 * Content-addressed media blob records. A row exists iff a verified blob has been published to the
 * formal CAS shard; in-flight localization state lives in FileSyncProgress, not here.
 *
 * publishReady is the only writer: it is called after the blob bytes are verified and renamed into
 * place, so the row is the durable claim that the file is live. It is idempotent — concurrent or
 * repeat publishes of the same digest reassert the live row, and a previously reaped (isDeleted)
 * digest that is re-uploaded is resurrected. Only digest + bytes are stored; the on-disk extension
 * and MIME are not recorded here.
 *
 * See federation design doc §12.
 */
@Injectable()
export class MediaAssetService {
  constructor(private readonly database: DatabaseService) {}

  /** Record a verified blob, idempotently. Reasserts the live row on conflict (dedup, retry) and
   * resurrects a previously reaped digest. */
  async publishReady(digest: string, bytes: bigint): Promise<void> {
    await this.database.db
      .insert(mediaAsset)
      .values({ digest, bytes, isDeleted: false })
      .onConflictDoUpdate({
        target: mediaAsset.digest,
        set: { bytes, isDeleted: false, createdAt: sql`CURRENT_TIMESTAMP` },
      });
  }
}
