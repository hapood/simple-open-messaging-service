import { HttpStatus } from '@nestjs/common';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { ClientMessageFeedWriter } from '../message/client-message-feed.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { recordHostedGroupSentBoundaries } from '../message/hosted-group-sent-boundaries.js';
import { derivePreview } from '../message/message.service.js';
import type { QuotaService } from '../quota/quota.service.js';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import { contextualizeCasUrls } from '../upload/cas-url.js';
import { extractDigests } from '../upload/file-content.js';

export interface PendingMediaPromotionEffect {
  message: {
    seq: number;
    createdAt: Date;
    isDeleted: boolean;
  };
  threadId: number;
  creator: { account: string; domain: string };
  originSeq: number;
  originDomain: string;
  recipients: number[];
  historical: boolean;
  dependentBatchIds: string[];
}

export interface PendingMediaPromotionCallbacks {
  assertThreadWritable(
    tx: DatabaseTransaction,
    threadId: number,
    peerDomain: string,
    expectedFederationVersion: number,
  ): Promise<void>;
  activeLocalMemberIds(threadId: number): Promise<number[]>;
}

/** Converts a fully downloaded PendingMedia row into a committed Message. */
export class FederationPendingMediaPromoter {
  constructor(
    private readonly database: DatabaseService,
    private readonly quota: QuotaService,
  ) {}

  async promote(
    batchId: string,
    callbacks: PendingMediaPromotionCallbacks,
  ): Promise<PendingMediaPromotionEffect | null> {
    const effect = await this.database.db.transaction(async (tx) => {
      const batch = await tx.query.pendingMedia.findFirst({
        where: eq(tables.pendingMedia.batchId, batchId),
      });
      if (!batch) return null;
      const outstanding = await tx.execute(sql`
        SELECT 1 FROM "FileSyncProgress"
        WHERE "batchId" = ${batchId} AND status <> 'SUCCEEDED'
        LIMIT 1
      `);
      if ((outstanding.rows ?? []).length > 0) return null;

      const threadId = batch.threadId;
      const creator = {
        account: batch.creatorAccount,
        domain: batch.creatorDomain,
      };
      const originSeq = batch.originSeq!;
      const originDomain = batch.originDomain!;
      if (!batch.originServerTime) {
        throw new Error('inbound pending media is missing originCreatedAt');
      }
      await callbacks.assertThreadWritable(
        tx,
        threadId,
        originDomain,
        batch.expectedFederationVersion!,
      );
      await DeletedMessageService.lockFederatedIdentity(
        tx,
        threadId,
        originDomain,
        originSeq,
      );
      const tombstone = await tx.query.federatedMessageTombstone.findFirst({
        where: and(
          eq(tables.federatedMessageTombstone.threadId, threadId),
          eq(tables.federatedMessageTombstone.sourceDomain, originDomain),
          eq(tables.federatedMessageTombstone.messageSeq, originSeq),
        ),
        columns: { type: true, sourceDomain: true },
      });
      const localQuoteSeq = tombstone
        ? undefined
        : await this.resolveQuoteSeq(
            tx,
            threadId,
            originDomain,
            batch.dependsOnOriginSeq,
          );
      if (batch.dependsOnOriginSeq !== null && localQuoteSeq === null) {
        return null;
      }

      const seq = batch.useOriginSeqAsMessageSeq
        ? await this.requireUnoccupiedOriginSeq(tx, threadId, originSeq)
        : await this.allocateMessageSeq(tx, threadId);
      let storedContent = contextualizeCasUrls(batch.content, threadId, seq);
      if (localQuoteSeq !== undefined && localQuoteSeq !== null) {
        const text = parseTextMessageContent(batch.content);
        if (!text) throw new Error('pending quote has invalid text content');
        storedContent = stringifyTextMessageContent({
          text: text.text,
          quote: { seq: localQuoteSeq },
        });
      }
      const [message] = await tx
        .insert(tables.message)
        .values({
          contentType: batch.contentType as ContentType,
          content: storedContent,
          threadId,
          creatorAccount: creator.account,
          creatorDomain: creator.domain,
          seq,
          originSeq,
          clientMessageId: batch.clientMessageId,
          originServerTime: batch.originServerTime,
          federationSourceDomain: originDomain,
          isDeleted: tombstone !== undefined,
          updatedAt: new Date(),
        })
        .returning();
      await recordHostedGroupSentBoundaries(tx, threadId, creator, seq);
      const localDeletionSeq = await this.applyAssetsOrTombstone(
        tx,
        batch.content,
        message.id,
        threadId,
        seq,
        originDomain,
        originSeq,
        tombstone,
      );
      await ClientMessageFeedWriter.publishMessage(tx, threadId, seq);
      if (localDeletionSeq !== null) {
        await ClientMessageFeedWriter.publishTombstone(
          tx,
          threadId,
          localDeletionSeq,
        );
      }
      if (!batch.useOriginSeqAsMessageSeq) {
        await this.updateThreadPreview(
          tx,
          threadId,
          seq,
          batch.contentType as ContentType,
          storedContent,
          message.createdAt,
        );
      }
      const recipients = await callbacks.activeLocalMemberIds(threadId);
      await tx
        .delete(tables.fileSyncProgress)
        .where(eq(tables.fileSyncProgress.batchId, batchId));
      await tx
        .delete(tables.pendingMedia)
        .where(eq(tables.pendingMedia.id, batch.id));
      await this.quota.tickLax(originDomain, 'messages', tx, 1);
      return {
        message,
        threadId,
        creator,
        originSeq,
        originDomain,
        recipients,
        historical: batch.useOriginSeqAsMessageSeq,
      };
    });
    if (!effect) return null;
    const dependents = await this.database.db.query.pendingMedia.findMany({
      where: and(
        eq(tables.pendingMedia.threadId, effect.threadId),
        eq(tables.pendingMedia.originDomain, effect.originDomain),
        eq(tables.pendingMedia.dependsOnOriginSeq, effect.originSeq),
      ),
      columns: { batchId: true },
    });
    return {
      ...effect,
      dependentBatchIds: dependents.map(({ batchId }) => batchId),
    };
  }

