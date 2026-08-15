import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  federationMessageFeedIndex,
  federationServeCursor,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  threadParticipant,
  user,
} from '../database/schema.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import {
  buildFederatedCallContent,
  parseCallContent,
} from '../calls/call-content.js';
import {
  authoredMessageSnapshot,
  toFederatedMessageContent,
} from './federated-message-content.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationMessageFeedIndexerService } from './federation-message-feed-indexer.service.js';
import type {
  FederationAddress,
  FederationByteDescriptor,
  FederatedMessagePayload,
} from './federated-message-types.js';

export const FEDERATION_MESSAGE_FEED_DEFAULT_PAGE_SIZE = 100;
export const FEDERATION_MESSAGE_FEED_MAX_PAGE_SIZE = 200;
export const FEDERATED_MESSAGE_CONTENT_TYPES: ContentType[] = Object.values(
  ContentType,
).filter((type) => type !== ContentType.SYSTEM);

export type FederationThreadAddress =
  | { type: 'GROUP'; account: string; domain: string }
  | {
      type: 'P2P';
      participants: FederationAddress[];
    };

export type FederationThreadQuery =
  | { type: 'GROUP'; groupAccount: string; groupDomain: string }
  | { type: 'P2P'; account: string; peerAccount: string };

export type FederationMessageFeedAsset = FederationByteDescriptor;

export interface FederationMessageFeedMessage
  extends FederatedMessagePayload<string> {
  thread: FederationThreadAddress;
  author: FederationAddress;
  seq: number;
  originSeq: number | null;
  originCreatedAt: number | null;
  createdAt: number;
  clientMessageId: string | null;
  quoteTarget?: {
    targetSeq: number;
  };
  assets: FederationMessageFeedAsset[];
}

export interface FederationMessageFeedPage {
  items: Array<{
    feedId: string;
    thread: FederationThreadAddress;
    messageEndSeq: string;
  }>;
  scannedThrough: string;
  messageFeedEndId: string;
  hasMore: boolean;
  /** Consumer-only materialization; never serialized by the source endpoint. */
  messages?: FederationMessageFeedMessage[];
  queryCursors?: Array<{ threadKey: string; committedThrough: number }>;
}

export interface FederationMessageQueryPage {
  messages: FederationMessageFeedMessage[];
  scannedThrough: string;
  hasMore: boolean;
}

@Injectable()
export class FederationMessageFeedService {
  private readonly localDomain = loadFederationConfig().domain;

  constructor(
    private readonly database: DatabaseService,
    private readonly indexer: FederationMessageFeedIndexerService,
  ) {}

