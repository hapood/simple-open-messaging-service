import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  identityNamespace,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  peerStateFeed,
  forwardMessage,
  forwardBundle,
} from '../database/schema.js';
import { storedQuoteCoordinate } from '../../shared/message-content-quote.js';
import { parseMessageContentQuote } from '../../shared/message-content-quote.js';
import { findStoredQuoteTargets } from '../message/stored-quote-targets.js';
import {
  publishFederationQuote,
  type FederationQuoteTarget,
} from './federation-quote-target.js';
import {
  federatedContentDigests,
  toFederatedMessageContent,
} from './federated-message-content.js';
import type {
  FederationAuthorAddress,
  FederationByteDescriptor,
  FederatedMessagePayload,
} from './federated-message-types.js';
import {
  resolveAuthorizedFederationThreadInTx,
  type FederationThreadAddress,
  type FederationThreadQuery,
} from './federation-thread-query-authorization.js';

export type {
  FederationThreadAddress,
  FederationThreadQuery,
} from './federation-thread-query-authorization.js';

const FEDERATION_MESSAGE_FEED_DEFAULT_PAGE_SIZE = 100;
const FEDERATION_MESSAGE_FEED_MAX_PAGE_SIZE = 200;
export const FEDERATED_MESSAGE_CONTENT_TYPES: ContentType[] = Object.values(
  ContentType,
).filter((type) => type !== ContentType.SYSTEM);

type FederationMessageFeedAsset = FederationByteDescriptor;

interface FederationMessageFeedMessageBase
  extends FederatedMessagePayload<string> {
  namespaceId: number;
  seq: number;
  profileRev: number;
  originSeq: number | null;
  originCreatedAt: number | null;
  createdAt: number;
  quoteTarget?: FederationQuoteTarget;
  quoteDigest?: string;
  assets: FederationMessageFeedAsset[];
}

export type FederationMessageFeedMessage =
  | (FederationMessageFeedMessageBase & {
      thread: { account: string; peerAccount: string };
      authorRef: 'THREAD_ACCOUNT' | 'THREAD_PEER_ACCOUNT';
    })
  | (FederationMessageFeedMessageBase & {
      thread: { account: string };
      author: FederationAuthorAddress;
    });

export interface FederationMessageQueryPage {
  messages: FederationMessageFeedMessage[];
  scannedThrough: number;
  hasMore: boolean;
}

@Injectable()
export class FederationMessageFeedService {
  private readonly logger = new Logger(FederationMessageFeedService.name);

  constructor(private readonly database: DatabaseService) {}

