import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  ne,
  sql,
} from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  federationMessageFeedIndex,
  federationServeCursor,
  group,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  threadMember,
  threadParticipant,
  user,
} from '../database/schema.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import {
  buildFederatedCallContent,
  parseCallContent,
} from '../calls/call-content.js';
import { CALL_SID_RE } from '../calls/federated-call-protocol.js';
import {
  federatedContentDigests,
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
  | { account: string; peerAccount: string }
  | { account: string };

export type FederationThreadQuery =
  | { type: 'GROUP'; account: string }
  | { type: 'P2P'; account: string; peerAccount: string };

export type FederationMessageFeedAsset = FederationByteDescriptor;

interface FederationMessageFeedMessageBase
  extends FederatedMessagePayload<string> {
  seq: number;
  originSeq: number | null;
  originCreatedAt: number | null;
  createdAt: number;
  clientMessageId?: string;
  quoteTarget?: {
    targetSeq: number;
  };
  assets: FederationMessageFeedAsset[];
}

export type FederationMessageFeedMessage =
  | (FederationMessageFeedMessageBase & {
      thread: { account: string; peerAccount: string };
      authorRef: 'THREAD_ACCOUNT' | 'THREAD_PEER_ACCOUNT';
    })
  | (FederationMessageFeedMessageBase & {
      thread: { account: string };
      author: FederationAddress;
    });

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
  private readonly logger = new Logger(FederationMessageFeedService.name);

  private readonly localDomain = loadFederationConfig().domain;

  constructor(
    private readonly database: DatabaseService,
    private readonly indexer: FederationMessageFeedIndexerService,
  ) {}

  async rejectMissingAfter(peerDomain: string): Promise<never> {
    await this.requireTarget(peerDomain);
    await this.indexer.fill(peerDomain);
    const end = await this.database.db.transaction((tx) =>
      this.readEndInTx(tx, peerDomain),
    );
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the message feed cursor',
      HttpStatus.OK,
      { resumeAfter: '0', resumeBefore: (end + 1n).toString() },
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
          { resumeAfter: '0', resumeBefore: (end + 1n).toString() },
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
        peerDomain,
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
    const { threadId, messageAccessAfterSeq } =
      await this.resolveAuthorizedThread(peerDomain, selector);
    const [projection] = await this.database.db
      .select({ end: federationMessageFeedIndex.messageEndSeq })
      .from(federationMessageFeedIndex)
      .where(
        and(
          eq(federationMessageFeedIndex.peerDomain, peerDomain),
          eq(federationMessageFeedIndex.threadId, threadId),
        ),
      )
      .limit(1);
    const currentEnd = Math.max(projection?.end ?? 0, messageAccessAfterSeq);
    throw new BusinessException(
      BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the message query cursor',
      HttpStatus.OK,
      {
        resumeAfter: messageAccessAfterSeq.toString(),
        resumeBefore: (currentEnd + 1).toString(),
      },
    );
  }

  async query(
    peerDomain: string,
    selector: FederationThreadQuery,
    after: number | undefined,
    requestedTake?: number,
    through?: number,
    includeSelf = true,
    before?: number,
  ): Promise<FederationMessageQueryPage> {
    const take = this.pageSize(requestedTake);
    if ((after === undefined) === (before === undefined))
      this.invalidDirection();
    if (through !== undefined && through < 0) this.invalidThrough();
    if (after !== undefined && through !== undefined && through < after)
      this.invalidThrough();
    if (before !== undefined && through !== undefined && through > before)
      this.invalidReverseThrough();
    const { threadId, messageAccessAfterSeq } =
      await this.resolveAuthorizedThread(peerDomain, selector);
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
      const currentEnd = Math.max(projection?.end ?? 0, messageAccessAfterSeq);
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
            resumeAfter: resumeAfter.toString(),
            resumeBefore: resumeBefore.toString(),
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
              originSeq: message.originSeq,
              originServerTime: message.originServerTime,
              contentType: message.contentType,
              content: message.content,
              createdAt: message.createdAt,
              clientMessageId: message.clientMessageId,
              threadType: messageThread.type,
              groupId: messageThread.groupId,
              authorAccount: sql<string>`${message.creatorAccount}`,
              authorDomain: sql<string>`${message.creatorDomain}`,
            })
            .from(message)
            .innerJoin(messageThread, eq(messageThread.id, message.threadId))
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
                ne(message.contentType, ContentType.SYSTEM),
                includeSelf ? undefined : ne(message.creatorDomain, peerDomain),
              ),
            )
            .orderBy(forward ? asc(message.seq) : desc(message.seq))
            .limit(take + 1);
      const selected = rows.slice(0, take);
      const messages = await this.serializeMessagesInTx(
        tx,
        selected,
        peerDomain,
      );
      const scannedThrough =
        rows.length > take
          ? selected.at(-1)!.seq
          : forward
            ? queryEnd
            : queryStart;
      return {
        messages,
        scannedThrough: scannedThrough.toString(),
        hasMore: forward
          ? scannedThrough < queryEnd
          : scannedThrough > queryStart,
      };
    });
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
      originSeq: number | null;
      originServerTime: Date | null;
      contentType: ContentType;
      content: string;
      createdAt: Date;
      clientMessageId: string | null;
      threadType: 'P2P' | 'GROUP';
      groupId: number | null;
      authorAccount: string;
      authorDomain: string;
    }>,
    peerDomain: string,
  ): Promise<FederationMessageFeedMessage[]> {
    if (rows.length === 0) return [];
    const messageIds = rows.map((row) => row.messageId);
    const addresses = await this.threadAddressesInTx(
      tx,
      [...new Set(rows.map((row) => row.threadId))],
      peerDomain,
    );
    const groupIds = rows.flatMap((row) =>
      row.groupId === null ? [] : [row.groupId],
    );
    const groupStates =
      groupIds.length === 0
        ? []
        : await tx
            .select({ id: group.id, domain: group.domain })
            .from(group)
            .where(inArray(group.id, groupIds));
    const groupOriginById = new Map(
      groupStates.map((groupState) => [
        groupState.id,
        this.wireDomain(groupState.domain),
      ]),
    );
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
      if (row.contentType !== ContentType.PURE_TEXT) return [];
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
              account: message.creatorAccount,
              domain: message.creatorDomain,
            })
            .from(message)
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
        row.contentType === ContentType.PURE_TEXT
          ? parseTextMessageContent(row.content)?.quote?.seq
          : undefined;
      const quoteTarget =
        quoteSeq === undefined
          ? undefined
          : quoteTargets.get(JSON.stringify([row.threadId, quoteSeq]));
      let content: string;
      let contentDigests: Set<string>;
      let callClientMessageId: string | undefined;
      try {
        content = toFederatedMessageContent(
          row.contentType,
          row.content,
          this.localDomain,
        );
        if (row.contentType === ContentType.CALL) {
          const local = parseCallContent(row.content);
          if (!local || row.threadType !== 'P2P')
            throw new Error('invalid federated CALL projection');
          if (
            row.clientMessageId === null ||
            !CALL_SID_RE.test(row.clientMessageId)
          ) {
            throw new Error(
              'federated CALL is missing a valid clientMessageId',
            );
          }
          callClientMessageId = row.clientMessageId;
          content = buildFederatedCallContent(local);
        }
        contentDigests = new Set(
          federatedContentDigests(row.contentType, content),
        );
      } catch (error) {
        // One malformed legacy row must not poison the peer's entire page forever. The page cursor is
        // based on scanned source seqs rather than returned item count, so omitting this row advances
        // past it while valid rows in the same page remain deliverable.
        this.logger.warn(
          `skipping malformed federated message (thread ${row.threadId}, seq ${row.seq}, type ${row.contentType}): ${(error as Error).message}`,
        );
        continue;
      }
      const candidateAssets = assets.get(row.messageId) ?? [];
      // A FORWARD card references its closure by bundleId; the closure manifest, rather than the
      // card itself, owns the referenced digests. Other message types must not leak receiver-local
      // presentation assets (notably LINK artwork) into the wire projection.
      const projectedAssets =
        row.contentType === ContentType.FORWARD
          ? candidateAssets
          : candidateAssets.filter((asset) => contentDigests.has(asset.digest));
      const isProcessingReceipt =
        row.originSeq !== null &&
        (row.threadType === 'P2P'
          ? author.domain === peerDomain
          : groupOriginById.get(row.groupId!) === peerDomain);
      const envelope = {
        seq: row.seq,
        originSeq: isProcessingReceipt ? row.originSeq : null,
        originCreatedAt: isProcessingReceipt
          ? (row.originServerTime?.getTime() ?? null)
          : null,
        contentType: row.contentType,
        content,
        createdAt: row.createdAt.getTime(),
        ...(callClientMessageId
          ? { clientMessageId: callClientMessageId }
          : {}),
        ...(quoteTarget ? { quoteTarget } : {}),
        // MessageAsset also authorizes receiver-local presentation assets, notably LINK artwork.
        // Only descriptors referenced by the URL-free wire content belong in the federation payload.
        assets: projectedAssets,
      };
      let item: FederationMessageFeedMessage;
      if ('peerAccount' in thread) {
        const sourceAuthored =
          author.domain === this.localDomain &&
          author.account === thread.account;
        const peerAuthored =
          author.domain === peerDomain && author.account === thread.peerAccount;
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

  private async resolveAuthorizedThread(
    peerDomain: string,
    selector: FederationThreadQuery,
  ): Promise<{ threadId: number; messageAccessAfterSeq: number }> {
    const rows =
      selector.type === 'GROUP'
        ? await this.database.db.execute<{
            threadId: number;
            messageAccessAfterSeq: number;
          }>(sql`
            SELECT thread.id AS "threadId",
              audience."messageAccessAfterSeq" AS "messageAccessAfterSeq"
            FROM "MessageThread" thread
            JOIN "Group" group_user ON group_user.id = thread."groupId"
            JOIN "ThreadAudience" audience ON audience."threadId" = thread.id
              AND audience."targetDomain" = ${peerDomain}
              AND audience."localUserId" IS NULL
            WHERE thread.type = 'GROUP'
              AND group_user.account = ${selector.account}
            LIMIT 1
          `)
        : await this.database.db.execute<{
            threadId: number;
            messageAccessAfterSeq: number;
          }>(sql`
            SELECT thread.id AS "threadId",
              audience."messageAccessAfterSeq" AS "messageAccessAfterSeq"
            FROM "MessageThread" thread
            JOIN "ThreadAudience" audience ON audience."threadId" = thread.id
              AND audience."targetDomain" = ${peerDomain}
              AND audience."localUserId" IS NULL
            WHERE thread.type = 'P2P'
              AND EXISTS (
                SELECT 1 FROM "ThreadMember" member_link
                JOIN "User" member ON member.id = member_link."userId"
                WHERE member_link."threadId" = thread.id
                  AND member_link."left" = false
                  AND member.account = ${selector.account}
                  AND member.domain = 'local'
              )
              AND EXISTS (
                SELECT 1 FROM "ThreadMember" member_link
                JOIN "User" member ON member.id = member_link."userId"
                WHERE member_link."threadId" = thread.id
                  AND member_link."left" = false
                  AND member.account = ${selector.peerAccount}
                  AND member.domain <> 'local'
                  AND member.domain = ${peerDomain}
              )
            LIMIT 1
          `);
    const authorized = rows.rows[0];
    if (!authorized) {
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'the signed peer does not currently have access to this thread',
        HttpStatus.OK,
      );
    }
    return authorized;
  }

  private async threadAddressesInTx(
    tx: DatabaseTransaction,
    threadIds: number[],
    peerDomain: string,
  ): Promise<Map<number, FederationThreadAddress>> {
    if (threadIds.length === 0) return new Map();
    const threads = await tx
      .select({
        id: messageThread.id,
        type: messageThread.type,
        groupId: messageThread.groupId,
      })
      .from(messageThread)
      .where(inArray(messageThread.id, threadIds));
    const participants = await tx
      .select({
        threadId: threadMember.threadId,
        account: user.account,
        domain: user.domain,
      })
      .from(threadMember)
      .innerJoin(user, eq(user.id, threadMember.userId))
      .where(inArray(threadMember.threadId, threadIds));
    const groupIds = threads.flatMap((row) =>
      row.groupId === null ? [] : [row.groupId],
    );
    const groups =
      groupIds.length === 0
        ? []
        : await tx
            .select({
              id: group.id,
              account: group.account,
              domain: group.domain,
            })
            .from(group)
            .where(inArray(group.id, groupIds));
    const groupById = new Map(groups.map((row) => [row.id, row]));
    const result = new Map<number, FederationThreadAddress>();
    for (const thread of threads) {
      if (thread.type === 'GROUP') {
        const groupState = groupById.get(thread.groupId!);
        if (!groupState)
          throw new Error(`group identity missing for thread ${thread.id}`);
        result.set(thread.id, {
          account: groupState.account,
        });
      } else {
        const members = participants.filter(
          (row) => row.threadId === thread.id,
        );
        const source = members.find(
          (row) => this.wireDomain(row.domain) === this.localDomain,
        );
        const target = members.find(
          (row) => this.wireDomain(row.domain) === peerDomain,
        );
        if (!source || !target)
          throw new Error(
            `P2P thread ${thread.id} has no peer-relative address`,
          );
        result.set(thread.id, {
          account: source.account,
          peerAccount: target.account,
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
