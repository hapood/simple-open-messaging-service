import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import {
  ForwardBundleService,
  type InboundForwardWireBundle,
} from '../forward/forward-bundle.service.js';
import { type Message } from '../message/message.service.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import {
  FEDERATED_MESSAGE_CONTENT_TYPES,
  type FederationMessageFeedMessage,
} from './federation-message-feed.service.js';
import { payloadDigest } from './canonical-json.js';
import { federatedMessageLogContext } from './federation-message-log-context.js';
import { fromFederatedMessageContent } from './federated-message-content.js';
import {
  mapFederationOriginSequence,
  type MapFederationOriginSequence,
} from './federation-message-sequence-policy.js';
import {
  FederationInboundMessageStoreService,
  type FederatedForwardCard,
} from './federation-inbound-message-store.service.js';
import { FederationInboundMessageRouteService } from './federation-inbound-message-route.service.js';
import type { ThreadContentLock } from '../common/locks/thread-content-lock.js';
import type {
  ProfileEvidenceProjection,
  ProfilePrefetchDemand,
} from '../profile-resolution/profile-resolution-demand.js';
import {
  selectInboundMessageProfileDemand,
  selectInboundMessageProfileEvidenceProjection,
} from './select-inbound-message-profile-demand.js';
import { FederationInboundMessageValidatorService } from './federation-inbound-message-validator.service.js';
import { type FederationContext } from './federation-namespace.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { isFederationQuoteTarget } from './federation-quote-target.js';

interface FederationMessagePageEffectContext {
  historical: boolean;
  threadId: number;
  originSeq: number;
  recipients: number[];
  toAccount: string;
  author: { account: string; namespaceId: number };
}

export type FederationMessagePageEffect = FederationMessagePageEffectContext &
  (
    | {
        kind: 'pending';
        batchId: string;
        seq: number;
        profileDemand?: ProfilePrefetchDemand;
        profileEvidenceProjection?: ProfileEvidenceProjection;
      }
    | {
        kind: 'message';
        message: Message;
        profileDemand?: ProfilePrefetchDemand;
        profileEvidenceProjection?: ProfileEvidenceProjection;
        deletionSeq?: number;
        forwardClosure?: InboundForwardWireBundle;
        remoteForwardBundleId?: string;
        localForwardBundleId?: bigint;
      }
  );

export interface MessageProcessedInterval {
  /** Publisher coordinates, left-exclusive and right-inclusive. Filtering does not shrink it. */
  left: number;
  right: number;
}

export interface MessagePageWriteContext {
  threadLock: ThreadContentLock;
  processedInterval: MessageProcessedInterval;
}

type PageSequenceAssignment =
  | { kind: 'RESERVED'; mapping: MapFederationOriginSequence }
  | { kind: 'APPEND'; lastSeq: number };

/** Purely validated wire item, before outer receipt processing and duplicate filtering. */
export interface PreparedInboundItem {
  itemIndex: number;
  item: FederationMessageFeedMessage;
  author: { account: string; namespaceId: number };
  sourceTime: Date;
  incomingText: ReturnType<typeof parseTextMessageContent>;
  storedContent: string;
  wireDigest: string;
  federationEnvelopeDigest: string;
  forwardCard?: FederatedForwardCard;
  forwardClosure?: InboundForwardWireBundle;
}

export interface PreparedMessageWrite extends PreparedInboundItem {
  creatorAccount: string;
  profileNamespaceId: number;
  recipients: number[];
  toAccount: string;
}

/** Applies prepared new messages inside the caller-owned cursor transaction. */
@Injectable()
export class FederationInboundMessagePageService {
  private readonly logger = new Logger(
    FederationInboundMessagePageService.name,
  );

  constructor(
    private readonly threadAccess: FederationThreadAccessService,
    private readonly validator: FederationInboundMessageValidatorService,
    private readonly routes: FederationInboundMessageRouteService,
    private readonly inboundMessageStore: FederationInboundMessageStoreService,
    private readonly forwardBundles: ForwardBundleService,
  ) {}