  private async resolveQuoteSeq(
    tx: DatabaseTransaction,
    threadId: number,
    sourceDomain: string,
    sourceSeq: number | null,
  ): Promise<number | null | undefined> {
    if (sourceSeq === null) return undefined;
    const direct = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.federationSourceDomain, sourceDomain),
        eq(tables.message.originSeq, sourceSeq),
      ),
      columns: { seq: true },
    });
    if (direct) return direct.seq;
    const receipt = await tx.query.federationMessageReceipt.findFirst({
      where: and(
        eq(tables.federationMessageReceipt.peerDomain, sourceDomain),
        eq(tables.federationMessageReceipt.threadId, threadId),
        eq(tables.federationMessageReceipt.peerSeq, sourceSeq),
      ),
      columns: { messageId: true },
    });
    if (!receipt) return null;
    const message = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.id, receipt.messageId),
        eq(tables.message.threadId, threadId),
      ),
      columns: { seq: true },
    });
    return message?.seq ?? null;
  }

  private async requireUnoccupiedOriginSeq(
    tx: DatabaseTransaction,
    threadId: number,
    originSeq: number,
  ): Promise<number> {
    const occupied = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.seq, originSeq),
      ),
      columns: { id: true },
    });
    if (occupied) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'reverse pending message seq conflicts with an existing local message',
        HttpStatus.BAD_REQUEST,
      );
    }
    return originSeq;
  }

  private async allocateMessageSeq(
    tx: DatabaseTransaction,
    threadId: number,
  ): Promise<number> {
    const [thread] = await tx
      .update(tables.messageThread)
      .set({ curSeq: sql`${tables.messageThread.curSeq} + 1` })
      .where(eq(tables.messageThread.id, threadId))
      .returning({ curSeq: tables.messageThread.curSeq });
    if (!thread) throw new Error(`message thread ${threadId} is missing`);
    return thread.curSeq;
  }

  private async applyAssetsOrTombstone(
    tx: DatabaseTransaction,
    content: string,
    messageId: bigint,
    threadId: number,
    messageSeq: number,
    originDomain: string,
    originSeq: number,
    tombstone:
      | {
          type: (typeof tables.federatedMessageTombstone.$inferSelect)['type'];
          sourceDomain: string;
        }
      | undefined,
  ): Promise<number | null> {
    if (!tombstone) {
      for (const digest of extractDigests(content)) {
        await tx
          .insert(tables.messageAsset)
          .values({ messageId, threadId, digest })
          .onConflictDoNothing();
      }
      return null;
    }
    const deletion = await DeletedMessageService.ensureFactInTx(tx, {
      threadId,
      messageSeq,
      type: tombstone.type,
      federationSourceDomain: tombstone.sourceDomain,
      updatedAt: new Date(),
    });
    await tx
      .delete(tables.federatedMessageTombstone)
      .where(
        and(
          eq(tables.federatedMessageTombstone.threadId, threadId),
          eq(tables.federatedMessageTombstone.sourceDomain, originDomain),
          eq(tables.federatedMessageTombstone.messageSeq, originSeq),
        ),
      );
    return deletion.created ? deletion.deletionSeq : null;
  }

  private async updateThreadPreview(
    tx: DatabaseTransaction,
    threadId: number,
    seq: number,
    contentType: ContentType,
    content: string,
    arrival: Date,
  ): Promise<void> {
    await tx
      .update(tables.messageThread)
      .set({
        lastMessageSeq: seq,
        lastMessagePreview: derivePreview(contentType, content),
        lastMessageAt: arrival,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tables.messageThread.id, threadId),
          or(
            isNull(tables.messageThread.lastMessageAt),
            lt(tables.messageThread.lastMessageAt, arrival),
          ),
        ),
      );
  }
}
