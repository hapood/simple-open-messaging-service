import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  isStoredMediaMetadata,
  type StoredMediaMetadata,
} from './stored-media-metadata.js';
import { DatabaseService } from '../database/database.service.js';
import { mediaAsset } from '../database/schema.js';

/** Short publication boundary shared by buffered, streamed and forward-avatar publishers. */
export async function publishMediaAsset(
  database: DatabaseService,
  digest: string,
  bytes: bigint,
  publish: () => Promise<void>,
  meta?: StoredMediaMetadata,
): Promise<void> {
  if (meta !== undefined && !isStoredMediaMetadata(meta))
    throw new Error('invalid media metadata');
  const values = { digest, bytes, isDeleted: false, ...(meta ? { meta } : {}) };
  const conflict = {
    target: mediaAsset.digest,
    set: {
      bytes,
      isDeleted: false,
      createdAt: sql`CURRENT_TIMESTAMP`,
      ...(meta ? { meta } : {}),
    },
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

  async metadata(digest: string): Promise<StoredMediaMetadata | null> {
    const row = await this.database.db.query.mediaAsset.findFirst({
      where: and(
        eq(mediaAsset.digest, digest),
        eq(mediaAsset.isDeleted, false),
      ),
      columns: { meta: true },
    });
    return isStoredMediaMetadata(row?.meta) ? row.meta : null;
  }

  publishReady(
    digest: string,
    bytes: bigint,
    publish: () => Promise<void>,
    meta?: StoredMediaMetadata,
  ): Promise<void> {
    return publishMediaAsset(this.database, digest, bytes, publish, meta);
  }
}
