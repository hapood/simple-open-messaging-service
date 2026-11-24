import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
  threadLock: ThreadContentLock;
  threadId: number;
  seq: number;
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
}

export type FederationInboundMessageStoreResult =
  | {
      kind: 'message';
      message: Message;
      storedContent: string;
      localForwardBundleId?: bigint;
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
      forwardCard,
      forwardClosure,
      originTime,
      hasUnavailableAssets = false,
      assetBytes,
      downloadAuth,
      seq,
      payloadDigest: wireDigest,
    } = params;
    const creator = incomingCreator;
    await DeletedMessageService.lockFederatedIdentity(
      tx,
      threadId,
      namespaceId,
      incoming.originSeq,
      params.threadLock,
    );
    await this.assertLocalMessageSeqAvailable(tx, threadId, seq);
    const tombstone = await tx.query.federatedMessageTombstone.findFirst({
      where: and(
        eq(tables.federatedMessageTombstone.threadId, threadId),
        eq(tables.federatedMessageTombstone.publisherNamespaceId, namespaceId),
        eq(tables.federatedMessageTombstone.messageSeq, incoming.originSeq),
      ),
      columns: { type: true },
    });
    if (tombstone) {
      await DeletedMessageService.markFederatedTombstoneConsumedInTx(tx, {
        threadId,
        publisherNamespaceId: namespaceId,
        messageSeq: incoming.originSeq,
      });
    }

    if (
      !tombstone &&
      !hasUnavailableAssets &&
      isFederatedMediaContentType(incoming.contentType as ContentType) &&
      (incoming.contentType !== ContentType.LINK ||
        extractDigests(incoming.content).length > 0)
    ) {
      const batchId = randomUUID();
      const digests = extractDigestEntries(incoming.content);
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
      await tx.insert(tables.pendingMedia).values({
        messageId: stub.id,
        direction: 'INBOUND',
        batchId,
        fileCnt: digests.length,
        originDomain: fetchedFromDomain,
        publisherNamespaceId: namespaceId,
        expectedAuthorizationEpoch: thread.authorizationEpoch,
        updatedAt: new Date(),
      });
      for (const { digest, size } of digests) {
        await tx
          .insert(tables.fileSyncProgress)
          .values({
            batchId,
            messageId: stub.id,
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
    let localForwardBundleId: bigint | undefined;
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
        imported.depth,
      );
    }
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
        localState: 'STUB',
        updatedAt: new Date(),
      })
      .returning();
    // The publisher fact is marked consumed above and retained. Insertion does not
    // allocate a local DeletedMessage fact; an unconsumed row is not client-visible.
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

  private async assertLocalMessageSeqAvailable(
    tx: DatabaseTransaction,
    threadId: number,
    seq: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > 2_147_483_647)
      throw new Error('invalid assigned local message sequence');
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
