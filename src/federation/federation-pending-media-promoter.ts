import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { requireInboundPendingMedia } from '../message/pending-media-row.js';

import { extractDigests } from '../upload/file-content.js';

/**
 * Completes the local dependencies of an inbound Message STUB.
 *
 * The STUB already participates in unread and previews. Download completion only
 * materializes its content and assets, without advancing federation cursors or
 * publishing another device notification.
 */
@Injectable()
export class FederationPendingMediaPromoter {
  constructor(private readonly database: DatabaseService) {}

  async promote(batchId: string): Promise<boolean> {
    const promoted = await this.database.db.transaction(async (tx) => {
      const row = await tx.query.pendingMedia.findFirst({
        where: eq(tables.pendingMedia.batchId, batchId),
      });
      if (!row) return null;
      const batch = requireInboundPendingMedia(row);

      const outstanding = await tx.execute(sql`
        SELECT 1 FROM "FileSyncProgress"
        WHERE "batchId" = ${batchId} AND status <> 'COMPLETED'
        LIMIT 1
      `);
      if ((outstanding.rows ?? []).length > 0) return null;

      const stagedIdentity = await tx.query.message.findFirst({
        where: eq(tables.message.id, batch.messageId),
        columns: {
          threadId: true,
          originSeq: true,
          publisherNamespaceId: true,
        },
      });
      if (
        !stagedIdentity ||
        stagedIdentity.originSeq === null ||
        stagedIdentity.publisherNamespaceId !== batch.publisherNamespaceId
      ) {
        throw new Error(
          `inbound PendingMedia ${batchId} has an invalid Message STUB`,
        );
      }
      await DeletedMessageService.lockFederatedIdentity(
        tx,
        stagedIdentity.threadId,
        batch.publisherNamespaceId,
        stagedIdentity.originSeq,
      );
      const [stagedMessage] = await tx
        .select()
        .from(tables.message)
        .where(eq(tables.message.id, batch.messageId))
        .for('no key update')
        .limit(1);
      // Stop and retry acquire this message lock before changing coordination or
      // task outcomes. Re-read both after waiting; the pre-lock check is only a fast exit.
      const currentJob = await tx.query.pendingMedia.findFirst({
        where: and(
          eq(tables.pendingMedia.id, batch.id),
          eq(tables.pendingMedia.messageId, batch.messageId),
        ),
        columns: { id: true },
      });
      if (!currentJob) return null;
      const currentOutstanding = await tx.execute(sql`
        SELECT 1 FROM "FileSyncProgress"
        WHERE "batchId" = ${batchId} AND status <> 'COMPLETED'
        LIMIT 1
      `);
      if ((currentOutstanding.rows ?? []).length > 0) return null;
      const foreignTask = await tx.query.fileSyncProgress.findFirst({
        where: and(
          eq(tables.fileSyncProgress.batchId, batchId),
          sql`${tables.fileSyncProgress.messageId} <> ${batch.messageId}`,
        ),
        columns: { id: true },
      });
      if (foreignTask)
        throw new Error(
          `inbound media batch ${batchId} contains a task owned by another message`,
        );
      if (!stagedMessage) {
        throw new Error(`inbound PendingMedia ${batchId} has no Message STUB`);
      }
      if (
        stagedMessage.localState !== 'STUB' ||
        stagedMessage.originSeq === null ||
        stagedMessage.publisherNamespaceId !== batch.publisherNamespaceId
      ) {
        throw new Error(
          `inbound PendingMedia ${batchId} has an invalid Message STUB`,
        );
      }
      if (stagedMessage.creatorAccount === null)
        throw new Error('inbound media message has no author');

      // The captured authorization epoch governs admission and download. Once every file has been
      // verified, a later relationship change does not invalidate materialization of the retained
      // Message STUB; tombstones below still determine whether its content remains visible.
      const tombstone = await tx.query.federatedMessageTombstone.findFirst({
        where: and(
          eq(tables.federatedMessageTombstone.threadId, stagedMessage.threadId),
          eq(
            tables.federatedMessageTombstone.publisherNamespaceId,
            batch.publisherNamespaceId,
          ),
          eq(
            tables.federatedMessageTombstone.messageSeq,
            stagedMessage.originSeq,
          ),
        ),
        columns: { type: true },
      });
      if (tombstone) {
        await DeletedMessageService.markFederatedTombstoneConsumedInTx(tx, {
          threadId: stagedMessage.threadId,
          publisherNamespaceId: batch.publisherNamespaceId,
          messageSeq: stagedMessage.originSeq,
        });
      }

      if (!tombstone) {
        const requiredDigests = extractDigests(stagedMessage.content);
        if (requiredDigests.length > 0) {
          const completedFiles = await tx.query.fileSyncProgress.findMany({
            where: and(
              eq(tables.fileSyncProgress.batchId, batchId),
              eq(tables.fileSyncProgress.messageId, stagedMessage.id),
              eq(tables.fileSyncProgress.status, 'COMPLETED'),
            ),
            columns: { digest: true },
          });
          const completedDigests = new Set(
            completedFiles.map((file) => file.digest),
          );
          // No outstanding rows is not evidence that every attachment has a task.
          // Keep incomplete coordination intact for diagnosis instead of inventing outcomes.
          if (requiredDigests.some((digest) => !completedDigests.has(digest)))
            return null;
        }
      }

      // The message and its quote already have coordinates. Download completion
      // changes local availability, never sequence allocation or quote resolution.
      const storedContent = stagedMessage.content;

      await tx
        .update(tables.message)
        .set({
          content: storedContent,
          isDeleted: tombstone !== undefined,
          localState: 'READY',
          updatedAt: new Date(),
        })
        .where(eq(tables.message.id, stagedMessage.id));

      if (!tombstone) {
        const digests = extractDigests(storedContent);
        if (digests.length > 0) {
          await tx
            .insert(tables.messageAsset)
            .values(
              digests.map((digest) => ({
                messageId: stagedMessage.id,
                threadId: stagedMessage.threadId,
                digest,
              })),
            )
            .onConflictDoNothing();
        }
      }

      // Only temporary coordination ends here. Completed file tasks retain their
      // message ownership and accounting independently of this row. Deletion commits
      // atomically with message materialization and asset bindings.
      await tx
        .delete(tables.pendingMedia)
        .where(eq(tables.pendingMedia.id, batch.id));

      return true;
    });
    return promoted === true;
  }
}
