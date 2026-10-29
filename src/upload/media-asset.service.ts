import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { mediaAsset } from '../database/schema.js';

/** Short publication boundary shared by buffered, streamed and forward-avatar publishers. */
export async function publishMediaAsset(
  database: DatabaseService,
  digest: string,
  bytes: bigint,
  publish: () => Promise<void>,
): Promise<void> {
  const values = { digest, bytes, isDeleted: false };
  const conflict = {
    target: mediaAsset.digest,
    set: { bytes, isDeleted: false, createdAt: sql`CURRENT_TIMESTAMP` },
  };
  await database.db.transaction(async (tx) => {
    // Exclude explicit reclamation across API instances only during the short publication step,
    // never for the duration of a network transfer. Ordinary publishers remain concurrent.
    await tx.execute(sql`LOCK TABLE "MediaAsset" IN ROW EXCLUSIVE MODE`);
    await publish();
    await tx.insert(mediaAsset).values(values).onConflictDoUpdate(conflict);
  });
}

/** Verified content-addressed blobs. Re-publication resurrects a reclaimed asset. */
@Injectable()
export class MediaAssetService {
  constructor(private readonly database: DatabaseService) {}

  publishReady(
    digest: string,
    bytes: bigint,
    publish: () => Promise<void>,
  ): Promise<void> {
    return publishMediaAsset(this.database, digest, bytes, publish);
  }
}
