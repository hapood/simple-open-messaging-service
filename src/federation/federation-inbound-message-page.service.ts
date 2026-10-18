import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import type { InboundForwardWireBundle } from '../forward/forward-bundle.service.js';
import { type Message } from '../message/message.service.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import { FederationMessageContextError } from './federation-errors.js';
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

export interface FederationMessagePageApplyOptions {
  prefetchedForwardClosures?: ReadonlyMap<number, InboundForwardWireBundle>;
  isolateMissingContext?: boolean;
  sequencePolicy?: MapFederationOriginSequence;
  expectedThreadId?: number;
  historical?: boolean;
  threadLock?: ThreadContentLock;
}

/** A single inbound wire item after Phase 1 pure validation: its wire digest and projected local
 *  content are already computed, so Phase 2 (inside the transaction) only does route resolution,
 *  receipt confirmation, and store insertion. Carries the original `itemIndex` so savepoint names
 *  and the `prefetchedForwardClosures` map stay aligned with the source page. */
interface PreparedInboundItem {
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

/** Applies one validated, bounded peer message page inside the caller-owned cursor transaction. */
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
  ) {}

  /** Apply one bounded message-query page inside the caller's cursor transaction. No network-visible
   * effects happen here; the returned effects are published only after that transaction commits.
   *
   * Two phases:
   *  1. Pure validation, projection, and digest — outside the per-item savepoints, with no
   *     database access. Malformed items are warned and filtered here; only well-shaped items
   *     reach the transaction loop.
   *  2. Database work only — `assertPeerResponseWritable`, route resolution (locks), and per-item
   *     `SAVEPOINT` isolation for receipt confirmation (CAS) and store insertion. */
  async apply(
    tx: DatabaseTransaction,
    domain: string,
    items: readonly FederationMessageFeedMessage[],
    token: FederationContext,
    options: FederationMessagePageApplyOptions = {},
  ): Promise<FederationMessagePageEffect[]> {
    const {
      prefetchedForwardClosures = new Map(),
      isolateMissingContext = false,
      sequencePolicy,
      expectedThreadId,
      historical = false,
    } = options;

    // PHASE 1 — pure validation, transform, digest. No database access; malformed items are
    // warned and filtered so the transaction loop only ever sees structurally valid items with
    // their wire digest and projected local content already computed.
    const prepared: PreparedInboundItem[] = [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = items[itemIndex];
      // A reverse page outside its persisted closure is a page/cursor protocol violation,
      // not an isolated malformed item. Reject it before per-item filtering.
      if (sequencePolicy) {
        mapFederationOriginSequence(item.seq, sequencePolicy);
      }
      try {
        this.assertFederatedMessageEnvelope(item);
        const federationEnvelopeDigest =
          this.validator.immutableEnvelopeDigest(item);
        const author = this.federatedMessageAuthor(
          item,
          domain,
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

    // PHASE 2 — database work only. Per-item savepoints isolate a single item's failure from the
    // rest of the batch; well-shaped items cannot fail on pure-shape grounds here (those were
    // filtered in Phase 1), so savepoint rolls back only database-level conflicts (route/thread
    // mismatch, conflicting immutable coordinates, store internals) or context-resolution errors.
    await this.assertPeerResponseWritable(tx, token);
    const effects: FederationMessagePageEffect[] = [];
    for (const preparedItem of prepared) {
      const {
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
      } = preparedItem;
      const savepoint = `federation_message_${itemIndex}`;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
        const route = await this.resolveMissedThreadInTransaction(
          tx,
          item,
          domain,
          token.namespaceId,
          token.peerAssignedLocalNamespaceId,
        );
        const profileNamespaceId = route.profileNamespaceId;
        if (
          expectedThreadId !== undefined &&
          route.threadId !== expectedThreadId
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'message query returned an item for a different thread',
            HttpStatus.BAD_REQUEST,
          );
        }
        if (route.authority === 'LOCAL') {
          if (item.originSeq === null || item.originCreatedAt === null) {
            this.logger.error(
              `self-authored message diagnostic is missing source coordinates: ${federatedMessageLogContext(
                domain,
                item,
                'SOURCE_COORDINATES_MISSING',
                {
                  processId: process.pid,
                  namespaceId: token.namespaceId,
                  peerAssignedLocalNamespaceId:
                    token.peerAssignedLocalNamespaceId,
                  threadId: route.threadId,
                  originSeq: item.originSeq,
                  originCreatedAt: item.originCreatedAt,
                },
              )}`,
            );
            continue;
          }
          await this.inboundMessageStore.applyProcessingReceipt(tx, {
            threadLock: options.threadLock,
            threadId: route.threadId,
            creatorAccount: route.creatorAccount,
            profileNamespaceId: route.profileNamespaceId,

            fetchedFromDomain: domain,
            namespaceId: token.namespaceId,
            peerSeq: item.seq,
            originSeq: item.originSeq,
            originCreatedAt: item.originCreatedAt,
            isP2PThread: 'peerAccount' in item.thread,
            publishedProfileNamespaceId:
              'account' in item.author ? item.author.namespaceId : undefined,
            logContext: federatedMessageLogContext(
              domain,
              item,
              'LOCAL_SOURCE_MESSAGE_NOT_FOUND',
            ),
            sourceTime,
            payloadDigest: wireDigest,
            contentType: item.contentType,
            profileRev: item.profileRev,
            sequencePolicy,
          });
          continue;
        }
        if (item.originSeq !== null || item.originCreatedAt !== null) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'peer-authoritative message must not carry origin coordinates',
            HttpStatus.BAD_REQUEST,
          );
        }
        const existingMessage = await tx.query.message.findFirst({
          where: and(
            eq(tables.message.threadId, route.threadId),
            eq(tables.message.publisherNamespaceId, token.namespaceId),
            eq(tables.message.originSeq, item.seq),
          ),
          columns: {
            id: true,
            creatorAccount: true,
            profileNamespaceId: true,
            profileRev: true,
            contentType: true,
            originServerTime: true,
            payloadDigest: true,
            federationEnvelopeDigest: true,
          },
        });
        if (existingMessage) {
          const exactFingerprint =
            existingMessage.federationEnvelopeDigest !== null &&
            existingMessage.federationEnvelopeDigest ===
              federationEnvelopeDigest;
          if (!exactFingerprint) {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'conflicting immutable federated message envelope',
              HttpStatus.BAD_REQUEST,
            );
          }
          continue;
        }
        const stored = await this.inboundMessageStore.store(tx, {
          threadLock: options.threadLock,
          threadId: route.threadId,
          creator: {
            account: route.creatorAccount,
            namespaceId: route.profileNamespaceId,
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
            toAccount: route.toAccount,
          },
          sequencePolicy,
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
              threadId: route.threadId,
              seq: stored.seq,
              isDeleted: false,
              profileRev: item.profileRev,
              creatorAccount: route.creatorAccount,
            },
            token.namespaceId,
            profileNamespaceId,
          );
          const stubDemand = selectInboundMessageProfileDemand(
            item.thread,
            {
              threadId: route.threadId,
              seq: stored.seq,
              isDeleted: false,
              profileRev: item.profileRev,
              creatorAccount: route.creatorAccount,
            },
            token.namespaceId,
            profileNamespaceId,
          );
          effects.push({
            kind: 'pending',
            historical,
            threadId: route.threadId,
            originSeq: item.seq,
            recipients: route.recipients,
            toAccount: route.toAccount,
            author,
            batchId: stored.batchId,
            seq: stored.seq,
            ...(stubDemand ? { profileDemand: stubDemand } : {}),
            ...(stubEvidence
              ? { profileEvidenceProjection: stubEvidence }
              : {}),
          });
          continue;
        }
        let deletionSeq: number | undefined;
        if (stored.message.isDeleted) {
          const deletion = await tx.query.deletedMessage.findFirst({
            where: and(
              eq(tables.deletedMessage.threadId, route.threadId),
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
          threadId: route.threadId,
          originSeq: item.seq,
          recipients: route.recipients,
          toAccount: route.toAccount,
          author,
          message: stored.message,
          ...(profileDemand ? { profileDemand } : {}),
          ...(profileEvidenceProjection ? { profileEvidenceProjection } : {}),
          deletionSeq,
          forwardClosure,
          remoteForwardBundleId: forwardCard?.bundleId,
          localForwardBundleId: stored.localForwardBundleId,
        });
      } catch (error) {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
        if (
          error instanceof BusinessException &&
          error.bizCode === BusinessCode.FEDERATION_MALFORMED
        ) {
          this.logger.warn(
            `ignored invalid federated message (FEDERATION_MALFORMED): ${federatedMessageLogContext(
              domain,
              item,
              error,
            )}`,
          );
          continue;
        }
        if (sequencePolicy) throw error;
        if (error instanceof FederationMessageContextError) {
          if (!isolateMissingContext) throw error;
          this.logger.error(
            `ignored message with unresolved context after state recovery: ${federatedMessageLogContext(
              domain,
              item,
              error,
            )}`,
          );
          continue;
        }
        // Storage and infrastructure failures must not become permanent holes in the cursor.
        throw error;
      } finally {
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      }
    }
    return effects;
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
    sourceDomain: string,
    peerAssignedLocalNamespaceId: number,
  ): { account: string; namespaceId: number } {
    return this.routes.messageAuthor(
      item,
      sourceDomain,
      peerAssignedLocalNamespaceId,
    );
  }

  private resolveMissedThreadInTransaction(
    tx: DatabaseTransaction,
    item: FederationMessageFeedMessage,
    sourceDomain: string,
    namespaceId: number,
    peerAssignedLocalNamespaceId: number,
  ) {
    return this.routes.resolveMessage(
      tx,
      item,
      sourceDomain,
      namespaceId,
      peerAssignedLocalNamespaceId,
    );
  }
}
