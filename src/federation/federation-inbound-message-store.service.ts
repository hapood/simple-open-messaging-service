import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  groupState as groupStateTable,
  groupStateFields,
} from '../group/shared/group-state.js';
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
import {
  extractDigestEntries,
  extractDigests,
} from '../upload/file-content.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import { withMessageContentQuote } from '../../shared/message-content-quote.js';
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
  creator: { account: string; namespaceId: number };
  fetchedFromDomain: string;
  namespaceId: number;
  profileNamespaceId: number;
  message: {
    originSeq: number;
    profileRev: number;
    contentType: string;
    content: string;
    ts: number;
    quoteTarget?: S2SQuoteTarget;
    quoteDigest?: string;
  };
  /** Digest of the canonical message payload, including assets and quoteDigest. */
  payloadDigest: string;
  /** Canonical fingerprint of every immutable field in the received wire envelope. */
  federationEnvelopeDigest: string;
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
  private readonly logger = new Logger(
    FederationInboundMessageStoreService.name,
  );

  constructor(
    private readonly threadAccess: FederationThreadAccessService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly quota: QuotaService,
    private readonly deletedMessages: DeletedMessageService,
  ) {}

  /** Applies one processing receipt without changing local materialization state. Payload
   * verification is monotonic: a mismatch records CONFLICT and can never be washed back to
   * VERIFIED by a later receipt. Envelope-coordinate conflicts remain malformed. */
  async applyProcessingReceipt(
    tx: DatabaseTransaction,
    params: {
      threadLock?: ThreadContentLock;
      threadId: number;
      creatorAccount: string;
      profileNamespaceId: number;
      federationVersion: number;
      fetchedFromDomain: string;
      namespaceId: number;
      /** The peer's own coordinate for the accepted message (`item.seq`). */
      peerSeq: number;
      /** This server's coordinate of the published message (`item.originSeq`). */
      originSeq: number;
      /** Epoch ms of the published message's `createdAt` (`item.originCreatedAt`). */
      originCreatedAt: number;
      /** Whether the wire thread is P2P (`'peerAccount' in item.thread`) — selects the pending
       *  receipt authority (`P2P_HOME` vs `GROUP_ORIGIN`). */
      isP2PThread: boolean;
      /** Pre-rendered `federatedMessageLogContext` for the unmatched-source warning. */
      logContext: string;
      /** `new Date(item.createdAt)` — the peer's acceptance time. */
      sourceTime: Date;
      /** Group authority coordinate carried by a returning copy. */
      publishedProfileNamespaceId?: number;
      /** Digest over the canonical message payload of the receipt. */
      payloadDigest: string;
      contentType: string;
      profileRev: number;
      sequencePolicy?: MapFederationOriginSequence;
    },
  ): Promise<void> {
    const {
      threadLock,
      threadId,
      creatorAccount,
      profileNamespaceId,
      federationVersion,
      fetchedFromDomain: domain,
      namespaceId,
      peerSeq,
      originSeq,
      originCreatedAt,
      isP2PThread,
      logContext,
      sourceTime,
      payloadDigest,
      contentType,
      profileRev,
      sequencePolicy,
    } = params;
    const localSourceMessage = await tx.query.message.findFirst({
      where: and(
        eq(tables.message.threadId, threadId),
        eq(tables.message.seq, originSeq),
        eq(tables.message.creatorAccount, creatorAccount),
        !isP2PThread && params.publishedProfileNamespaceId !== undefined
          ? sql`CASE WHEN EXISTS (
              SELECT 1 FROM "MessageThread" receipt_thread
              WHERE receipt_thread.id = ${threadId}
                AND receipt_thread."authorityNamespaceId" = 0
            ) THEN
              (CASE WHEN ${tables.message.profileNamespaceId} = 0
                THEN ${tables.message.publisherNamespaceId}
                ELSE ${tables.message.profileNamespaceId} END)
                = ${params.publishedProfileNamespaceId}
            ELSE ${tables.message.profileNamespaceId} = ${profileNamespaceId} END`
          : eq(tables.message.profileNamespaceId, profileNamespaceId),
      ),
      columns: {
        id: true,
        createdAt: true,
        payloadDigest: true,
        contentType: true,
        profileRev: true,
        federationPayloadVerification: true,
        localState: true,
      },
    });
    if (!localSourceMessage) {
      this.logger.warn(
        `processing receipt has no matching published message: ${logContext}`,
      );
      return;
    }
    if (
      localSourceMessage.createdAt.getTime() !== originCreatedAt ||
      localSourceMessage.contentType !== contentType ||
      localSourceMessage.profileRev !== profileRev
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'processing receipt conflicts with the published message envelope',
        HttpStatus.BAD_REQUEST,
      );
    }
    const verification =
      localSourceMessage.payloadDigest === null ||
      localSourceMessage.payloadDigest === payloadDigest
        ? localSourceMessage.federationPayloadVerification === 'CONFLICT'
          ? 'CONFLICT'
          : 'VERIFIED'
        : 'CONFLICT';
    await tx
      .update(tables.message)
      .set({ federationPayloadVerification: verification })
      .where(eq(tables.message.id, localSourceMessage.id));
    if (sequencePolicy) {
      await DeletedMessageService.lockFederatedIdentity(
        tx,
        threadId,
        domain,
        namespaceId,
        peerSeq,
      );
    }
    await this.deletedMessages.applyPendingReceiptInTx(tx, {
      threadId,
      peerSeq,
      peerDomain: domain,
      namespaceId,
      authority: isP2PThread ? 'P2P_HOME' : 'GROUP_ORIGIN',
      expectedFederationVersion: federationVersion,
      threadLock,
      resolvedMessage: localSourceMessage as Message,
    });
    // Only the group's authoritative server can confirm a local submission.
    // Other receipts retain peer-coordinate aliases for reference resolution;
    // they cannot overwrite the original message's authority coordinate.
    const [authoritativeGroup] =
      profileNamespaceId === 0 && !isP2PThread
        ? await tx
            .select({ id: groupStateTable.id })
            .from(tables.messageThread)
            .innerJoin(
              groupStateTable,
              eq(groupStateTable.id, tables.messageThread.id),
            )
            .where(
              and(
                eq(tables.messageThread.id, threadId),
                eq(groupStateFields.domain, domain),
                eq(groupStateFields.namespaceId, namespaceId),
              ),
            )
            .limit(1)
        : [];
    // The group origin or the P2P counterpart owns the authoritative timeline;
    // either one may confirm a locally authored submission by writing the
    // peer-assigned coordinate onto the original row.
    const coordinateOwner =
      profileNamespaceId === 0 && (isP2PThread || !!authoritativeGroup);
    if (coordinateOwner) {
      const confirmed = await tx
        .update(tables.message)
        .set({
          originSeq: peerSeq,
          originServerTime: sourceTime,
        })
        .where(
          and(
            eq(tables.message.id, localSourceMessage.id),
            or(
              eq(tables.message.publisherNamespaceId, 0),
              and(
                eq(tables.message.publisherNamespaceId, namespaceId),
                eq(tables.message.originSeq, peerSeq),
                sql`${tables.message.originServerTime} IS NOT DISTINCT FROM ${sourceTime}`,
              ),
            ),
          ),
        )
        .returning({ id: tables.message.id });
      if (confirmed.length !== 1) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'peer confirmation conflicts with the retained message coordinate',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
  }

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
      forwardCard,
      forwardClosure,
      originTime,
      hasUnavailableAssets = false,
      assetBytes,
      downloadAuth,
      sequencePolicy,
      payloadDigest: wireDigest,
    } = params;
    const creator = incomingCreator;
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
        eq(tables.message.publisherNamespaceId, namespaceId),
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
        eq(tables.federatedMessageTombstone.publisherNamespaceId, namespaceId),
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
      const storedContent = incoming.content;
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
          payloadDigest: wireDigest,
          federationEnvelopeDigest: params.federationEnvelopeDigest,
          threadId,
          creatorAccount: creator.account,
          profileNamespaceId: creator.namespaceId,
          seq,
          originSeq: incoming.originSeq,
          profileRev: incoming.profileRev,
          originServerTime: originTime,
          publisherNamespaceId: namespaceId,
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
        publisherNamespaceId: namespaceId,
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
            kind: federationFileSyncKind(incoming.contentType as ContentType),
            status: 'PENDING',
            bytesTotal: BigInt(assetBytes?.get(digest) ?? size ?? 0),
            originDomain: fetchedFromDomain,
            publisherNamespaceId: namespaceId,
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
        imported.depth,
      );
    }
    const seq = sequencePolicy
      ? mapFederationOriginSequence(incoming.originSeq, sequencePolicy)
      : await this.allocateMessageSeq(tx, threadId);
    if (incoming.quoteTarget !== undefined) {
      storedContent = withMessageContentQuote(storedContent, {
        ...storeFederationQuote(incoming.quoteTarget, namespaceId),
        digest: incoming.quoteDigest,
      });
    }
    const [message] = await tx
      .insert(tables.message)
      .values({
        contentType: incoming.contentType as ContentType,
        content: storedContent,
        payloadDigest: wireDigest,
        federationEnvelopeDigest: params.federationEnvelopeDigest,
        threadId,
        creatorAccount: creator.account,
        profileNamespaceId: creator.namespaceId,
        seq,
        originSeq: incoming.originSeq,
        profileRev: incoming.profileRev,
        originServerTime: originTime,
        publisherNamespaceId: namespaceId,
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
        publisherNamespaceId: namespaceId,
        updatedAt: new Date(),
      });
      await tx
        .delete(tables.federatedMessageTombstone)
        .where(
          and(
            eq(tables.federatedMessageTombstone.threadId, threadId),
            eq(
              tables.federatedMessageTombstone.publisherNamespaceId,
              namespaceId,
            ),
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
    await this.quota.tickLax(namespaceId, 'messages', tx, 1);
    if (validatedClosure) {
      await this.quota.tickLax(
        namespaceId,
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
