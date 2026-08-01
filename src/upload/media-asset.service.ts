import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { mediaAsset } from '../database/schema.js';

/**
 * Reference-counted content-addressed media asset records. Every successful CAS upload upserts a row
 * here with refs++ (a dedup hit lands on the same row and increments); a future message-delete path
 * decrements; the GC sweep deletes rows whose refs reach 0 along with their shard file.
 *
 * The upsert compiles to `INSERT ... ON CONFLICT (digest) DO UPDATE SET refs = refs + 1`, which is
 * atomic under concurrency — two simultaneous uploads of identical bytes both succeed and land at
 * refs = 2. The atomic upsert prevents duplicate-digest races.
 * instead of a clean upsert.
 *
 * File-write ordering is the caller's job (UploadService.saveCas): write the shard file FIRST, then
 * call upsertAndRef. That way a DB failure leaves a reclaimable orphan file (refs = 0 → GC'd), never
 * a dangling DB reference to a missing file.
 *
 * Only digest + bytes are stored (besides refs/createdAt). The on-disk extension and MIME are NOT
 * recorded here — the extension is recoverable from the filename, MIME is mapped at serving time,
 * and the upload response MIME comes from the request. See the MediaAsset model doc.
 */
@Injectable()
export class MediaAssetService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Record a reference to a CAS asset: create with refs = 1, or increment refs on conflict. Atomic
   * under concurrent identical uploads. Throws on non-P2002 errors so the upload route surfaces a 500
   * and the client retries (the shard file already exists; the retry re-hashes to the same digest,
   * rewrites it idempotently, and re-upserts to increment refs).
   */
  async upsertAndRef(digest: string, bytes: bigint): Promise<void> {
    await this.database.db
      .insert(mediaAsset)
      .values({ digest, bytes, refs: 1 })
      .onConflictDoUpdate({
        target: mediaAsset.digest,
        set: { refs: sql`${mediaAsset.refs} + 1` },
      });
  }

  /**
   * Decrement the ref count. Intended for the future message-delete path (not wired today — messages
   * are permanent for now, so refs only grow). Returns the post-decrement count so the caller can
   * reap the file when it hits 0, or null if the row is already gone (nothing to decrement).
   */
  async decrement(digest: string): Promise<number | null> {
    const [row] = await this.database.db
      .update(mediaAsset)
      .set({ refs: sql`${mediaAsset.refs} - 1` })
      .where(eq(mediaAsset.digest, digest))
      .returning({ refs: mediaAsset.refs });
    return row?.refs ?? null;
  }
}
