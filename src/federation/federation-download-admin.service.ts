import { ConflictException, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';

/** Administrative commands delegate execution policy to the inbound lifecycle. */
@Injectable()
export class FederationDownloadAdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly batches: FederationInboundMediaBatchService,
  ) {}

  stop(batchId: string) {
    return this.batches.stopInboundBatch(batchId);
  }
  retry(batchId: string) {
    return this.batches.retryInboundBatch(batchId);
  }

  async clean(batchId: string) {
    return this.database.db.transaction(async (tx) => {
      // Physical deletion requires key protection against a concurrent command on this batch.
      const root = await tx.execute<{ status: string }>(sql`
        SELECT status FROM "PendingMedia" WHERE "batchId" = ${batchId} AND direction = 'INBOUND' FOR UPDATE
      `);
      if (root.rows.length === 0)
        return { clearedBatch: false, temporaryDigests: [] as string[] };
      if (!['ready', 'failed'].includes(root.rows[0].status))
        throw new ConflictException('stop the download before deleting it');
      const dependents = await tx.execute(sql`
        SELECT 1 FROM "PendingMedia" child JOIN "Message" cm ON cm.id = child."messageId"
        JOIN "PendingMedia" parent ON parent."batchId" = ${batchId}
        JOIN "Message" pm ON pm.id = parent."messageId"
        WHERE child.direction = 'INBOUND' AND cm."threadId" = pm."threadId"
          AND child."publisherNamespaceId" = parent."publisherNamespaceId"
          AND child."dependsOnOriginSeq" = pm."originSeq" AND child.status IN ('pending', 'downloading') LIMIT 1
      `);
      if (dependents.rows.length > 0)
        throw new ConflictException(
          'stop dependent downloads before deleting this task',
        );
      const files = await tx
        .delete(tables.fileSyncProgress)
        .where(eq(tables.fileSyncProgress.batchId, batchId))
        .returning({ digest: tables.fileSyncProgress.digest });
      await tx
        .delete(tables.pendingMedia)
        .where(eq(tables.pendingMedia.batchId, batchId));
      return {
        clearedBatch: true,
        temporaryDigests: [...new Set(files.map((file) => file.digest))],
      };
    });
  }
}
