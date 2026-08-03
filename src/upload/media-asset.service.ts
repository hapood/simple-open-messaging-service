import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { mediaAsset } from '../database/schema.js';

/**
 * Reference-counted content-addressed media asset records. An upload first reserves its digest as
 * PENDING, atomically publishes the file, then marks the row READY. The row makes
 * an in-flight upload visible to reconcileShards, so GC cannot mistake its freshly-published file for
 * an orphan in the small window between rename and the final database update.
 *
 * Only digest + bytes are stored beside lifecycle timestamps/status. The on-disk extension and MIME are NOT
 * recorded here — the extension is recoverable from the filename, MIME is mapped at serving time,
 * and the upload response MIME comes from the request. See the MediaAsset model doc.
 */
@Injectable()
export class MediaAssetService {
  constructor(private readonly database: DatabaseService) {}

  /** Register an upload before publishing bytes. A retry of an existing PENDING asset renews its
   * lease so stale-upload GC cannot reap an active retry; an existing READY asset is untouched. */
  async reserve(digest: string, bytes: bigint): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const locked = await tx.execute<{
        status: 'PENDING' | 'READY' | 'FAILED' | 'DELETING' | 'DELETED';
      }>(sql`
        SELECT status FROM "MediaAsset" WHERE digest = ${digest} FOR UPDATE
      `);
      const row = locked.rows[0];
      if (!row) {
        await tx
          .insert(mediaAsset)
          .values({ digest, bytes, status: 'PENDING' });
        return;
      }
      if (row.status === 'DELETING') {
        throw new Error(`CAS asset ${digest} is being deleted; retry upload`);
      }
      if (row.status === 'DELETED' || row.status === 'FAILED') {
        await tx
          .update(mediaAsset)
          .set({
            status: 'PENDING',
            bytes,
            createdAt: sql`CURRENT_TIMESTAMP`,
            stateChangedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(mediaAsset.digest, digest));
        return;
      }
      if (row.status === 'PENDING') {
        await tx
          .update(mediaAsset)
          .set({
            bytes,
            createdAt: sql`CURRENT_TIMESTAMP`,
            stateChangedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(mediaAsset.digest, digest));
      }
    });
  }

  /** Complete a successfully-published upload. Atomic under concurrent identical uploads: each
   * completion contributes exactly one reference and READY is idempotently reasserted. */
  async markReady(digest: string, bytes: bigint): Promise<void> {
    const [completed] = await this.database.db
      .update(mediaAsset)
      .set({
        status: 'READY',
        bytes,
        stateChangedAt: sql`CASE WHEN ${mediaAsset.status} = 'PENDING' THEN CURRENT_TIMESTAMP ELSE ${mediaAsset.stateChangedAt} END`,
      })
      .where(
        and(
          eq(mediaAsset.digest, digest),
          inArray(mediaAsset.status, ['PENDING', 'READY']),
        ),
      )
      .returning({ digest: mediaAsset.digest });
    if (!completed) {
      throw new Error(
        `Cannot complete CAS asset ${digest}: reservation is missing`,
      );
    }
  }

  /** Record a retryable download failure. Resumable federation downloads may retain an unpublished
   * `.part` prefix; reserve() returns FAILED to PENDING before the next locked attempt. Never demotes
   * READY: a concurrent writer may already have published valid bytes for the same digest. */
  async markFailed(digest: string): Promise<void> {
    await this.database.db
      .update(mediaAsset)
      .set({
        status: 'FAILED',
        bytes: 0n,
        stateChangedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(eq(mediaAsset.digest, digest), eq(mediaAsset.status, 'PENDING')),
      );
  }
}
