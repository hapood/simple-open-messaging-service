import {
  groupState as groupStateTable,
  groupStateFields,
} from '../group/shared/group-state.js';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { isValidSomfpDomain } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import type { InboundForwardWireBundle } from '../forward/forward-bundle.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { type Message } from '../message/message.service.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import type { S2SAddress } from './federation-address.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationMessageContextError } from './federation-errors.js';
import {
  FEDERATED_MESSAGE_CONTENT_TYPES,
  type FederationMessageFeedMessage,
} from './federation-message-feed.service.js';
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
  author: S2SAddress;
}

export type FederationMessagePageEffect = FederationMessagePageEffectContext &
  (
    | { kind: 'pending'; batchId: string; seq: number }
    | {
        kind: 'message';
        message: Message;
        profileDemand?: ProfilePrefetchDemand;
        profileEvidenceProjection?: ProfileEvidenceProjection;
        deletionSeq?: number;
        forwardClosure?: InboundForwardWireBundle;
        remoteForwardBundleId?: string;
        localForwardBundleId?: string;
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

/** Applies one validated, bounded peer message page inside the caller-owned cursor transaction. */
@Injectable()
export class FederationInboundMessagePageService {
  private readonly config = loadFederationConfig();
  private readonly logger = new Logger(
    FederationInboundMessagePageService.name,
  );

  constructor(
    private readonly threadAccess: FederationThreadAccessService,
    private readonly validator: FederationInboundMessageValidatorService,
    private readonly routes: FederationInboundMessageRouteService,
    private readonly inboundMessageStore: FederationInboundMessageStoreService,
    private readonly deletedMessages: DeletedMessageService,
  ) {}

  /** Apply one bounded message-query page inside the caller's cursor transaction. No network-visible
   * effects happen here; the returned effects are published only after that transaction commits. */
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
    await this.assertPeerResponseWritable(tx, token);
    if (sequencePolicy) {
      for (const item of items) {
        try {
          mapFederationOriginSequence(item.seq, sequencePolicy);
        } catch (error) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            error instanceof Error
              ? error.message
              : 'message is outside the frozen reverse window',
            HttpStatus.BAD_REQUEST,
          );
        }
      }
    }
    const effects: FederationMessagePageEffect[] = [];
    for (const [itemIndex, item] of items.entries()) {
      const savepoint = `federation_message_${itemIndex}`;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
      try {
        this.assertFederatedMessageEnvelope(item);
        if (
          'author' in item &&
          item.author.domain === 'local' &&
          item.namespaceId > 0
        ) {
          this.logger.warn(
            `discarded federated message with invalid local domain and positive namespace: ${federatedMessageLogContext(
              domain,
              item,
              'LOCAL_DOMAIN_POSITIVE_NAMESPACE',
            )}`,
          );
          continue;
        }
        if ('author' in item && item.author.domain === 'local') {
          this.logger.warn(
            `normalized a federated group-message author from the local persistence domain to its authenticated peer domain: ${federatedMessageLogContext(
              domain,
              item,
              'LOCAL_AUTHOR_DOMAIN_NORMALIZED',
            )}`,
          );
        }
        const author = this.federatedMessageAuthor(item, domain);
        let profileNamespaceId = item.namespaceId;
        if (!isValidSomfpDomain(author.domain)) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'federated message author has an invalid wire domain',
            HttpStatus.BAD_REQUEST,
          );
        }
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
          !Number.isSafeInteger(item.namespaceId) ||
          item.namespaceId < 0 ||
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
            'missed message has invalid namespace or seq coordinate',
            HttpStatus.BAD_REQUEST,
          );
        }
        const route = await this.resolveMissedThreadInTransaction(
          tx,
          item,
          domain,
          token.namespaceId,
        );
        // The route resolver canonicalizes receipt/self-authored identities to
        // this server's local persistence domain. Once the stored creator is
        // local, the profile subject namespace is always zero; the remote wire
        // namespace remains only the publisher/source coordinate.
        if (
          route.creatorDomain === 'local' ||
          route.creatorDomain === this.config.domain
        ) {
          profileNamespaceId = 0;
        }
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
          item.contentType === ContentType.PURE_TEXT &&
          (!incomingText || incomingText.quote !== undefined)
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'invalid federated text quote',
            HttpStatus.BAD_REQUEST,
          );
        }
        if (
          item.quoteTarget !== undefined &&
          (item.contentType !== ContentType.PURE_TEXT ||
            !isFederationQuoteTarget(item.quoteTarget))
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'invalid federated reply target',
            HttpStatus.BAD_REQUEST,
          );
        }
        this.assertMissedAssetDescriptors(item);
        let storedContent: string;
        try {
          storedContent = fromFederatedMessageContent(
            item.contentType as ContentType,
            item.content,
            this.config.domain,
            new Map(item.assets.map((asset) => [asset.digest, asset.bytes])),
          );
        } catch {
          throw new BusinessException(
            BusinessCode.FEDERATION_MALFORMED,
            'invalid federated message content',
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
              )}`,
            );
            continue;
          }
          const localSourceMessage = await tx.query.message.findFirst({
            where: and(
              eq(tables.message.threadId, route.threadId),
              eq(tables.message.seq, item.originSeq),
              eq(tables.message.creatorAccount, route.creatorAccount),
              eq(tables.message.creatorDomain, route.creatorDomain),
            ),
            columns: {
              id: true,
              createdAt: true,
            },
          });
          if (localSourceMessage) {
            if (
              localSourceMessage.createdAt.getTime() !== item.originCreatedAt
            ) {
              this.logger.error(
                `ignored a processing receipt with conflicting source time: ${JSON.stringify(
                  {
                    messageId: localSourceMessage.id.toString(),
                    peerDomain: domain,
                    receiptOriginSeq: item.originSeq,
                    receiptOriginCreatedAt: item.originCreatedAt,
                    localCreatedAt: localSourceMessage.createdAt.getTime(),
                  },
                )}`,
              );
              continue;
            }
            if (sequencePolicy) {
              await DeletedMessageService.lockFederatedIdentity(
                tx,
                route.threadId,
                domain,
                token.namespaceId,
                item.seq,
              );
            }
            const existingReceipt =
              await tx.query.federationMessageReceipt.findFirst({
                where: and(
                  eq(
                    tables.federationMessageReceipt.namespaceId,
                    token.namespaceId,
                  ),
                  eq(tables.federationMessageReceipt.threadId, route.threadId),
                  eq(tables.federationMessageReceipt.peerSeq, item.seq),
                ),
                columns: { messageId: true },
              });
            if (
              existingReceipt &&
              existingReceipt.messageId !== localSourceMessage.id
            ) {
              throw new BusinessException(
                BusinessCode.FEDERATION_MALFORMED,
                'conflicting processing receipt coordinate',
                HttpStatus.BAD_REQUEST,
              );
            }
            if (!existingReceipt) {
              await tx.insert(tables.federationMessageReceipt).values({
                namespaceId: token.namespaceId,
                threadId: route.threadId,
                peerSeq: item.seq,
                messageId: localSourceMessage.id,
              });
            }
            await this.deletedMessages.applyPendingReceiptInTx(tx, {
              threadId: route.threadId,
              peerSeq: item.seq,
              peerDomain: domain,
              namespaceId: token.namespaceId,
              authority:
                'peerAccount' in item.thread ? 'P2P_HOME' : 'GROUP_ORIGIN',
              expectedFederationVersion: route.federationVersion,
              threadLock: options.threadLock,
            });
            // Only the group's authoritative server can confirm a local submission.
            // Other receipts retain peer-coordinate aliases for reference resolution;
            // they cannot overwrite the original message's authority coordinate.
            const [authoritativeGroup] =
              route.creatorDomain === 'local' && !('peerAccount' in item.thread)
                ? await tx
                    .select({ id: groupStateTable.id })
                    .from(tables.messageThread)
                    .innerJoin(
                      groupStateTable,
                      eq(groupStateTable.id, tables.messageThread.id),
                    )
                    .where(
                      and(
                        eq(tables.messageThread.id, route.threadId),
                        eq(groupStateFields.domain, domain),
                        eq(groupStateFields.namespaceId, token.namespaceId),
                      ),
                    )
                    .limit(1)
                : [];
            if (authoritativeGroup) {
              const confirmed = await tx
                .update(tables.message)
                .set({
                  originSeq: item.seq,
                  originServerTime: sourceTime,
                  sourceNamespaceId: token.namespaceId,
                })
                .where(
                  and(
                    eq(tables.message.id, localSourceMessage.id),
                    or(
                      eq(tables.message.sourceNamespaceId, 0),
                      and(
                        eq(tables.message.sourceNamespaceId, token.namespaceId),
                        eq(tables.message.originSeq, item.seq),
                        eq(tables.message.originServerTime, sourceTime),
                      ),
                    ),
                  ),
                )
                .returning({ id: tables.message.id });
              if (confirmed.length !== 1) {
                throw new BusinessException(
                  BusinessCode.FEDERATION_MALFORMED,
                  'conflicting authoritative group confirmation',
                  HttpStatus.BAD_REQUEST,
                );
              }
            }
            continue;
          }
          this.logger.warn(
            `processing receipt has no matching published message: ${federatedMessageLogContext(
              domain,
              item,
              'LOCAL_SOURCE_MESSAGE_NOT_FOUND',
            )}`,
          );
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
            eq(tables.message.sourceNamespaceId, token.namespaceId),
            eq(tables.message.originSeq, item.seq),
          ),
          columns: {
            id: true,
            originServerTime: true,
          },
        });
        if (existingMessage) {
          const previousOriginTime = existingMessage.originServerTime;
          if (
            previousOriginTime &&
            previousOriginTime.getTime() !== sourceTime.getTime()
          ) {
            throw new BusinessException(
              BusinessCode.FEDERATION_MALFORMED,
              'conflicting immutable federated message originCreatedAt',
              HttpStatus.BAD_REQUEST,
            );
          }
          continue;
        }

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

        const stored = await this.inboundMessageStore.store(tx, {
          threadLock: options.threadLock,
          threadId: route.threadId,
          creator: {
            account: route.creatorAccount,
            domain: route.creatorDomain,
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
          },
          expectedFederationVersion: route.federationVersion,
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
            fromDomain: author.domain,
            toAccount: route.toAccount,
          },
          sequencePolicy,
        });
        if (stored.kind === 'pending') {
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
          item,
          stored.message,
          token.namespaceId,
          profileNamespaceId,
        );
        const profileEvidenceProjection =
          selectInboundMessageProfileEvidenceProjection(
            item,
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
            `ignored invalid federated message (FEDERATION_MALFORMED): ${federatedMessageLogContext(domain, item, error)}`,
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
  ): S2SAddress {
    return this.routes.messageAuthor(item, sourceDomain);
  }

  private resolveMissedThreadInTransaction(
    tx: DatabaseTransaction,
    item: FederationMessageFeedMessage,
    sourceDomain: string,
    namespaceId: number,
  ) {
    return this.routes.resolveMessage(tx, item, sourceDomain, namespaceId);
  }
}

/** Build a bounded, control-character-free diagnostic for untrusted message items. */
function federatedMessageLogContext(
  peerDomain: string,
  item: unknown,
  error: unknown,
): string {
  const record = logRecord(item);
  const content =
    typeof record?.['content'] === 'string' ? record['content'] : undefined;
  const author = logAddress(record?.['author']);
  const thread = logThread(record?.['thread']);
  const reason =
    error instanceof Error
      ? `${safeLogText(error.name, 80)}: ${safeLogText(error.message, 320)}`
      : safeLogText(error, 320);
  return JSON.stringify({
    peerDomain: safeLogText(peerDomain, 253),
    seq: safeLogText(record?.['seq'], 32),
    contentType: safeLogText(record?.['contentType'], 80),
    ...(content === undefined
      ? {}
      : {
          contentBytes: Buffer.byteLength(content),
          contentSha256: createHash('sha256').update(content).digest('hex'),
        }),
    ...(author === undefined ? {} : { author }),
    ...(thread === undefined ? {} : { thread }),
    reason,
  });
}

function logRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function logAddress(value: unknown): Record<string, string> | undefined {
  const record = logRecord(value);
  if (!record) return undefined;
  return {
    account: safeLogText(record['account'], 128),
    domain: safeLogText(record['domain'], 253),
  };
}

function logThread(value: unknown): Record<string, unknown> | undefined {
  const record = logRecord(value);
  if (!record) return undefined;
  const type = safeLogText(record['type'], 32);
  if (type === 'GROUP') {
    return {
      type,
      account: safeLogText(record['account'], 128),
      domain: safeLogText(record['domain'], 253),
    };
  }
  if (type === 'P2P') {
    const participants = Array.isArray(record['participants'])
      ? record['participants']
          .slice(0, 2)
          .map(logAddress)
          .filter((address) => address !== undefined)
      : [];
    return { type, participants };
  }
  return { type };
}

function safeLogText(value: unknown, maxLength: number): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'bigint'
        ? String(value)
        : '';
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '�').slice(0, maxLength);
}
