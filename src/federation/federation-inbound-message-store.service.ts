import { toClientIdentity } from '../common/client-identity.js';
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
  type InboundForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import { enqueueMessageFanoutsInTx } from '../message/thread-fanout-task.js';
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
import type { ThreadContentLock } from '../common/locks/thread-content-lock.js';
import {
  storeFederationQuote,
  type FederationQuoteTarget,
} from './federation-quote-target.js';

type S2SQuoteTarget = FederationQuoteTarget;

export interface FederatedForwardCard {
  bundleId: string;
}

export interface FederationInboundMessageStoreParams {
  threadLock?: ThreadContentLock;
  threadId: number;
  creator: S2SAddress;
  fetchedFromDomain: string;
  namespaceId: number;
  message: {
    originSeq: number;
    profileRev: number;
    contentType: string;
    content: string;
    ts: number;
    quoteTarget?: S2SQuoteTarget;
  };
  expectedFederationVersion: number;
  incomingText: ReturnType<typeof parseTextMessageContent>;
  forwardCard?: FederatedForwardCard;
  /** Raw peer bundle — untrusted until importClosure validates it inside store(). */
  forwardClosure?: InboundForwardWireBundle;
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
  | { kind: 'pending'; batchId: string; seq: number };

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
      creator: incomingCreator,
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
    const creator = toClientIdentity(
      { ...incomingCreator, namespaceId },
      this.config.domain,
    );
    if (sequencePolicy) {
      mapFederationOriginSequence(incoming.originSeq, sequencePolicy);
    }
    await this.threadAccess.assertResponseWritable(
      tx,
      threadId,
      fetchedFromDomain,
      expectedFederationVersion,
    );
    const threadLock = await DeletedMessageService.lockFederatedIdentity(
      tx,
      threadId,
      fetchedFromDomain,
      namespaceId,
      incoming.originSeq,
      params.threadLock,
    );
    const racedMessage = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
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
        if (pending)
          return {
            kind: 'pending',
            batchId: pending.batchId,
            seq: racedMessage.seq,
          };
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
        eq(tables.federatedMessageTombstone.sourceNamespaceId, namespaceId),
        eq(tables.federatedMessageTombstone.messageSeq, incoming.originSeq),
      ),
      columns: { type: true },
    });

    if (
      !tombstone &&
      !hasUnavailableAssets &&
      isFederatedMediaContentType(incoming.contentType as ContentType) &&
      (incoming.contentType !== ContentType.LINK ||
        extractDigests(incoming.content).length > 0)
    ) {
      const batchId = randomUUID();
      const digests = extractDigestEntries(incoming.content);
      const seq = sequencePolicy
        ? mapFederationOriginSequence(incoming.originSeq, sequencePolicy)
        : await this.allocateMessageSeq(tx, threadId);
      const storedContent = contextualizeCasUrls(
        incoming.content,
        threadId,
        seq,
      );
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
          content: storedContent,
          threadId,
          creatorAccount: creator.account,
          creatorDomain: creator.domain,
          creatorNamespaceId: creator.namespaceId,
          seq,
          originSeq: incoming.originSeq,
          profileRev: incoming.profileRev,
          originServerTime: originTime,
          sourceNamespaceId: namespaceId,
          localState: 'STUB',
          updatedAt: new Date(),
        })
        .returning({ id: tables.message.id });
      // Mapped reverse history occupies reserved slots below the read boundary.
      // It is not a new unread interval, including when media arrives as a stub.
      if (!sequencePolicy)
        await this.enqueueFanout(tx, threadLock, threadId, incoming.profileRev);
      await tx.insert(tables.pendingMedia).values({
        messageId: stub.id,
        direction: 'INBOUND',
        batchId,
        fileCnt: digests.length,
        originDomain: fetchedFromDomain,
        namespaceId,
        expectedAuthorizationEpoch: thread.authorizationEpoch,
        dependsOnOriginSeq: null,
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
      return { kind: 'pending', batchId, seq };
    }

    let storedContent = incoming.content;
    let localForwardBundleId: string | undefined;
    // Set iff importClosure accepted the closure below; the card builder and the
    // file-quota tick read the closure only through it.
    let validatedClosure: ForwardWireBundle | undefined;
    if (forwardClosure && forwardCard) {
      const imported = await this.forwardBundles.importClosure(
        fetchedFromDomain,
        forwardClosure,
        tx,
      );
      localForwardBundleId = imported.localRootBundleId;
      // Every runtime check in importClosure passed (or the bundle was already
      // imported): this is the untrusted→trusted crossing.
      validatedClosure = forwardClosure as ForwardWireBundle;
      storedContent = this.forwardBundles.localCardContent(
        validatedClosure,
        localForwardBundleId,
      );
    }
    const seq = sequencePolicy
      ? mapFederationOriginSequence(incoming.originSeq, sequencePolicy)
      : await this.allocateMessageSeq(tx, threadId);
    storedContent = contextualizeCasUrls(storedContent, threadId, seq);
    if (incomingText && incoming.quoteTarget !== undefined) {
      storedContent = stringifyTextMessageContent({
        text: incomingText.text,
        // Missing references are presentation state, not a reason to reject the message.
        quote: storeFederationQuote(incoming.quoteTarget, namespaceId),
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
        creatorNamespaceId: creator.namespaceId,
        seq,
        originSeq: incoming.originSeq,
        profileRev: incoming.profileRev,
        originServerTime: originTime,
        sourceNamespaceId: namespaceId,
        isDeleted: tombstone !== undefined,
        localState: sequencePolicy ? 'STUB' : 'READY',
        updatedAt: new Date(),
      })
      .returning();
    if (tombstone) {
      await DeletedMessageService.ensureFactInTx(tx, {
        threadLock,
        threadId,
        messageSeq: seq,
        type: tombstone.type,
        sourceNamespaceId: namespaceId,
        updatedAt: new Date(),
      });
      await tx
        .delete(tables.federatedMessageTombstone)
        .where(
          and(
            eq(tables.federatedMessageTombstone.threadId, threadId),
            eq(tables.federatedMessageTombstone.sourceNamespaceId, namespaceId),
            eq(tables.federatedMessageTombstone.messageSeq, incoming.originSeq),
          ),
        );
    }
    if (!sequencePolicy)
      await this.enqueueFanout(tx, threadLock, threadId, incoming.profileRev);
    if (localForwardBundleId) {
      await tx.insert(tables.forwardMessage).values({
        messageId: message.id,
        bundleId: localForwardBundleId,
      });
    }
    await this.quota.tickLax(fetchedFromDomain, 'messages', tx, 1);
    if (validatedClosure) {
      await this.quota.tickLax(
        fetchedFromDomain,
        'files',
        tx,
        validatedClosure.children.length + 1,
      );
    }
    return { kind: 'message', message, storedContent, localForwardBundleId };
  }

  private async enqueueFanout(
    tx: DatabaseTransaction,
    lock: ThreadContentLock,
    threadId: number,
    profileRev: number,
  ): Promise<void> {
    const head = await tx.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
      columns: { curSeq: true, tombstoneEndSeq: true, type: true },
    });
    if (!head) throw new Error('Inbound message thread disappeared');
    await enqueueMessageFanoutsInTx(tx, lock, {
      threadId,
      messageEndSeq: head.curSeq,
      tombstoneEndSeq: head.tombstoneEndSeq,
      // Only a P2P counterpart's revision decorates the thread feed; group
      // members carry their own revisions inside roster facts.
      ...(head.type === 'P2P' && profileRev > 0 ? { profileRev } : {}),
    });
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
}