  /** Pure preparation before opening the page transaction or acquiring content locks. */
  prepare(
    domain: string,
    items: readonly FederationMessageFeedMessage[],
    token: FederationContext,
    prefetchedForwardClosures: ReadonlyMap<number, InboundForwardWireBundle>,
  ): PreparedInboundItem[] {
    // PHASE 1 — pure validation, transform, digest. No database access; malformed items are
    // warned and filtered so the transaction loop only ever sees structurally valid items with
    // their wire digest and projected local content already computed.
    const prepared: PreparedInboundItem[] = [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = items[itemIndex];
      try {
        this.assertFederatedMessageEnvelope(item);
        const federationEnvelopeDigest =
          this.validator.immutableEnvelopeDigest(item);
        const author = this.federatedMessageAuthor(
          item,
          token.peerAssignedLocalNamespaceId,
        );
        if (
          !FEDERATED_MESSAGE_CONTENT_TYPES.includes(
            item.contentType as ContentType,
          )
        )
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'unknown federated message content type',
            HttpStatus.BAD_REQUEST,
          );
        const hasOriginSeq = item.originSeq !== null;
        const hasOriginCreatedAt = item.originCreatedAt !== null;
        if (
          !Number.isSafeInteger(item.seq) ||
          item.seq < 1 ||
          hasOriginSeq !== hasOriginCreatedAt ||
          (hasOriginSeq &&
            (!Number.isSafeInteger(item.originSeq) || item.originSeq! < 1)) ||
          (hasOriginCreatedAt &&
            (!Number.isSafeInteger(item.originCreatedAt) ||
              item.originCreatedAt! < 0))
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'missed message has invalid seq coordinate',
            HttpStatus.BAD_REQUEST,
          );
        }
        const sourceTime = new Date(item.createdAt);
        if (
          !Number.isSafeInteger(item.createdAt) ||
          item.createdAt < 0 ||
          Number.isNaN(sourceTime.getTime())
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'missed message has invalid timestamps',
            HttpStatus.BAD_REQUEST,
          );
        }
        const incomingText =
          item.contentType === ContentType.PURE_TEXT
            ? parseTextMessageContent(item.content)
            : null;
        if (
          item.contentType === ContentType.SYSTEM &&
          (item.quoteTarget !== undefined || item.quoteDigest !== undefined)
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'system messages cannot contain quotes',
            HttpStatus.BAD_REQUEST,
          );
        }
        if (
          (item.quoteTarget === undefined) !==
            (item.quoteDigest === undefined) ||
          (item.quoteTarget !== undefined &&
            !isFederationQuoteTarget(item.quoteTarget))
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'invalid federated reply target',
            HttpStatus.BAD_REQUEST,
          );
        }
        this.assertMissedAssetDescriptors(item);
        const storedContent = fromFederatedMessageContent(
          item.contentType as ContentType,
          item.content,
          new Map(item.assets.map((asset) => [asset.digest, asset.bytes])),
        );
        const wireDigest = payloadDigest(
          item.content,
          item.assets,
          item.quoteDigest,
        );
        let forwardCard: FederatedForwardCard | undefined;
        let forwardClosure: InboundForwardWireBundle | undefined;
        if (item.contentType === ContentType.FORWARD) {
          try {
            forwardCard = JSON.parse(item.content) as FederatedForwardCard;
          } catch {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'invalid FORWARD card JSON',
              HttpStatus.BAD_REQUEST,
            );
          }
          if (
            typeof forwardCard.bundleId !== 'string' ||
            Object.keys(forwardCard).some((key) => key !== 'bundleId')
          ) {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'invalid FORWARD card shape',
              HttpStatus.BAD_REQUEST,
            );
          }
          forwardClosure = prefetchedForwardClosures.get(itemIndex);
          if (!forwardClosure) {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'FORWARD closure was not prefetched',
              HttpStatus.BAD_REQUEST,
            );
          }
          this.forwardBundles.validateWireClosure(forwardClosure);
        }
        prepared.push({
          itemIndex,
          item,
          author,
          sourceTime,
          incomingText,
          storedContent,
          wireDigest,
          federationEnvelopeDigest,
          forwardCard,
          forwardClosure,
        });
      } catch (error) {
        this.logger.warn(
          `filtered malformed inbound message before transaction: ${federatedMessageLogContext(
            domain,
            item,
            error,
            {
              tokenNamespaceId: token.namespaceId,
              tokenPeerAssignedLocalNamespaceId:
                token.peerAssignedLocalNamespaceId,
            },
          )}`,
        );
      }
    }

    return prepared;
  }

  /** Commit prepared items only; callers must prepare before entering their transaction. */
  async applyPrepared(
    tx: DatabaseTransaction,
    prepared: readonly PreparedMessageWrite[],
    token: FederationContext,
    context: MessagePageWriteContext,
  ): Promise<FederationMessagePageEffect[]> {
    const expectedThreadId = context.threadLock.threadId;
    // Transport metadata only; coordinates and source selection use token.namespaceId.
    const domain = token.domain;
    const assignment = await this.resolveSequenceAssignmentInTx(
      tx,
      token.namespaceId,
      context,
    );
    const historical = assignment.kind === 'RESERVED';
    await this.assertPeerResponseWritable(tx, token);
    const effects: FederationMessagePageEffect[] = [];
    const existing =
      prepared.length === 0
        ? []
        : await tx.query.message.findMany({
            where: and(
              eq(tables.message.threadId, expectedThreadId),
              eq(tables.message.publisherNamespaceId, token.namespaceId),
              inArray(
                tables.message.originSeq,
                prepared.map(({ item }) => item.seq),
              ),
            ),
            columns: { originSeq: true },
          });
    const known = new Set(existing.map((row) => row.originSeq));
    for (const preparedItem of prepared) {
      if (known.has(preparedItem.item.seq)) {
        this.logger.warn(
          `ignored concurrently stored federated message coordinate ${expectedThreadId}:${token.namespaceId}:${preparedItem.item.seq}`,
        );
        continue;
      }
      const {
        item,
        author,
        sourceTime,
        incomingText,
        storedContent,
        wireDigest,
        federationEnvelopeDigest,
        forwardCard,
        forwardClosure,
      } = preparedItem;
      const { creatorAccount, profileNamespaceId, recipients, toAccount } =
        preparedItem;
      const seq =
        assignment.kind === 'RESERVED'
          ? mapFederationOriginSequence(item.seq, assignment.mapping)
          : assignment.lastSeq + 1;
      const stored = await this.inboundMessageStore.store(tx, {
        threadLock: context.threadLock,
        threadId: expectedThreadId,
        seq,
        creator: {
          account: creatorAccount,
          namespaceId: profileNamespaceId,
        },
        fetchedFromDomain: domain,
        namespaceId: token.namespaceId,
        profileNamespaceId,
        message: {
          originSeq: item.seq,
          profileRev: item.profileRev,
          contentType: item.contentType,
          content: storedContent,
          ts: item.createdAt,
          quoteTarget: item.quoteTarget,
          quoteDigest: item.quoteDigest,
        },

        incomingText,
        forwardCard,
        forwardClosure,
        originTime: sourceTime,
        hasUnavailableAssets: false,
        assetBytes: new Map(
          item.assets.map((asset) => [asset.digest, asset.bytes]),
        ),
        downloadAuth: {
          fromAccount: author.account,
          fromDomain: domain,
          toAccount: toAccount,
        },
        payloadDigest: wireDigest,
        federationEnvelopeDigest,
      });
      if (stored.kind === 'pending') {
        // The validated media STUB already commits its profile evidence;
        // member selection advances now, while bytes and snapshot bytes
        // remain independent cache work.
        const stubEvidence = selectInboundMessageProfileEvidenceProjection(
          item.thread,
          {
            threadId: expectedThreadId,
            seq: stored.seq,
            isDeleted: false,
            profileRev: item.profileRev,
            creatorAccount: creatorAccount,
          },
          token.namespaceId,
          profileNamespaceId,
        );
        const stubDemand = selectInboundMessageProfileDemand(
          item.thread,
          {
            threadId: expectedThreadId,
            seq: stored.seq,
            isDeleted: false,
            profileRev: item.profileRev,
            creatorAccount: creatorAccount,
          },
          token.namespaceId,
          profileNamespaceId,
        );
        effects.push({
          kind: 'pending',
          historical,
          threadId: expectedThreadId,
          originSeq: item.seq,
          recipients: recipients,
          toAccount: toAccount,
          author,
          batchId: stored.batchId,
          seq: stored.seq,
          ...(stubDemand ? { profileDemand: stubDemand } : {}),
          ...(stubEvidence ? { profileEvidenceProjection: stubEvidence } : {}),
        });
        if (assignment.kind === 'APPEND') assignment.lastSeq = seq;
        continue;
      }
      let deletionSeq: number | undefined;
      if (stored.message.isDeleted) {
        const deletion = await tx.query.deletedMessage.findFirst({
          where: and(
            eq(tables.deletedMessage.threadId, expectedThreadId),
            eq(tables.deletedMessage.messageSeq, stored.message.seq),
          ),
          columns: { deletionSeq: true },
        });
        deletionSeq = deletion?.deletionSeq;
      }
      const profileDemand = selectInboundMessageProfileDemand(
        item.thread,
        stored.message,
        token.namespaceId,
        profileNamespaceId,
      );
      const profileEvidenceProjection =
        selectInboundMessageProfileEvidenceProjection(
          item.thread,
          stored.message,
          token.namespaceId,
          profileNamespaceId,
        );
      effects.push({
        kind: 'message',
        historical,
        threadId: expectedThreadId,
        originSeq: item.seq,
        recipients: recipients,
        toAccount: toAccount,
        author,
        message: stored.message,
        ...(profileDemand ? { profileDemand } : {}),
        ...(profileEvidenceProjection ? { profileEvidenceProjection } : {}),
        deletionSeq,
        forwardClosure,
        remoteForwardBundleId: forwardCard?.bundleId,
        localForwardBundleId: stored.localForwardBundleId,
      });
      if (assignment.kind === 'APPEND') assignment.lastSeq = seq;
    }
    return effects;
  }

  private async resolveSequenceAssignmentInTx(
    tx: DatabaseTransaction,
    namespaceId: number,
    context: MessagePageWriteContext,
  ): Promise<PageSequenceAssignment> {
    const { threadId } = context.threadLock;
    const thread = await tx.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
      columns: { type: true, authorityNamespaceId: true, curSeq: true },
    });
    if (!thread) throw new Error('message commit thread disappeared');
    // Locally authoritative groups consume member submissions into newly allocated slots.
    if (thread.type === 'GROUP' && thread.authorityNamespaceId === 0)
      return { kind: 'APPEND', lastSeq: thread.curSeq };
    const { left, right } = context.processedInterval;
    const gaps = await tx.execute<{ messageSeqOffset: number }>(sql`
      SELECT "messageSeqOffset"
      FROM "FederationThreadHistoryGap"
      WHERE "threadId" = ${threadId} AND "namespaceId" = ${namespaceId}
        AND recoverable = true
        AND "startSeq" <= ${left + 1} AND "endSeq" >= ${right}
    `);
    if (gaps.rows.length !== 1)
      throw new Error(
        'processed message interval requires one reserved mapping',
      );
    return {
      kind: 'RESERVED',
      mapping: {
        kind: 'MAP_ORIGIN',
        beforeSeq: right + 1,
        throughSeq: left + 1,
        messageSeqOffset: gaps.rows[0].messageSeqOffset,
      },
    };
  }

  private assertPeerResponseWritable(
    tx: DatabaseTransaction,
    token: FederationContext,
  ): Promise<void> {
    return this.threadAccess.assertPeerResponseWritable(tx, token);
  }

  private assertFederatedMessageEnvelope(
    item: FederationMessageFeedMessage,
  ): void {
    this.validator.assertEnvelope(item);
  }

  private assertMissedAssetDescriptors(
    item: FederationMessageFeedMessage,
  ): void {
    try {
      this.validator.assertAssetDescriptors(item);
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'invalid federated message content or asset descriptors',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private federatedMessageAuthor(
    item: FederationMessageFeedMessage,
    peerAssignedLocalNamespaceId: number,
  ): { account: string; namespaceId: number } {
    return this.routes.messageAuthor(item, peerAssignedLocalNamespaceId);
  }
}