  async rejectMissingAfter(peerDomain: string): Promise<never> {
    await this.requireTarget(peerDomain);
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the message feed cursor',
      HttpStatus.OK,
      { resumeAfter: '0' },
    );
  }

  async serve(
    peerDomain: string,
    after: bigint,
    requestedTake?: number,
    through?: bigint,
  ): Promise<FederationMessageFeedPage> {
    const take = this.pageSize(requestedTake);
    if (through !== undefined && through < after) this.invalidThrough();
    await this.indexer.fill(peerDomain);
    return this.database.db.transaction(async (tx) => {
      const end = await this.readEndInTx(tx, peerDomain);
      if (after < 0n || after > end) {
        throw new BusinessException(
          BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
          'message feed cursor is outside the available coordinate space',
          HttpStatus.OK,
          { resumeAfter: '0' },
        );
      }
      const requestEnd = through === undefined || through > end ? end : through;
      const rows = await tx
        .select({
          threadId: federationMessageFeedIndex.threadId,
          feedId: federationMessageFeedIndex.feedId,
          messageEndSeq: federationMessageFeedIndex.messageEndSeq,
        })
        .from(federationMessageFeedIndex)
        .where(
          and(
            eq(federationMessageFeedIndex.peerDomain, peerDomain),
            gt(federationMessageFeedIndex.feedId, after),
            lte(federationMessageFeedIndex.feedId, requestEnd),
          ),
        )
        .orderBy(asc(federationMessageFeedIndex.feedId))
        .limit(take + 1);
      const selected = rows.slice(0, take);
      const addresses = await this.threadAddressesInTx(
        tx,
        selected.map((row) => row.threadId),
      );
      const items = selected.map((row) => ({
        feedId: row.feedId.toString(),
        thread: this.requiredAddress(addresses, row.threadId),
        messageEndSeq: row.messageEndSeq.toString(),
      }));
      const scannedThrough =
        rows.length > take ? selected.at(-1)!.feedId : requestEnd;
      return {
        items,
        scannedThrough: scannedThrough.toString(),
        messageFeedEndId: end.toString(),
        hasMore: scannedThrough < requestEnd,
      };
    });
  }

  async rejectMissingQueryAfter(
    peerDomain: string,
    selector: FederationThreadQuery,
  ): Promise<never> {
    const threadId = await this.resolveAuthorizedThread(peerDomain, selector);
    void threadId;
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the message query cursor',
      HttpStatus.OK,
      { resumeAfter: '0' },
    );
  }

  async query(
    peerDomain: string,
    selector: FederationThreadQuery,
    after: number,
    requestedTake?: number,
    through?: number,
    includeSelf = true,
  ): Promise<FederationMessageQueryPage> {
    const take = this.pageSize(requestedTake);
    if (after < 0 || (through !== undefined && through < 0))
      this.invalidThrough();
    if (through !== undefined && through < after) this.invalidThrough();
    const threadId = await this.resolveAuthorizedThread(peerDomain, selector);
    return this.database.db.transaction(async (tx) => {
      const [projection] = await tx
        .select({ end: federationMessageFeedIndex.messageEndSeq })
        .from(federationMessageFeedIndex)
        .where(
          and(
            eq(federationMessageFeedIndex.peerDomain, peerDomain),
            eq(federationMessageFeedIndex.threadId, threadId),
          ),
        )
        .limit(1);
      const currentEnd = projection?.end ?? 0;
      if (after > currentEnd) {
        throw new BusinessException(
          BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
          'message query cursor is beyond the current thread end',
          HttpStatus.OK,
          { resumeAfter: currentEnd.toString() },
        );
      }
      const queryEnd = Math.min(through ?? currentEnd, currentEnd);
      const rows =
        queryEnd <= after
          ? []
          : await tx
              .select({
                messageId: message.id,
                threadId: message.threadId,
                seq: message.seq,
                originSeq: message.originSeq,
                originServerTime: message.originServerTime,
                contentType: message.contentType,
                content: message.content,
                createdAt: message.createdAt,
                clientMessageId: message.clientMessageId,
                federationAuthoredSnapshot: message.federationAuthoredSnapshot,
                threadType: messageThread.type,
                groupUserId: messageThread.groupUserId,
                authorAccount: user.account,
                authorDomain: user.domain,
              })
              .from(message)
              .innerJoin(messageThread, eq(messageThread.id, message.threadId))
              .innerJoin(user, eq(user.id, message.creator))
              .where(
                and(
                  eq(message.threadId, threadId),
                  gt(message.seq, after),
                  lte(message.seq, queryEnd),
                  eq(message.isDeleted, false),
                  ne(message.contentType, ContentType.SYSTEM),
                  includeSelf ? undefined : ne(user.domain, peerDomain),
                ),
              )
              .orderBy(asc(message.seq))
              .limit(take + 1);
      const selected = rows.slice(0, take);
      const messages = await this.serializeMessagesInTx(
        tx,
        selected,
        peerDomain,
      );
      const scannedThrough =
        rows.length > take ? selected.at(-1)!.seq : queryEnd;
      return {
        messages,
        scannedThrough: Math.max(scannedThrough, after).toString(),
        hasMore: scannedThrough < queryEnd,
      };
    });
  }

  private async serializeMessagesInTx(
    tx: DatabaseTransaction,
    rows: Array<{
      messageId: bigint;
      threadId: number;
      seq: number;
      originSeq: number | null;
      originServerTime: Date | null;
      contentType: ContentType;
      content: string;
      createdAt: Date;
      clientMessageId: string | null;
      federationAuthoredSnapshot: typeof message.$inferSelect.federationAuthoredSnapshot;
      threadType: 'P2P' | 'GROUP';
      groupUserId: number | null;
      authorAccount: string;
      authorDomain: string;
    }>,
    peerDomain: string,
  ): Promise<FederationMessageFeedMessage[]> {
    if (rows.length === 0) return [];
    const messageIds = rows.map((row) => row.messageId);
    const addresses = await this.threadAddressesInTx(tx, [
      ...new Set(rows.map((row) => row.threadId)),
    ]);
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

    const quoteRefs = rows.flatMap((row) => {
      if (
        row.federationAuthoredSnapshot ||
        row.contentType !== ContentType.PURE_TEXT
      )
        return [];
      const seq = parseTextMessageContent(row.content)?.quote?.seq;
      return seq === undefined ? [] : [{ threadId: row.threadId, seq }];
    });
    const quoted =
      quoteRefs.length === 0
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
                quoteRefs.map((ref) => sql`(${ref.threadId}, ${ref.seq})`),
                sql`, `,
              )})`,
            );
    const quoteTargets = new Map(
      quoted.map((row) => [
        JSON.stringify([row.threadId, row.seq]),
        {
          targetSeq: row.seq,
        },
      ]),
    );

    const result: FederationMessageFeedMessage[] = [];
    for (const row of rows) {
      const thread = this.requiredAddress(addresses, row.threadId);
      const author = {
        account: row.authorAccount,
        domain: this.wireDomain(row.authorDomain),
      };
      const quoteSeq =
        (!row.federationAuthoredSnapshot ||
          (thread.type === 'GROUP' && thread.domain === this.localDomain)) &&
        row.contentType === ContentType.PURE_TEXT
          ? parseTextMessageContent(row.content)?.quote?.seq
          : undefined;
      const authoritativeGroupProjection =
        thread.type === 'GROUP' && thread.domain === this.localDomain;
      const quoteTarget =
        (!authoritativeGroupProjection
          ? row.federationAuthoredSnapshot?.quoteTarget
          : undefined) ??
        (quoteSeq === undefined
          ? undefined
          : quoteTargets.get(JSON.stringify([row.threadId, quoteSeq])));
      let content =
        (!authoritativeGroupProjection
          ? row.federationAuthoredSnapshot?.content
          : undefined) ??
        toFederatedMessageContent(
          row.contentType,
          row.content,
          this.localDomain,
        );
      if (
        !row.federationAuthoredSnapshot &&
        row.contentType === ContentType.CALL
      ) {
        const local = parseCallContent(row.content);
        if (!local || thread.type !== 'P2P')
          throw new Error('invalid federated CALL projection');
        content = buildFederatedCallContent(local);
      }
      const isProcessingReceipt =
        row.originSeq !== null &&
        (thread.type === 'P2P'
          ? author.domain === peerDomain
          : thread.domain === peerDomain);
      const item: FederationMessageFeedMessage = {
        thread,
        author,
        seq: row.seq,
        originSeq: isProcessingReceipt ? row.originSeq : null,
        originCreatedAt: isProcessingReceipt
          ? (row.originServerTime?.getTime() ?? null)
          : null,
        contentType: row.contentType,
        content,
        createdAt: row.createdAt.getTime(),
        clientMessageId: row.federationAuthoredSnapshot
          ? row.federationAuthoredSnapshot.clientMessageId
          : row.clientMessageId,
        ...(quoteTarget ? { quoteTarget } : {}),
        assets: authoritativeGroupProjection
          ? (assets.get(row.messageId) ?? [])
          : (row.federationAuthoredSnapshot?.assets ??
            assets.get(row.messageId) ??
            []),
      };
      result.push(item);
      if (!row.federationAuthoredSnapshot) {
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
    }
    return result;
  }

  private async resolveAuthorizedThread(
    peerDomain: string,
    selector: FederationThreadQuery,
  ): Promise<number> {
    const rows =
      selector.type === 'GROUP'
        ? await this.database.db.execute<{ threadId: number }>(sql`
            SELECT thread.id AS "threadId"
            FROM "MessageThread" thread
            JOIN "User" group_user ON group_user.id = thread."groupUserId"
            WHERE thread.type = 'GROUP'
              AND group_user.account = ${selector.groupAccount}
              AND (CASE WHEN group_user.domain = 'local' THEN ${this.localDomain} ELSE group_user.domain END) = ${selector.groupDomain}
              AND EXISTS (
                SELECT 1 FROM "ThreadAudience" audience
                WHERE audience."threadId" = thread.id
                  AND audience."targetDomain" = ${peerDomain}
                  AND audience."localUserId" IS NULL
              )
            LIMIT 1
          `)
        : await this.database.db.execute<{ threadId: number }>(sql`
            SELECT thread.id AS "threadId"
            FROM "MessageThread" thread
            WHERE thread.type = 'P2P'
              AND EXISTS (
                SELECT 1 FROM "ThreadAudience" audience
                WHERE audience."threadId" = thread.id
                  AND audience."targetDomain" = ${peerDomain}
                  AND audience."localUserId" IS NULL
              )
              AND EXISTS (
                SELECT 1 FROM "ThreadParticipant" participant
                JOIN "User" member ON member.id = participant."userId"
                WHERE participant."threadId" = thread.id
                  AND member.account = ${selector.account}
                  AND member."isForeigner" = false
              )
              AND EXISTS (
                SELECT 1 FROM "ThreadParticipant" participant
                JOIN "User" member ON member.id = participant."userId"
                WHERE participant."threadId" = thread.id
                  AND member.account = ${selector.peerAccount}
                  AND member."isForeigner" = true
                  AND member.domain = ${peerDomain}
              )
            LIMIT 1
          `);
    const threadId = rows.rows[0]?.threadId;
    if (threadId === undefined) {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'the signed peer does not currently have access to this thread',
        HttpStatus.OK,
      );
    }
    return threadId;
  }

  private async threadAddressesInTx(
    tx: DatabaseTransaction,
    threadIds: number[],
  ): Promise<Map<number, FederationThreadAddress>> {
    if (threadIds.length === 0) return new Map();
    const threads = await tx
      .select({
        id: messageThread.id,
        type: messageThread.type,
        groupUserId: messageThread.groupUserId,
      })
      .from(messageThread)
      .where(inArray(messageThread.id, threadIds));
    const participants = await tx
      .select({
        threadId: threadParticipant.threadId,
        account: user.account,
        domain: user.domain,
      })
      .from(threadParticipant)
      .innerJoin(user, eq(user.id, threadParticipant.userId))
      .where(inArray(threadParticipant.threadId, threadIds));
    const groupIds = threads.flatMap((row) =>
      row.groupUserId === null ? [] : [row.groupUserId],
    );
    const groups =
      groupIds.length === 0
        ? []
        : await tx
            .select({ id: user.id, account: user.account, domain: user.domain })
            .from(user)
            .where(inArray(user.id, groupIds));
    const groupById = new Map(groups.map((row) => [row.id, row]));
    const result = new Map<number, FederationThreadAddress>();
    for (const thread of threads) {
      if (thread.type === 'GROUP') {
        const group = groupById.get(thread.groupUserId!);
        if (!group)
          throw new Error(`group identity missing for thread ${thread.id}`);
        result.set(thread.id, {
          type: 'GROUP',
          account: group.account,
          domain: this.wireDomain(group.domain),
        });
      } else {
        result.set(thread.id, {
          type: 'P2P',
          participants: participants
            .filter((row) => row.threadId === thread.id)
            .map((row) => ({
              account: row.account,
              domain: this.wireDomain(row.domain),
            }))
            .sort(
              (a, b) =>
                a.domain.localeCompare(b.domain) ||
                a.account.localeCompare(b.account),
            ),
        });
      }
    }
    return result;
  }

  private requiredAddress(
    addresses: Map<number, FederationThreadAddress>,
    threadId: number,
  ): FederationThreadAddress {
    const address = addresses.get(threadId);
    if (!address) throw new Error(`thread ${threadId} has no wire address`);
    return address;
  }

  private async requireTarget(peerDomain: string): Promise<void> {
    const [row] = await this.database.db
      .select({ peerDomain: federationServeCursor.peerDomain })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!row) throw new Error(`peer ${peerDomain} has no message feed target`);
  }

  private async readEndInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
  ): Promise<bigint> {
    const [row] = await tx
      .select({ end: federationServeCursor.allocatedThrough })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!row) throw new Error(`peer ${peerDomain} has no message feed target`);
    return row.end;
  }

  private pageSize(value?: number): number {
    if (value === undefined) return FEDERATION_MESSAGE_FEED_DEFAULT_PAGE_SIZE;
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > FEDERATION_MESSAGE_FEED_MAX_PAGE_SIZE
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'take must be a positive safe integer no greater than 200',
        HttpStatus.BAD_REQUEST,
      );
    }
    return value;
  }

  private invalidThrough(): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      'through must be greater than or equal to after',
      HttpStatus.BAD_REQUEST,
    );
  }

  private wireDomain(domain: string): string {
    return domain === 'local' ? this.localDomain : domain;
  }
}