  async rejectMissingQueryAfter(
    peerDomain: string,
    namespaceId: number,
    selector: FederationThreadQuery,
  ): Promise<never> {
    const { messageAccessAfterSeq, currentEnd } =
      await this.database.db.transaction(
        async (tx) => {
          const authorized = await resolveAuthorizedFederationThreadInTx(
            tx,
            peerDomain,
            namespaceId,
            selector,
          );
          return {
            messageAccessAfterSeq: authorized.messageAccessAfterSeq,
            currentEnd: Math.max(
              await this.readAdvertisedMessageEnd(
                tx,
                peerDomain,
                namespaceId,
                selector,
              ),
              authorized.messageAccessAfterSeq,
            ),
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the message query cursor',
      HttpStatus.OK,
      {
        resumeAfter: messageAccessAfterSeq,
        resumeBefore: currentEnd + 1,
      },
    );
  }

  async query(
    peerDomain: string,
    namespaceId: number,
    selector: FederationThreadQuery,
    after: number | undefined,
    requestedTake?: number,
    through?: number,
    includeSelf = true,
    before?: number,
  ): Promise<FederationMessageQueryPage> {
    const { page } = await this.readPage(
      peerDomain,
      namespaceId,
      selector,
      after,
      requestedTake,
      through,
      includeSelf,
      before,
    );
    return page;
  }

  private async readPage(
    peerDomain: string,
    namespaceId: number,
    selector: FederationThreadQuery,
    after: number | undefined,
    requestedTake?: number,
    through?: number,
    includeSelf = true,
    before?: number,
  ) {
    const take = this.pageSize(requestedTake);
    if ((after === undefined) === (before === undefined))
      this.invalidDirection();
    if (through !== undefined && through < 0) this.invalidThrough();
    if (after !== undefined && through !== undefined && through < after)
      this.invalidThrough();
    if (before !== undefined && through !== undefined && through > before)
      this.invalidReverseThrough();
    return this.database.db.transaction(
      async (tx) => {
        const {
          threadId,
          messageAccessAfterSeq,
          address,
          groupQueryDirection,
        } = await resolveAuthorizedFederationThreadInTx(
          tx,
          peerDomain,
          namespaceId,
          selector,
        );
        const currentEnd = Math.max(
          await this.readAdvertisedMessageEnd(
            tx,
            peerDomain,
            namespaceId,
            selector,
          ),
          messageAccessAfterSeq,
        );
        const resumeAfter = messageAccessAfterSeq;
        const resumeBefore = currentEnd + 1;
        if (
          (after !== undefined &&
            (after < resumeAfter || after >= resumeBefore)) ||
          (before !== undefined &&
            (before <= resumeAfter + 1 || before > resumeBefore))
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
            'message query cursor is beyond the current thread end',
            HttpStatus.OK,
            {
              resumeAfter,
              resumeBefore,
            },
          );
        }
        const forward = after !== undefined;
        const queryEnd = forward
          ? Math.min(through ?? currentEnd, currentEnd)
          : 0;
        const queryStart = forward ? resumeAfter : (through ?? resumeAfter + 1);
        const queryBefore = forward ? 0 : Math.min(before!, resumeBefore);
        const rows = (forward ? queryEnd <= after! : queryBefore <= queryStart)
          ? []
          : await tx
              .select({
                messageId: message.id,
                threadId: message.threadId,
                seq: message.seq,
                profileRev: message.profileRev,
                originSeq: message.originSeq,
                originServerTime: message.originServerTime,
                publisherNamespaceId: message.publisherNamespaceId,
                contentType: message.contentType,
                content: message.content,
                payloadDigest: message.payloadDigest,
                createdAt: message.createdAt,
                clientMessageId: message.clientMessageId,
                threadType: messageThread.type,
                groupId: messageThread.id,
                authorityNamespaceId: messageThread.authorityNamespaceId,
                authorAccount: sql<string>`${message.creatorAccount}`,
                profileNamespaceId: message.profileNamespaceId,
                forwardBundleSourceId: forwardBundle.sourceBundleId,
              })
              .from(message)
              .innerJoin(messageThread, eq(messageThread.id, message.threadId))
              .leftJoin(
                forwardMessage,
                eq(forwardMessage.messageId, message.id),
              )
              .leftJoin(
                forwardBundle,
                eq(forwardBundle.id, forwardMessage.bundleId),
              )
              .where(
                and(
                  eq(message.threadId, threadId),
                  forward
                    ? gt(message.seq, after!)
                    : gte(message.seq, queryStart),
                  forward
                    ? lte(message.seq, queryEnd)
                    : lt(message.seq, queryBefore),
                  eq(message.isDeleted, false),
                  eq(message.localState, 'READY'),
                  ne(message.contentType, ContentType.SYSTEM),
                  groupQueryDirection === 'MIRROR_TO_ORIGIN'
                    ? or(
                        and(
                          eq(message.profileNamespaceId, 0),
                          eq(message.publisherNamespaceId, 0),
                        ),
                        and(
                          isNotNull(message.originSeq),
                          eq(message.publisherNamespaceId, namespaceId),
                        ),
                      )
                    : undefined,
                  includeSelf
                    ? undefined
                    : groupQueryDirection === 'MIRROR_TO_ORIGIN'
                      ? eq(message.profileNamespaceId, 0)
                      : ne(message.profileNamespaceId, namespaceId),
                ),
              )
              .orderBy(forward ? asc(message.seq) : desc(message.seq))
              .limit(take + 1);
        // Look ahead within the filtered wire-visible rows. A tail containing only
        // local system messages must exhaust the range, not produce another page.
        const selected = rows.slice(0, take);
        const messages = await this.serializeMessagesInTx(
          tx,
          selected,
          peerDomain,
          namespaceId,
          address,
        );
        const scannedThrough =
          rows.length > take
            ? selected.at(-1)!.seq
            : forward
              ? queryEnd
              : queryStart;
        return {
          page: {
            messages,
            scannedThrough,
            hasMore: forward
              ? scannedThrough < queryEnd
              : scannedThrough > queryStart,
          },
          // These coordinates are local-only and come from the same authorized
          // snapshot as the published message, never from the requesting peer.
          authorReferences: selected.map((row) => ({
            seq: row.seq,
            account: row.authorAccount,
            namespaceId: row.profileNamespaceId,
            profileRev: row.profileRev,
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private invalidDirection(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'exactly one of after or before is required',
      HttpStatus.BAD_REQUEST,
    );
  }

  private invalidReverseThrough(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'through must be less than or equal to before',
      HttpStatus.BAD_REQUEST,
    );
  }

  private async serializeMessagesInTx(
    tx: DatabaseTransaction,
    rows: Array<{
      messageId: bigint;
      threadId: number;
      seq: number;
      profileRev: number;
      originSeq: number | null;
      originServerTime: Date | null;
      publisherNamespaceId: number;
      contentType: ContentType;
      content: string;
      payloadDigest: string | null;
      createdAt: Date;
      clientMessageId: string | null;
      threadType: 'P2P' | 'GROUP';
      groupId: number | null;
      authorityNamespaceId: number;
      authorAccount: string;
      profileNamespaceId: number;
      forwardBundleSourceId: string | null;
    }>,
    peerDomain: string,
    peerNamespaceId: number,
    threadAddress: FederationThreadAddress,
  ): Promise<FederationMessageFeedMessage[]> {
    if (rows.length === 0) return [];
    const messageIds = rows.map((row) => row.messageId);
    const assetRows = await tx
      .select({
        messageId: messageAsset.messageId,
        digest: messageAsset.digest,
        bytes: mediaAsset.bytes,
      })
      .from(messageAsset)
      .innerJoin(mediaAsset, eq(mediaAsset.digest, messageAsset.digest))
      .where(inArray(messageAsset.messageId, messageIds));
    const assets = new Map<bigint, FederationMessageFeedAsset[]>();
    for (const asset of assetRows) {
      const current = assets.get(asset.messageId) ?? [];
      current.push({
        digest: asset.digest,
        bytes: Number(asset.bytes),
      });
      assets.set(asset.messageId, current);
    }

    const quoteTargets = await findStoredQuoteTargets(
      tx,
      rows.map((row) => ({ ...row, id: row.messageId })),
    );
    const profileNamespaceIds = [
      ...new Set(
        rows.map((row) =>
          row.publisherNamespaceId === peerNamespaceId &&
          row.profileNamespaceId === 0
            ? peerNamespaceId
            : row.profileNamespaceId,
        ),
      ),
    ];
    const namespaceRows =
      profileNamespaceIds.length === 0
        ? []
        : await tx
            .select({
              id: identityNamespace.id,
              domain: identityNamespace.domain,
            })
            .from(identityNamespace)
            .where(inArray(identityNamespace.id, profileNamespaceIds));
    const namespaceDomains = new Map(
      namespaceRows.map((namespace) => [namespace.id, namespace.domain]),
    );

    const result: FederationMessageFeedMessage[] = [];
    for (const row of rows) {
      const thread = threadAddress;
      const authorNamespaceId =
        row.publisherNamespaceId === peerNamespaceId &&
        row.profileNamespaceId === 0
          ? peerNamespaceId
          : row.profileNamespaceId;
      const authorDomain = namespaceDomains.get(authorNamespaceId);
      if (authorDomain === undefined) {
        throw new Error(
          `message author namespace ${authorNamespaceId} has no retained domain`,
        );
      }
      const author = {
        account: row.authorAccount,
        domain: authorDomain,
      };
      const quote = parseMessageContentQuote(row.content);
      const target = quoteTargets.get(row.messageId);
      const coordinate =
        quote && storedQuoteCoordinate(quote, row.publisherNamespaceId);
      // Absent targets (seq 0, or an unresolved PENDING/NOT_FOUND status) carry
      // no payload to attest, so they legitimately have no quote digest.
      const absentQuote =
        quote !== undefined &&
        (quote.seq === 0 ||
          target === undefined ||
          quote.status === 'PENDING' ||
          quote.status === 'NOT_FOUND');
      if (quote && !quote.digest && !absentQuote) {
        throw new Error(
          `message ${row.messageId.toString()} has a quote without quote digest`,
        );
      }
      const groupAuthority =
        row.threadType === 'GROUP' && row.authorityNamespaceId === 0;
      // A group authority republishes every author's target in its own timeline.
      // A mirror (or P2P sender) uses originSeq only for a target owned by its receiver.
      const quoteDigest = quote?.digest;
      if (quoteDigest !== undefined && !/^[a-f0-9]{64}$/.test(quoteDigest)) {
        throw new Error(
          `message ${row.messageId.toString()} has an invalid quote digest`,
        );
      }
      const quoteTarget = coordinate
        ? publishFederationQuote(
            coordinate,
            target,
            groupAuthority,
            peerNamespaceId,
          )
        : undefined;
      if (quote && quoteTarget === undefined) {
        throw new Error(
          `message ${row.messageId.toString()} quote cannot be represented for peer`,
        );
      }
      let content: string;
      let payloadDigests: Set<string>;
      try {
        if (row.contentType === ContentType.FORWARD) {
          const wireBundleId = row.forwardBundleSourceId;
          if (!wireBundleId || !/^[a-f0-9]{64}$/.test(wireBundleId)) {
            throw new Error('missing wire bundle digest');
          }
          content = JSON.stringify({ bundleId: wireBundleId });
          payloadDigests = new Set();
        } else {
          content = toFederatedMessageContent(row.contentType, row.content);
          payloadDigests = new Set(
            federatedContentDigests(row.contentType, content),
          );
        }
      } catch (error) {
        // One malformed stored row must not poison the peer's entire page. The page cursor is
        // based on scanned source seqs rather than returned item count, so omitting this row advances
        // past it while valid rows in the same page remain deliverable.
        this.logger.warn(
          `skipping malformed federated message (thread ${row.threadId}, seq ${row.seq}, type ${row.contentType}): ${(error as Error).message}`,
        );
        continue;
      }
      const candidateAssets = assets.get(row.messageId) ?? [];
      if (
        row.contentType !== ContentType.SYSTEM &&
        row.payloadDigest === null
      ) {
        throw new Error(
          `message ${row.messageId.toString()} has no payload digest`,
        );
      }
      // A FORWARD card references its closure by bundleId; the closure manifest, rather than the
      // card itself, owns the referenced digests. Other message types must not leak receiver-local
      // presentation assets (notably LINK artwork) into the wire projection.
      const projectedAssets =
        row.contentType === ContentType.FORWARD
          ? candidateAssets
          : candidateAssets.filter((asset) => payloadDigests.has(asset.digest));
      const isProcessingReceipt =
        row.originSeq !== null &&
        row.originServerTime !== null &&
        row.publisherNamespaceId === peerNamespaceId;
      const envelope = {
        namespaceId: authorNamespaceId,
        seq: row.seq,
        profileRev: row.profileRev,
        originSeq: isProcessingReceipt ? row.originSeq : null,
        originCreatedAt: isProcessingReceipt
          ? (row.originServerTime?.getTime() ?? null)
          : null,
        contentType: row.contentType,
        content,
        createdAt: row.createdAt.getTime(),
        ...(quoteTarget !== undefined ? { quoteTarget } : {}),
        ...(quoteDigest !== undefined ? { quoteDigest } : {}),
        // MessageAsset also authorizes receiver-local presentation assets, notably LINK artwork.
        // Only descriptors referenced by the URL-free wire content belong in the federation payload.
        assets: projectedAssets,
      };
      let item: FederationMessageFeedMessage;
      if ('peerAccount' in thread) {
        const sourceAuthored = author.account === thread.account;
        const peerAuthored = author.account === thread.peerAccount;
        if (!sourceAuthored && !peerAuthored) {
          throw new Error(
            `P2P message author is not one of the addressed participants (thread ${row.threadId}, seq ${row.seq})`,
          );
        }
        item = {
          ...envelope,
          thread,
          authorRef: peerAuthored ? 'THREAD_PEER_ACCOUNT' : 'THREAD_ACCOUNT',
        };
      } else {
        item = { ...envelope, thread, author };
      }
      result.push(item);
    }
    return result;
  }

  private async readAdvertisedMessageEnd(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    selector: FederationThreadQuery,
  ): Promise<number> {
    const [row] = await tx
      .select({ body: peerStateFeed.body })
      .from(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.namespaceId, namespaceId),
          eq(peerStateFeed.account, selector.account),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          selector.type === 'P2P'
            ? and(
                eq(peerStateFeed.subjectAccount, selector.peerAccount),
                eq(peerStateFeed.subjectNamespaceId, namespaceId),
              )
            : and(
                eq(peerStateFeed.subjectAccount, ''),
                eq(peerStateFeed.subjectNamespaceId, 0),
              ),
        ),
      )
      .limit(1);
    const value = (row?.body as { messageEndSeq?: unknown } | undefined)
      ?.messageEndSeq;
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
  }

  private pageSize(value?: number): number {
    if (value === undefined) return FEDERATION_MESSAGE_FEED_DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'take must be a positive safe integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    return Math.min(value, FEDERATION_MESSAGE_FEED_MAX_PAGE_SIZE);
  }

  private invalidThrough(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'through must be greater than or equal to after',
      HttpStatus.BAD_REQUEST,
    );
  }
}
