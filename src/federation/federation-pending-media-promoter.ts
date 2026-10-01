import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { requireInboundPendingMedia } from '../message/pending-media-row.js';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import { extractDigests } from '../upload/file-content.js';

export interface PendingMediaMaterializationEffect {
  dependentBatchIds: string[];
}

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

  async promote(
    batchId: string,
  ): Promise<PendingMediaMaterializationEffect | null> {
    const effect = await this.database.db.transaction(async (tx) => {
      const row = await tx.query.pendingMedia.findFirst({
        where: eq(tables.pendingMedia.batchId, batchId),
      });
      if (!row) return null;
      const batch = requireInboundPendingMedia(row);
      if (!['pending', 'downloading'].includes(batch.status)) return null;

      const outstanding = await tx.execute(sql`
        SELECT 1 FROM "FileSyncProgress"
        WHERE "batchId" = ${batchId} AND status <> 'SUCCEEDED'
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
        batch.originDomain,
        batch.publisherNamespaceId,
        stagedIdentity.originSeq,
      );
      const currentJob = await tx.query.pendingMedia.findFirst({
        where: and(
          eq(tables.pendingMedia.id, batch.id),
          inArray(tables.pendingMedia.status, ['pending', 'downloading']),
        ),
        columns: { id: true },
      });
      if (!currentJob) return null;

      const [stagedMessage] = await tx
        .select()
        .from(tables.message)
        .where(eq(tables.message.id, batch.messageId))
        .for('no key update')
        .limit(1);
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

      const localQuoteSeq = tombstone
        ? undefined
        : await this.resolveQuoteSeq(
            tx,
            stagedMessage.threadId,
            batch.publisherNamespaceId,
            batch.dependsOnOriginSeq,
          );
      let storedContent = stagedMessage.content;
      if (batch.dependsOnOriginSeq !== null && !tombstone) {
        const text = parseTextMessageContent(stagedMessage.content);
        if (!text) throw new Error('pending quote has invalid text content');
        storedContent = stringifyTextMessageContent({
          text: text.text,
          quote:
            localQuoteSeq == null
              ? { seq: 0, sourceSeq: batch.dependsOnOriginSeq }
              : { seq: localQuoteSeq },
        });
      }

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

      await tx
        .delete(tables.fileSyncProgress)
        .where(eq(tables.fileSyncProgress.batchId, batchId));
      await tx
        .update(tables.pendingMedia)
        .set({ status: 'ready', failReason: null, updatedAt: new Date() })
        .where(eq(tables.pendingMedia.id, batch.id));

      return {
        threadId: stagedMessage.threadId,
        publisherNamespaceId: batch.publisherNamespaceId,
        originSeq: stagedMessage.originSeq,
      };
    });
    if (!effect) return null;

    const dependents = await this.database.db
      .select({ batchId: tables.pendingMedia.batchId })
      .from(tables.pendingMedia)
      .innerJoin(
        tables.message,
        eq(tables.message.id, tables.pendingMedia.messageId),
      )
      .where(
        and(
          eq(tables.pendingMedia.direction, 'INBOUND'),
          inArray(tables.pendingMedia.status, ['pending', 'downloading']),
          eq(tables.message.threadId, effect.threadId),
          eq(
            tables.pendingMedia.publisherNamespaceId,
            effect.publisherNamespaceId,
          ),
          eq(tables.pendingMedia.dependsOnOriginSeq, effect.originSeq),
        ),
      );
    return {
      dependentBatchIds: dependents.map(({ batchId: id }) => id),
    };
  }

  private async resolveQuoteSeq(
    tx: DatabaseTransaction,
    threadId: number,
    namespaceId: number,
    sourceSeq: number | null,
  ): Promise<number | null | undefined> {
    if (sourceSeq === null) return undefined;
    const [direct] = await tx
      .select({
        seq: tables.message.seq,
        pendingId: tables.pendingMedia.id,
      })
      .from(tables.message)
      .leftJoin(
        tables.pendingMedia,
        and(
          eq(tables.pendingMedia.messageId, tables.message.id),
          inArray(tables.pendingMedia.status, ['pending', 'downloading']),
        ),
      )
      .where(
        and(
          eq(tables.message.threadId, threadId),
          eq(tables.message.publisherNamespaceId, namespaceId),
          eq(tables.message.originSeq, sourceSeq),
        ),
      )
      .limit(1);
    if (direct) return direct.pendingId === null ? direct.seq : null;

    const receipt = await tx.query.federationMessageReceipt.findFirst({
      where: and(
        eq(tables.federationMessageReceipt.namespaceId, namespaceId),
        eq(tables.federationMessageReceipt.threadId, threadId),
        eq(tables.federationMessageReceipt.peerSeq, sourceSeq),
      ),
      columns: { messageId: true },
    });
    if (!receipt) return null;
    const resolved = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.id, receipt.messageId),
        eq(tables.message.threadId, threadId),
      ),
      columns: { seq: true },
    });
    return resolved?.seq ?? null;
  }
}
