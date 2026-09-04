import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import {
  ForwardBundleService,
  type ForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import { ClientThreadContentHeadWriter } from '../message/client-message-feed.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import type { Message } from '../message/message.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { contextualizeCasUrls } from '../upload/cas-url.js';
import {
  extractDigestEntries,
  extractDigests,
} from '../upload/file-content.js';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import type { S2SAddress } from './federation-address.js';
import { loadFederationConfig } from './federation.config.js';
import {
  federationFileSyncKind,
  isFederatedMediaContentType,
} from './federation-inbound-file-sync.js';
import {
  mapFederationOriginSequence,
  type MapFederationOriginSequence,
} from './federation-message-sequence-policy.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';

export interface S2SQuoteTarget {
  targetSeq: number;
}

export interface FederatedForwardCard {
  bundleId: string;
}

export interface FederationInboundMessageStoreParams {
  threadId: number;
  creator: S2SAddress;
  fetchedFromDomain: string;
  namespaceId: number;
  message: {
    originSeq: number;
    profileRev: number;
    clientMessageId: string | null;
    contentType: string;
    content: string;
    ts: number;
    quoteTarget?: S2SQuoteTarget;
  };
  expectedFederationVersion: number;
  incomingText: ReturnType<typeof parseTextMessageContent>;
  forwardCard?: FederatedForwardCard;
  forwardClosure?: ForwardWireBundle;
  originTime: Date;
  hasUnavailableAssets?: boolean;
  assetBytes?: ReadonlyMap<string, number>;
  downloadAuth?: {
    fromAccount: string;
    fromDomain: string;
    toAccount: string;
  };
  sequencePolicy?: MapFederationOriginSequence;
}

export type FederationInboundMessageStoreResult =
  | {
      kind: 'message';
      message: Message;
      storedContent: string;
      localForwardBundleId?: string;
    }
  | { kind: 'pending'; batchId: string };

/** Persists one validated inbound message while preserving its transactional identity invariants. */
@Injectable()
export class FederationInboundMessageStoreService {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly threadAccess: FederationThreadAccessService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly quota: QuotaService,
  ) {}

  async store(
    tx: DatabaseTransaction,
    params: FederationInboundMessageStoreParams,
  ): Promise<FederationInboundMessageStoreResult> {
    const {
      threadId,
      creator,
      fetchedFromDomain,
      namespaceId,
      message: incoming,
      expectedFederationVersion,
      incomingText,
      forwardCard,
      forwardClosure,
      originTime,
      hasUnavailableAssets = false,
      assetBytes,
      downloadAuth,
      sequencePolicy,
    } = params;
    if (sequencePolicy) {
      mapFederationOriginSequence(incoming.originSeq, sequencePolicy);
    }
    await this.threadAccess.assertResponseWritable(
      tx,
      threadId,
      fetchedFromDomain,
      expectedFederationVersion,
    );
    await DeletedMessageService.lockFederatedIdentity(
      tx,
      threadId,
      fetchedFromDomain,
      namespaceId,
      incoming.originSeq,
    );
    const racedMessage = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.federationSourceDomain, fetchedFromDomain),
        eq(tables.message.sourceNamespaceId, namespaceId),
        eq(tables.message.originSeq, incoming.originSeq),
      ),
    });
    if (racedMessage) {
      if (racedMessage.localState === 'STUB') {
        const pending = await tx.query.pendingMedia.findFirst({
          where: eq(tables.pendingMedia.messageId, racedMessage.id),
          columns: { batchId: true },
        });
        if (pending) return { kind: 'pending', batchId: pending.batchId };
      }
      return {
        kind: 'message',
        message: racedMessage,
        storedContent: racedMessage.content,
      };
    }
    if (sequencePolicy) {
      await this.assertMappedMessageSeqAvailable(
        tx,
        threadId,
        mapFederationOriginSequence(incoming.originSeq, sequencePolicy),
      );
    }
    const tombstone = await tx.query.federatedMessageTombstone.findFirst({
      where: and(
        eq(tables.federatedMessageTombstone.threadId, threadId),
        eq(tables.federatedMessageTombstone.sourceDomain, fetchedFromDomain),
        eq(tables.federatedMessageTombstone.sourceNamespaceId, namespaceId),
        eq(tables.federatedMessageTombstone.messageSeq, incoming.originSeq),
      ),
      columns: { type: true, sourceDomain: true },
    });

    let waitsForQuoteTarget = false;
    const quoteTargetSeq = incoming.quoteTarget?.targetSeq;
    if (!tombstone && incomingText && quoteTargetSeq !== undefined) {
      const quotedMessage = await this.findQuoteTargetMessage(
        tx,
        threadId,
        fetchedFromDomain,
        namespaceId,
        quoteTargetSeq,
      );
      if (!quotedMessage) {
        const [quotedPending] = await tx
          .select({ id: tables.pendingMedia.id })
          .from(tables.pendingMedia)
          .innerJoin(
            tables.message,
            eq(tables.message.id, tables.pendingMedia.messageId),
          )
          .where(
            and(
              eq(tables.pendingMedia.direction, 'INBOUND'),
              eq(tables.message.threadId, threadId),
              eq(tables.message.federationSourceDomain, fetchedFromDomain),
              eq(tables.message.sourceNamespaceId, namespaceId),
              eq(tables.message.originSeq, quoteTargetSeq),
            ),
          )
          .limit(1);
        if (!quotedPending) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'quoted message is missing from the ordered pull stream',
            HttpStatus.BAD_REQUEST,
          );
        }
        waitsForQuoteTarget = true;
      }
    }

    if (
      !tombstone &&
      !hasUnavailableAssets &&
      ((isFederatedMediaContentType(incoming.contentType as ContentType) &&
        (incoming.contentType !== ContentType.LINK ||
          extractDigests(incoming.content).length > 0)) ||
        waitsForQuoteTarget)
    ) {
      const batchId = randomUUID();
      const digests = extractDigestEntries(incoming.content);
      const seq = sequencePolicy
        ? mapFederationOriginSequence(incoming.originSeq, sequencePolicy)
        : await this.allocateMessageSeq(tx, threadId);
      const [thread] = await tx
        .select({ authorizationEpoch: tables.messageThread.authorizationEpoch })
        .from(tables.messageThread)
        .where(eq(tables.messageThread.id, threadId))
        .limit(1);
      if (!thread) throw new Error(`message thread ${threadId} is missing`);
      const [stub] = await tx
        .insert(tables.message)
        .values({
          contentType: incoming.contentType as ContentType,
          content: incoming.content,
          threadId,
          creatorAccount: creator.account,
          creatorDomain: creator.domain,
          creatorNamespaceId:
            creator.domain === this.config.domain ? 0 : namespaceId,
          seq,
          originSeq: incoming.originSeq,
          profileRev: incoming.profileRev,
          clientMessageId: incoming.clientMessageId,
          originServerTime: originTime,
          federationSourceDomain: fetchedFromDomain,
          sourceNamespaceId: namespaceId,
          localState: 'STUB',
          updatedAt: new Date(),
        })
        .returning({ id: tables.message.id });
      if (!sequencePolicy) {
        await ClientThreadContentHeadWriter.publishMessage(tx, threadId, seq);
      }
      await tx.insert(tables.pendingMedia).values({
        messageId: stub.id,
        direction: 'INBOUND',
        batchId,
        fileCnt: digests.length,
        originDomain: fetchedFromDomain,
        namespaceId,
        expectedAuthorizationEpoch: thread.authorizationEpoch,
        dependsOnOriginSeq: waitsForQuoteTarget ? quoteTargetSeq : null,
        updatedAt: new Date(),
      });
      for (const { digest, size } of digests) {
        await tx
          .insert(tables.fileSyncProgress)
          .values({
            batchId,
            digest,
            direction: 'INBOUND',
            kind: federationFileSyncKind(incoming.contentType as ContentType),
            status: 'PENDING',
            bytesTotal: BigInt(assetBytes?.get(digest) ?? size ?? 0),
            originDomain: fetchedFromDomain,
            namespaceId,
            payload: downloadAuth ?? null,
          })
          .onConflictDoNothing();
      }
      return { kind: 'pending', batchId };
    }

    let storedContent = incoming.content;
    let localForwardBundleId: string | undefined;
    if (forwardClosure && forwardCard) {
      const imported = await this.forwardBundles.importClosure(
        fetchedFromDomain,
        forwardClosure,
        tx,
      );
      localForwardBundleId = imported.localRootBundleId;
      storedContent = this.forwardBundles.localCardContent(
        forwardClosure,
        localForwardBundleId,
      );
    }
    const seq = sequencePolicy
      ? mapFederationOriginSequence(incoming.originSeq, sequencePolicy)
      : await this.allocateMessageSeq(tx, threadId);
    storedContent = contextualizeCasUrls(storedContent, threadId, seq);
    if (incomingText && incoming.quoteTarget) {
      const localQuoteSeq = await this.resolveLocalQuoteSeq(
        tx,
        threadId,
        fetchedFromDomain,
        namespaceId,
        incoming.quoteTarget,
      );
      storedContent = stringifyTextMessageContent({
        text: incomingText.text,
        quote: { seq: localQuoteSeq },
      });
    }
    const [message] = await tx
      .insert(tables.message)
      .values({
        contentType: incoming.contentType as ContentType,
        content: storedContent,
        threadId,
        creatorAccount: creator.account,
        creatorDomain: creator.domain,
        creatorNamespaceId:
          creator.domain === this.config.domain ? 0 : namespaceId,
        seq,
        originSeq: incoming.originSeq,
        profileRev: incoming.profileRev,
        clientMessageId: incoming.clientMessageId,
        originServerTime: originTime,
        federationSourceDomain: fetchedFromDomain,
        sourceNamespaceId: namespaceId,
        isDeleted: tombstone !== undefined,
        localState: sequencePolicy ? 'STUB' : 'READY',
        updatedAt: new Date(),
      })
      .returning();
    let localDeletionSeq: number | null = null;
    if (tombstone && !sequencePolicy) {
      const deletion = await DeletedMessageService.ensureFactInTx(tx, {
        threadId,
        messageSeq: seq,
        type: tombstone.type,
        federationSourceDomain: tombstone.sourceDomain,
        updatedAt: new Date(),
      });
      localDeletionSeq = deletion.created ? deletion.deletionSeq : null;
      await tx
        .delete(tables.federatedMessageTombstone)
        .where(
          and(
            eq(tables.federatedMessageTombstone.threadId, threadId),
            eq(
              tables.federatedMessageTombstone.sourceDomain,
              fetchedFromDomain,
            ),
            eq(tables.federatedMessageTombstone.sourceNamespaceId, namespaceId),
            eq(tables.federatedMessageTombstone.messageSeq, incoming.originSeq),
          ),
        );
    }
    if (!sequencePolicy) {
      await ClientThreadContentHeadWriter.publishMessage(tx, threadId, seq);
    }
    if (localDeletionSeq !== null) {
      await ClientThreadContentHeadWriter.publishTombstone(
        tx,
        threadId,
        localDeletionSeq,
      );
    }
    if (localForwardBundleId) {
      await tx.insert(tables.forwardMessage).values({
        messageId: message.id,
        bundleId: localForwardBundleId,
      });
    }
    await this.quota.tickLax(fetchedFromDomain, 'messages', tx, 1);
    if (forwardClosure) {
      await this.quota.tickLax(
        fetchedFromDomain,
        'files',
        tx,
        forwardClosure.children.length + 1,
      );
    }
    return { kind: 'message', message, storedContent, localForwardBundleId };
  }

  async resolveLocalQuoteSeq(
    tx: DatabaseTransaction,
    threadId: number,
    sourceDomain: string,
    namespaceId: number,
    target: S2SQuoteTarget,
  ): Promise<number> {
    const message = await this.findQuoteTargetMessage(
      tx,
      threadId,
      sourceDomain,
      namespaceId,
      target.targetSeq,
    );
    if (!message) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'quoted message is missing from the ordered pull stream',
        HttpStatus.BAD_REQUEST,
      );
    }
    return message.seq;
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

  private async assertMappedMessageSeqAvailable(
    tx: DatabaseTransaction,
    threadId: number,
    seq: number,
  ): Promise<void> {
    const thread = await tx.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
      columns: { curSeq: true },
    });
    if (!thread) throw new Error(`message thread ${threadId} is missing`);
    if (seq > thread.curSeq) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'reverse message seq is beyond the receiver-local thread tail',
        HttpStatus.BAD_REQUEST,
      );
    }
    const occupied = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.seq, seq),
      ),
      columns: { id: true },
    });
    if (occupied) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'reverse message seq conflicts with an existing local message',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async findQuoteTargetMessage(
    tx: DatabaseTransaction,
    threadId: number,
    sourceDomain: string,
    namespaceId: number,
    sourceSeq: number,
  ): Promise<{ id: bigint; seq: number } | undefined> {
    const direct = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.federationSourceDomain, sourceDomain),
        eq(tables.message.sourceNamespaceId, namespaceId),
        eq(tables.message.originSeq, sourceSeq),
      ),
      columns: { id: true, seq: true },
    });
    if (direct) return direct;
    const receipt = await tx.query.federationMessageReceipt.findFirst({
      where: and(
        eq(tables.federationMessageReceipt.peerDomain, sourceDomain),
        eq(tables.federationMessageReceipt.namespaceId, namespaceId),
        eq(tables.federationMessageReceipt.threadId, threadId),
        eq(tables.federationMessageReceipt.peerSeq, sourceSeq),
      ),
      columns: { messageId: true },
    });
    if (!receipt) return undefined;
    return tx.query.message.findFirst({
      where: and(
        eq(tables.message.id, receipt.messageId),
        eq(tables.message.threadId, threadId),
      ),
      columns: { id: true, seq: true },
    });
  }
}
