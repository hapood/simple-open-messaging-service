import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  threadParticipant,
  user,
} from '../database/schema.js';
import { ContentType } from '../database/enums.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import { FederationCursorService } from './federation-cursor.service.js';
import {
  FederationFeedFillState,
  FederationMemoryFeedService,
} from './federation-memory-feed.service.js';
import { FederationFeedFulfiller } from './federation-feed-fulfiller.service.js';
import type { FederationBufferedChange } from './federation-change-buffer.js';
import { loadFederationConfig } from './federation.config.js';
import {
  buildFederatedCallContent,
  parseCallContent,
} from '../calls/call-content.js';
import {
  authoredMessageSnapshot,
  toFederatedMessageContent,
} from './federated-message-content.js';

export const FEDERATION_MESSAGE_FEED_DEFAULT_PAGE_SIZE = 100;
export const FEDERATION_MESSAGE_FEED_MAX_PAGE_SIZE = 200;
export const FEDERATED_MESSAGE_CONTENT_TYPES: ContentType[] = Object.values(
  ContentType,
).filter((type) => type !== ContentType.SYSTEM);
const STATEMENT_TIMEOUT_MS = 10_000;
const IDLE_TRANSACTION_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface FederationMessageFeedAsset {
  digest: string;
  bytes: number;
  status: 'READY' | 'DELETED';
}

export interface FederationMessageFeedMessage {
  feedId: string;
  thread:
    | { type: 'GROUP'; account: string; domain: string }
    | {
        type: 'P2P';
        participants: Array<{ account: string; domain: string }>;
      };
  author: { account: string; domain: string };
  seq: number;
  /** Stable source-author coordinate. Locally-authored messages use their source thread seq. */
  originSeq: number;
  contentType: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  clientMessageId: string | null;
  quoteTarget?: {
    creator: { account: string; domain: string };
    originSeq: number;
  };
  assets: FederationMessageFeedAsset[];
}

export interface FederationMessageFeedPage {
  messages: FederationMessageFeedMessage[];
  scannedThrough: string;
  hasMore: boolean;
  retryAfterMs?: number;
}

interface FeedSnapshotCache {
  after: bigint;
  take: number;
  trunc?: bigint;
  excludeSelf: boolean;
  refs: FederationBufferedChange[];
}

const FEDERATION_FILL_RETRY_AFTER_MS = 100;

@Injectable()
export class FederationMessageFeedService {
  private readonly localDomain = loadFederationConfig().domain;
  private readonly snapshots = new Map<string, FeedSnapshotCache>();

  constructor(
    private readonly cursor: FederationCursorService,
    private readonly memoryFeed: FederationMemoryFeedService,
    @Optional() private readonly fulfiller?: FederationFeedFulfiller,
  ) {}

  rejectMissingAfter(peerDomain: string): Promise<never> {
    return this.cursor.rejectMissingAfter(peerDomain);
  }

  async serve(
    peerDomain: string,
    after: bigint,
    requestedTake?: number,
    trunc?: bigint,
    excludeSelf = false,
  ): Promise<FederationMessageFeedPage> {
    const take = this.pageSize(requestedTake);
    if (trunc !== undefined && trunc < after) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'trunc must be greater than or equal to after',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.memoryFeed.runExclusive(peerDomain, async () => {
      // Reconstruct durable unacknowledged allocations and discover committed backlog before the
      // cursor transaction freezes this request's allocation upper bound. Never retire here: the
      // durable audience progress must advance in that transaction before memory entries disappear.
      await this.memoryFeed.fillWhileLocked(peerDomain);
      const { page, acknowledgedThrough } = await this.serveWithCursor(
        peerDomain,
        after,
        take,
        trunc,
        excludeSelf,
      );
      const retiredAfter = this.memoryFeed.retireWhileLocked(
        peerDomain,
        acknowledgedThrough,
      );
      if (retiredAfter > 0) {
        this.snapshots.delete(peerDomain);
        this.fulfiller?.schedule(peerDomain);
      }
      const endId = await this.cursor.readAllocatedThrough(peerDomain);
      const requestEnd = trunc === undefined || trunc > endId ? endId : trunc;
      const fillState = this.memoryFeed.state(peerDomain);
      if (
        requestEnd > BigInt(page.scannedThrough) ||
        fillState === FederationFeedFillState.NEEDS_FILL ||
        fillState === FederationFeedFillState.FILLING
      ) {
        page.hasMore = true;
      }
      if (
        page.hasMore &&
        page.messages.length === 0 &&
        BigInt(page.scannedThrough) === after
      ) {
        page.retryAfterMs = FEDERATION_FILL_RETRY_AFTER_MS;
      }
      return page;
    });
  }

