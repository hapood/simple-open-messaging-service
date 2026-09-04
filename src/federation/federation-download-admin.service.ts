import { ConflictException, Injectable } from '@nestjs/common';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';

/** Read and operate the durable inbound federation-download inbox for administrators. */
@Injectable()
export class FederationDownloadAdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly batches: FederationInboundMediaBatchService,
  ) {}

  async list() {
    const batches = await this.database.db
      .select({
        batchId: tables.pendingMedia.batchId,
        threadId: tables.message.threadId,
        messageSeq: tables.message.seq,
        creatorAccount: tables.message.creatorAccount,
        creatorDomain: tables.message.creatorDomain,
        originSeq: tables.message.originSeq,
        contentType: tables.message.contentType,
        status: tables.pendingMedia.status,
        fileCnt: tables.pendingMedia.fileCnt,
        anyFailed: tables.pendingMedia.anyFailed,
        failReason: tables.pendingMedia.failReason,
        originDomain: tables.pendingMedia.originDomain,
        updatedAt: tables.pendingMedia.updatedAt,
      })
      .from(tables.pendingMedia)
      .innerJoin(
        tables.message,
        eq(tables.message.id, tables.pendingMedia.messageId),
      )
      .where(eq(tables.pendingMedia.direction, 'INBOUND'))
      .orderBy(desc(tables.pendingMedia.updatedAt));
    if (batches.length === 0) return { batches: [] };

    const files = await this.database.db.query.fileSyncProgress.findMany({
      where: inArray(
        tables.fileSyncProgress.batchId,
        batches.map((batch) => batch.batchId),
      ),
      orderBy: [asc(tables.fileSyncProgress.id)],
    });
    const filesByBatch = new Map<string, typeof files>();
    for (const file of files) {
      const items = filesByBatch.get(file.batchId) ?? [];
      items.push(file);
      filesByBatch.set(file.batchId, items);
    }

    return {
      batches: batches.map((batch) => {
        if (!batch.creatorAccount || !batch.creatorDomain) {
          throw new Error(`inbound media batch ${batch.batchId} has no author`);
        }
        return {
          batchId: batch.batchId,
          threadId: batch.threadId,
          messageSeq: batch.messageSeq,
          creator: {
            account: batch.creatorAccount,
            domain: batch.creatorDomain,
          },
          originSeq: batch.originSeq,
          contentType: batch.contentType,
          status: batch.status,
          fileCnt: batch.fileCnt,
          anyFailed: batch.anyFailed,
          failReason: batch.failReason,
          originDomain: batch.originDomain,
          updatedAt: batch.updatedAt,
          files: (filesByBatch.get(batch.batchId) ?? []).map((file) => ({
            id: file.id.toString(),
            digest: file.digest,
            kind: file.kind,
            status: file.status,
            bytesTotal: file.bytesTotal.toString(),
            bytesReceived: file.bytesReceived.toString(),
            errorKind: file.errorKind,
            updatedAt: file.updatedAt,
          })),
        };
      }),
    };
  }

  retry(batchId: string) {
    return this.batches.retryInboundBatch(batchId);
  }

  async clean(batchId: string) {
    const cleared = await this.database.db.transaction(async (tx) => {
      const root = await tx.execute<{ status: string }>(sql`
        SELECT status
          FROM "PendingMedia"
         WHERE "batchId" = ${batchId}
           AND direction = 'INBOUND'
         FOR UPDATE
      `);
      if (root.rows.length === 0) {
        return { clearedBatch: false, clearedDependents: 0, fileRows: 0 };
      }
      if (!['ready', 'failed'].includes(root.rows[0].status)) {
        throw new ConflictException(
          'an active federation download cannot be cleaned',
        );
      }
      const batchIds = await this.dependentBatchIds(tx, batchId);
      const files = await tx
        .delete(tables.fileSyncProgress)
        .where(inArray(tables.fileSyncProgress.batchId, batchIds))
        .returning({ id: tables.fileSyncProgress.id });
      const batches = await tx
        .delete(tables.pendingMedia)
        .where(inArray(tables.pendingMedia.batchId, batchIds))
        .returning({ id: tables.pendingMedia.id });
      return {
        clearedBatch: batches.length > 0,
        clearedDependents: Math.max(0, batches.length - 1),
        fileRows: files.length,
      };
    });
    return cleared;
  }

  private async dependentBatchIds(
    tx: DatabaseTransaction,
    rootBatchId: string,
  ): Promise<string[]> {
    const result = await tx.execute<{ batchId: string }>(sql`
      WITH RECURSIVE doomed AS (
        SELECT pending."batchId", staged."threadId", pending."originDomain",
               staged."originSeq"
          FROM "PendingMedia" pending
          JOIN "Message" staged ON staged.id = pending."messageId"
         WHERE pending."batchId" = ${rootBatchId}
           AND pending.direction = 'INBOUND'
        UNION
        SELECT child."batchId", child_message."threadId", child."originDomain",
               child_message."originSeq"
          FROM "PendingMedia" child
          JOIN "Message" child_message ON child_message.id = child."messageId"
          JOIN doomed parent
            ON child_message."threadId" = parent."threadId"
           AND child."originDomain" = parent."originDomain"
           AND child."dependsOnOriginSeq" = parent."originSeq"
         WHERE child.direction = 'INBOUND'
      )
      SELECT "batchId" FROM doomed
    `);
    return result.rows.map((row) => row.batchId);
  }
}
