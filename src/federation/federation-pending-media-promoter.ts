import { and, eq, sql } from 'drizzle-orm';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { requireInboundPendingMedia } from '../message/pending-media-row.js';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import { contextualizeCasUrls } from '../upload/cas-url.js';
import { extractDigests } from '../upload/file-content.js';

export interface PendingMediaMaterializationEffect {
  dependentBatchIds: string[];
}

/**
 * Completes the local dependencies of an inbound Message STUB.
 *
 * Synchronization progress already committed when the STUB was inserted. Download completion makes
 * the Message READY and publishes READY-only local projections without touching federation cursors.
 */
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
          federationSourceDomain: true,
          sourceNamespaceId: true,
        },
      });
      if (
        !stagedIdentity ||
        stagedIdentity.originSeq === null ||
        stagedIdentity.federationSourceDomain !== batch.originDomain
        || stagedIdentity.sourceNamespaceId !== batch.namespaceId
      ) {
        throw new Error(
          `inbound PendingMedia ${batchId} has an invalid Message STUB`,
        );
      }
      await DeletedMessageService.lockFederatedIdentity(
        tx,
        stagedIdentity.threadId,
        batch.originDomain,
        batch.namespaceId,
        stagedIdentity.originSeq,
      );
      const currentJob = await tx.query.pendingMedia.findFirst({
        where: eq(tables.pendingMedia.id, batch.id),
        columns: { id: true },
      });
      if (!currentJob) return null;

      const [stagedMessage] = await tx
        .select()
        .from(tables.message)
        .where(eq(tables.message.id, batch.messageId))
        .for('update')
        .limit(1);
      if (!stagedMessage) {
        throw new Error(`inbound PendingMedia ${batchId} has no Message STUB`);
      }
      if (
        stagedMessage.localState !== 'STUB' ||
        stagedMessage.originSeq === null ||
        stagedMessage.federationSourceDomain !== batch.originDomain
      ) {
        throw new Error(
          `inbound PendingMedia ${batchId} has an invalid Message STUB`,
        );
      }

      const [thread] = await tx
        .select({ authorizationEpoch: tables.messageThread.authorizationEpoch })
        .from(tables.messageThread)
        .where(eq(tables.messageThread.id, stagedMessage.threadId))
        .for('update')
        .limit(1);
      if (!thread) throw new Error('inbound Message STUB thread is missing');
      if (thread.authorizationEpoch !== batch.expectedAuthorizationEpoch) {
        return null;
      }

      const tombstone = await tx.query.federatedMessageTombstone.findFirst({
        where: and(
          eq(tables.federatedMessageTombstone.threadId, stagedMessage.threadId),
          eq(tables.federatedMessageTombstone.sourceDomain, batch.originDomain),
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
            batch.originDomain,
            batch.dependsOnOriginSeq,
          );
      if (batch.dependsOnOriginSeq !== null && localQuoteSeq === null) {
        return null;
      }

      let storedContent = contextualizeCasUrls(
        stagedMessage.content,
        stagedMessage.threadId,
        stagedMessage.seq,
      );
      if (localQuoteSeq !== undefined && localQuoteSeq !== null) {
        const text = parseTextMessageContent(stagedMessage.content);
        if (!text) throw new Error('pending quote has invalid text content');
        storedContent = stringifyTextMessageContent({
          text: text.text,
          quote: { seq: localQuoteSeq },
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
        .delete(tables.pendingMedia)
        .where(eq(tables.pendingMedia.id, batch.id));

      return {
        threadId: stagedMessage.threadId,
        originDomain: batch.originDomain,
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
          eq(tables.message.threadId, effect.threadId),
          eq(tables.pendingMedia.originDomain, effect.originDomain),
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
    sourceDomain: string,
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
        eq(tables.pendingMedia.messageId, tables.message.id),
      )
      .where(
        and(
          eq(tables.message.threadId, threadId),
          eq(tables.message.federationSourceDomain, sourceDomain),
          eq(tables.message.originSeq, sourceSeq),
        ),
      )
      .limit(1);
    if (direct) return direct.pendingId === null ? direct.seq : null;

    const receipt = await tx.query.federationMessageReceipt.findFirst({
      where: and(
        eq(tables.federationMessageReceipt.peerDomain, sourceDomain),
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