  private async serveWithCursor(
    peerDomain: string,
    after: bigint,
    take: number,
    trunc?: bigint,
    excludeSelf = false,
  ): Promise<{
    page: FederationMessageFeedPage;
    acknowledgedThrough: bigint;
  }> {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    let acknowledgedThrough = after;
    const result = await this.cursor.servePage(
      peerDomain,
      after,
      async ({
        tx,
        allocatedThrough,
        after: effectiveAfter,
        retry,
        previouslyServedThrough,
      }) => {
        acknowledgedThrough = effectiveAfter;
        // Both settings are transaction-local. statement_timeout cancels a slow page SQL; the idle
        // timeout is only a final safety net if application code stops progressing after BEGIN.
        await tx.execute(
          sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`),
        );
        await tx.execute(
          sql.raw(
            `SET LOCAL idle_in_transaction_session_timeout = '${IDLE_TRANSACTION_TIMEOUT_MS}ms'`,
          ),
        );
        this.assertBeforeDeadline(deadline);

        const boundedEnd = retry
          ? previouslyServedThrough
          : trunc === undefined || trunc > allocatedThrough
            ? allocatedThrough
            : trunc;
        const effectiveAllocatedThrough =
          boundedEnd < effectiveAfter ? effectiveAfter : boundedEnd;
        const memoryRefs = this.readSnapshot(
          peerDomain,
          effectiveAfter,
          take,
          trunc,
          excludeSelf,
          effectiveAllocatedThrough,
        );
        await this.memoryFeed.acknowledgeInTx(tx, peerDomain, effectiveAfter);
        const memoryScannedThrough =
          memoryRefs.length === take
            ? memoryRefs.at(-1)!.feedId
            : effectiveAllocatedThrough;

        const changes =
          memoryRefs.length === 0
            ? []
            : await tx
                .select({
                  messageId: message.id,
                  threadId: message.threadId,
                  seq: message.seq,
                  originSeq: message.originSeq,
                  contentType: message.contentType,
                  content: message.content,
                  createdAt: message.createdAt,
                  updatedAt: message.updatedAt,
                  clientMessageId: message.clientMessageId,
                  federationAuthoredSnapshot:
                    message.federationAuthoredSnapshot,
                  threadType: messageThread.type,
                  groupUserId: messageThread.groupUserId,
                  authorAccount: user.account,
                  authorDomain: user.domain,
                })
                .from(message)
                .innerJoin(
                  messageThread,
                  eq(messageThread.id, message.threadId),
                )
                .innerJoin(user, eq(user.id, message.creator))
                .where(
                  and(
                    inArray(
                      message.id,
                      memoryRefs.map((entry) => entry.messageId),
                    ),
                    eq(message.isDeleted, false),
                    ne(message.contentType, ContentType.SYSTEM),
                  ),
                )
                .then((rows) => {
                  const byId = new Map(rows.map((row) => [row.messageId, row]));
                  return memoryRefs
                    .map((entry) => {
                      const row = byId.get(entry.messageId);
                      return row ? { ...row, feedId: entry.feedId } : null;
                    })
                    .filter(
                      (row): row is NonNullable<typeof row> => row !== null,
                    );
                });
        this.assertBeforeDeadline(deadline);

        const messageIds = changes.map((row) => row.messageId);
        const threadIds = [
          ...new Set(
            changes
              .filter((row) => row.threadType === 'P2P')
              .map((row) => row.threadId),
          ),
        ];
        const groupIds = [
          ...new Set(
            changes
              .map((row) => row.groupUserId)
              .filter((id): id is number => id !== null),
          ),
        ];
        const [assetRows, participantRows, groupRows] = await Promise.all([
          messageIds.length === 0
            ? Promise.resolve([])
            : tx
                .select({
                  messageId: messageAsset.messageId,
                  digest: messageAsset.digest,
                  bytes: mediaAsset.bytes,
                  status: sql<
                    'READY' | 'DELETED'
                  >`CASE WHEN ${mediaAsset.isDeleted} THEN 'DELETED' ELSE 'READY' END`,
                })
                .from(messageAsset)
                .innerJoin(
                  mediaAsset,
                  eq(mediaAsset.digest, messageAsset.digest),
                )
                .where(inArray(messageAsset.messageId, messageIds)),
          threadIds.length === 0
            ? Promise.resolve([])
            : tx
                .select({
                  threadId: threadParticipant.threadId,
                  account: user.account,
                  domain: user.domain,
                })
                .from(threadParticipant)
                .innerJoin(user, eq(user.id, threadParticipant.userId))
                .where(inArray(threadParticipant.threadId, threadIds)),
          groupIds.length === 0
            ? Promise.resolve([])
            : tx
                .select({
                  id: user.id,
                  account: user.account,
                  domain: user.domain,
                })
                .from(user)
                .where(inArray(user.id, groupIds)),
        ]);
        this.assertBeforeDeadline(deadline);

        const assets = new Map<bigint, FederationMessageFeedAsset[]>();
        for (const row of assetRows) {
          const list = assets.get(row.messageId) ?? [];
          list.push({
            digest: row.digest,
            bytes: Number(row.bytes),
            status: row.status,
          });
          assets.set(row.messageId, list);
        }
        const participants = new Map<
          number,
          Array<{ account: string; domain: string }>
        >();
        for (const row of participantRows) {
          const list = participants.get(row.threadId) ?? [];
          list.push({
            account: row.account,
            domain: this.wireDomain(row.domain),
          });
          participants.set(row.threadId, list);
        }
        const groups = new Map(
          groupRows.map((row) => [
            row.id,
            { account: row.account, domain: this.wireDomain(row.domain) },
          ]),
        );

        // Message content stores a quote as this server's local thread seq. Federation wire data must
        // instead carry the quoted author's stable (address, originSeq) coordinate, because the receiver
        // allocates its own unrelated local seq. Resolve all quoted targets for the page in one query.
        const quoteRefs = new Map<string, { threadId: number; seq: number }>();
        for (const row of changes) {
          if (row.federationAuthoredSnapshot) continue;
          if (row.contentType !== ContentType.PURE_TEXT) continue;
          const quoteSeq = parseTextMessageContent(row.content)?.quote?.seq;
          if (quoteSeq !== undefined) {
            quoteRefs.set(`${row.threadId}\u0000${quoteSeq}`, {
              threadId: row.threadId,
              seq: quoteSeq,
            });
          }
        }
        const quotedRows =
          quoteRefs.size === 0
            ? []
            : await tx
                .select({
                  threadId: message.threadId,
                  seq: message.seq,
                  originSeq: message.originSeq,
                  account: user.account,
                  domain: user.domain,
                })
                .from(message)
                .innerJoin(user, eq(user.id, message.creator))
                .where(
                  sql`(${message.threadId}, ${message.seq}) IN (${sql.join(
                    [...quoteRefs.values()].map(
                      (ref) => sql`(${ref.threadId}, ${ref.seq})`,
                    ),
                    sql`, `,
                  )})`,
                );
        const quoteTargets = new Map(
          quotedRows.map((row) => [
            `${row.threadId}\u0000${row.seq}`,
            {
              creator: {
                account: row.account,
                domain: this.wireDomain(row.domain),
              },
              // A local source row keeps originSeq null until its delivery receipt returns, so its
              // local seq is the wire source coordinate in the meantime.
              originSeq: row.originSeq ?? row.seq,
            },
          ]),
        );

        const messages = changes
          .filter((row) => !excludeSelf || row.authorDomain !== peerDomain)
          .map((row): FederationMessageFeedMessage => {
            const group = row.groupUserId
              ? groups.get(row.groupUserId)
              : undefined;
            if (row.threadType === 'GROUP' && !group) {
              throw new Error(
                `group identity missing for thread ${row.threadId}`,
              );
            }
            const quoteSeq =
              !row.federationAuthoredSnapshot &&
              row.contentType === ContentType.PURE_TEXT
                ? parseTextMessageContent(row.content)?.quote?.seq
                : undefined;
            const quoteTarget =
              row.federationAuthoredSnapshot?.quoteTarget ??
              (quoteSeq === undefined
                ? undefined
                : quoteTargets.get(`${row.threadId}\u0000${quoteSeq}`));
            if (quoteSeq !== undefined && !quoteTarget) {
              throw new Error(
                `quoted message ${row.threadId}/${quoteSeq} is missing`,
              );
            }
            const author = {
              account: row.authorAccount,
              domain: this.wireDomain(row.authorDomain),
            };
            const thread: FederationMessageFeedMessage['thread'] = group
              ? { type: 'GROUP', ...group }
              : {
                  type: 'P2P',
                  participants: participants.get(row.threadId) ?? [],
                };
            let content =
              row.federationAuthoredSnapshot?.content ??
              toFederatedMessageContent(row.contentType, row.content);
            if (
              !row.federationAuthoredSnapshot &&
              row.contentType === ContentType.CALL
            ) {
              const local = parseCallContent(row.content);
              const callee =
                thread.type === 'P2P'
                  ? thread.participants.find(
                      (participant) =>
                        participant.account !== author.account ||
                        participant.domain !== author.domain,
                    )
                  : undefined;
              if (!local || !callee) {
                throw new Error(
                  `CALL message ${row.threadId}/${row.seq} has no valid federation projection`,
                );
              }
              content = buildFederatedCallContent(local, author, callee);
            }
            return {
              feedId: row.feedId.toString(),
              thread,
              author,
              seq: row.seq,
              originSeq: row.originSeq ?? row.seq,
              contentType: row.contentType,
              content,
              createdAt: row.createdAt.getTime(),
              updatedAt: row.updatedAt.getTime(),
              clientMessageId: row.federationAuthoredSnapshot
                ? row.federationAuthoredSnapshot.clientMessageId
                : row.clientMessageId,
              ...(quoteTarget ? { quoteTarget } : {}),
              assets:
                row.federationAuthoredSnapshot?.assets ??
                assets.get(row.messageId) ??
                [],
            };
          });
        for (const row of changes) {
          if (row.federationAuthoredSnapshot) continue;
          const item = messages.find(
            (messageItem) => messageItem.feedId === row.feedId.toString(),
          );
          if (!item) continue;
          await tx
            .update(message)
            .set({ federationAuthoredSnapshot: authoredMessageSnapshot(item) })
            .where(
              and(
                eq(message.id, row.messageId),
                isNull(message.federationAuthoredSnapshot),
              ),
            );
        }
        this.assertBeforeDeadline(deadline);
        const scannedThrough = memoryScannedThrough;
        return {
          scannedThrough,
          value: {
            messages,
            scannedThrough: scannedThrough.toString(),
            hasMore: scannedThrough < effectiveAllocatedThrough,
          },
        };
      },
    );
    return { page: result.value, acknowledgedThrough };
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

  private readSnapshot(
    peerDomain: string,
    after: bigint,
    take: number,
    trunc: bigint | undefined,
    excludeSelf: boolean,
    requestEnd: bigint,
  ): FederationBufferedChange[] {
    const cached = this.snapshots.get(peerDomain);
    if (
      cached?.after === after &&
      cached.take === take &&
      cached.trunc === trunc &&
      cached.excludeSelf === excludeSelf
    ) {
      return cached.refs.slice();
    }
    const refs = this.memoryFeed
      .readAfterWhileLocked(peerDomain, after, take)
      .filter((entry) => entry.feedId <= requestEnd)
      .slice();
    if (refs.length > 0) {
      this.snapshots.set(peerDomain, {
        after,
        take,
        trunc,
        excludeSelf,
        refs: refs.slice(),
      });
    } else {
      this.snapshots.delete(peerDomain);
    }
    return refs;
  }

  private assertBeforeDeadline(deadline: number): void {
    if (Date.now() > deadline) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        'federation missed request exceeded its application deadline',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private wireDomain(domain: string): string {
    return domain === 'local' ? this.localDomain : domain;
  }
}
