import { enqueueDepartureFanoutsInTx } from './account-thread-fanout-task.js';
import { groupState as group, groupStateFields } from '../group/group-state.js';
import {
  forwardMessage,
  mediaAsset,
  messageAsset,
  message,
  deletedMessage,
  messageThread,
  pendingMedia,
  fileSyncProgress,
  federationThreadHistoryGap,
  profileTable,
  accountThreadState,
  account as user,
} from '../database/schema.js';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../relationship/thread-content-lock.js';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  gte,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  type Database,
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  ContentType,
  MessageThreadType,
  type MessageDeleteType,
} from '../database/enums.js';

import { rawDate } from '../database/raw-result.js';
import { isUniqueViolation } from '../database/database-error.js';
import {
  assembleOutboundContent,
  extractDigests,
  familyToFileSyncKind,
  type OutboundFilePayload,
} from '../upload/file-content.js';
import { contextualizeCasUrls } from '../upload/cas-url.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import { MEDIA_STATUS, type MediaStatus } from '../common/media-status.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { isThreadMutuallyAuthorized } from '../relationship/relationship-authorization.js';
import {
  parseMessageEntities,
  toDisplayText,
} from '../common/message-entity.js';
import {
  isValidSomfpUserAccount,
  parseSomfpUserAddress,
} from '../common/account.js';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import { deriveMessagePreview } from '../../shared/message-preview.js';
import {
  parseSystemMessageContent,
  stringifySystemMessageContent,
  SystemMessageType,
  resolveSystemMessageInTx,
  type SystemMessageInput,
} from './system-message.js';
import { enqueueThreadFanoutInTx } from './thread-fanout-task.js';
import { requireOutboundPendingMedia } from './pending-media-row.js';
import { resolveStoredQuotes } from './quote-reference.js';
import { ThreadPreviewService } from './thread-preview.service.js';

interface ReplyPreview {
  author: string;
  body: string;
  contentType: ContentType;
  image?: string;
  imageLabel?: string;
  imageIdentity?: string;
  imageSize?: number;
  imageShape?: 'thumbnail' | 'avatar';
}

export type UnreadMentionState = Array<'all' | 'me'>;
export type Message = typeof message.$inferSelect;
export interface MessageAuthorAddress {
  account: string;
  domain: string;
  namespaceId: number;
}
export type PublicMessage<T extends Message = Message> = Omit<
  T,
  'id' | 'creatorAccount' | 'creatorDomain' | 'creatorNamespaceId'
> & {
  creator: MessageAuthorAddress | null;
};
export interface MessageQueryParams {
  skip?: number;
  take?: number;
  orderBy?: { seq: 'asc' | 'desc' };
  cursor?: { threadId_seq: { threadId: number; seq: number } };
  truncateSeq?: number;
}

/** Query-only immutable slot; deleted bodies and media metadata never leave the server. */
export type ClientMessageTomb = Pick<
  PublicMessage,
  'threadId' | 'seq' | 'creator' | 'profileRev' | 'createdAt' | 'updatedAt'
> & { contentType: 'TOMB'; isDeleted: true; deletionType: MessageDeleteType };

export interface ClientMessagePageQuery {
  threadId: number;
  after?: number;
  before?: number;
  through?: number;
  take: number;
}

export interface ClientMessageHistoryGap {
  startSeq: number;
  endSeq: number;
  recoverable: boolean;
}

function authorNamespaceId(message: { creatorNamespaceId: number }): number {
  return message.creatorNamespaceId;
}

/**
 * Drop the internal BigInt `id` from a Message row. `id` is a global autoincrement — a cross-conversation
 * throughput side-channel whose deltas leak server-wide volume — so it must never reach a client or
 * federation payload; only the per-thread `seq` is public. Applied at every response/SSE boundary. (The
 * create path needs `id` for the MediaMessage FK, so the row is created in full and the id stripped only
 * on the way out — hence a post-hoc strip rather than a query-level omit on the create.)
 */
export function stripMessageId<
  T extends {
    id: bigint;
    creatorAccount: string | null;
    creatorDomain: string | null;
    creatorNamespaceId: number;
    sourceNamespaceId: number;
  },
>(
  msg: T,
): Omit<T, 'id' | 'creatorAccount' | 'creatorDomain' | 'creatorNamespaceId'> & {
  creator: MessageAuthorAddress | null;
} {
  const { id, creatorAccount, creatorDomain, creatorNamespaceId, ...rest } =
    msg;
  return {
    ...rest,
    creator:
      creatorAccount === null || creatorDomain === null
        ? null
        : {
            account: creatorAccount,
            domain: creatorDomain,
            namespaceId: authorNamespaceId(msg),
          },
  };
}

/**
 * Derive the short conversation-list preview for a message, by content type. Mirrored by a SQL CASE
 * over content types (the one-shot conversation-preview backfill); keep them in sync when
 * content types change. Text is whitespace-collapsed + trimmed so a multiline message renders on one line.
 */
export function derivePreview(type: ContentType, content: string): string {
  return deriveMessagePreview(type, content, toDisplayText);
}

/**
 * Message read/write data layer.
 *
 * Friendship state-machine logic formerly lived here; it has moved to FriendshipService (on the new
 * Friendship model). This service now deals with Message rows and thread content heads.
 * Membership authorization (is the caller an active AccountThreadState of this thread?)
 * is handled by AccountThreadStateService in the controllers before write/query is called.
 */
@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly linkPreview: LinkPreviewService,
    private readonly previews: ThreadPreviewService,
  ) {}

  private async queryRaw<T extends object[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    return (await this.database.db.execute(sql(strings, ...values))).rows as T;
  }

  private joinSql(values: readonly unknown[]): SQL {
    return sql.join(
      values.map((value) => sql`${value}`),
      sql`, `,
    );
  }

  private async localAuthor(userId: number): Promise<{
    account: string;
    domain: string;
    namespaceId: number;
  }> {
    const author = await this.database.db.query.account.findFirst({
      where: and(
        eq(user.id, userId),
        eq(user.domain, 'local'),
        eq(user.namespaceId, 0),
      ),
      columns: { account: true, domain: true, namespaceId: true },
    });
    if (!author) throw new Error('message author does not exist');
    return author;
  }

  async isAuthoredBy(
    creator: MessageAuthorAddress | null,
    userId: number,
  ): Promise<boolean> {
    if (creator === null) return false;
    const author = await this.localAuthor(userId);
    return (
      creator.account === author.account &&
      creator.domain === author.domain &&
      creator.namespaceId === author.namespaceId
    );
  }

  findByClientMessageId(clientMessageId: string) {
    return this.database.db.query.message
      .findFirst({ where: eq(message.clientMessageId, clientMessageId) })
      .then((row) => (row ? stripMessageId(row) : null));
  }

  /**
   * Append a message and admit its delivery work atomically. Sending does not advance read;
   * the unread eligibility predicate excludes the sender's own message independently.
   * Returns the Message MINUS its internal `id`: the BigInt global PK is a cross-conversation throughput
   * side-channel and must never leave the server — only the per-thread `seq` is public.
   *
   * Idempotent when a clientMessageId is supplied: a retried send (network blip after the server
   * committed) returns the ORIGINAL Message row instead of creating a duplicate. The partial unique
   * index on Message.clientMessageId is the dedup authority; the pre-check avoids throwing in the
   * common serial-retry case and the P2002 branch wins the concurrent-retry race (the interactive tx
   * is poisoned by the error, so the re-fetch runs on the root client).
   *
   * seq is allocated atomically from MessageThread.curSeq (`curSeq = curSeq + 1`, read back) inside the
   * tx — Postgres row-locks the MessageThread row until commit, so concurrent sends to the SAME thread
   * serialize (a brief wait, never an error) and each gets a distinct, gapless-modulo-rollback value.
   * No MAX() aggregate and no retry loop: the row lock IS the allocation authority. A local message
   * starts with originSeq equal to its local seq. A self-authored message-feed receipt may later replace
   * that provisional coordinate with the direct remote publisher's coordinate.
   */
  async writeMsgToThread(
    userId: number,
    threadId: number,
    content: string,
    type: ContentType,
    clientMessageId?: string,
    forwardBundleId?: string,
    beforeMessageCreate?: (tx: DatabaseTransaction) => Promise<void>,
    quoteVisibility?: {
      clearedThroughSeq?: number | null;
      hideCreators?: MessageAuthorAddress[];
    },
  ): Promise<PublicMessage> {
    if (clientMessageId !== undefined) {
      const existing = await this.findByClientMessageId(clientMessageId);
      if (existing !== null) return existing; // retry → return the original message (already dispatched)
    }
    try {
      return await this.previews.commitMessage(threadId, async (tx) => {
        if (beforeMessageCreate) await beforeMessageCreate(tx);
        // Atomic per-thread seq allocation: increment curSeq and read back the new value. The row lock
        // held to commit serializes concurrent sends to this thread (a brief wait, never an error) and
        // keeps curSeq == MAX(seq) by construction — no MAX() aggregate, no allocation race, no retry.
        // curSeq is the last allocated sequence and defaults to the pre-first cursor 0, so the
        // first message gets seq 1. Implementations may retain a larger watermark after migration.
        const [{ curSeq: seq }] = await tx
          .update(messageThread)
          .set({ curSeq: sql`${messageThread.curSeq} + 1` })
          .where(eq(messageThread.id, threadId))
          .returning({ curSeq: messageThread.curSeq });
        // The thread-row update above is also the relationship leave lock.
        // Re-check membership after acquiring it so a concurrent unfriend can
        // never commit between the HTTP guard and the actual message insert.
        const [writeAccess] = await tx
          .select({
            type: messageThread.type,
            creatorAccount: user.account,
            creatorDomain: user.domain,
            profileRev: user.defaultProfileRev,
          })
          .from(messageThread)
          .innerJoin(
            accountThreadState,
            and(
              eq(accountThreadState.threadId, messageThread.id),
              eq(accountThreadState.accountId, userId),
            ),
          )
          .innerJoin(user, eq(user.id, userId))
          .where(eq(messageThread.id, threadId))
          .limit(1);
        if (
          !writeAccess ||
          !(await isThreadMutuallyAuthorized(tx, userId, threadId))
        ) {
          throw new BusinessException(
            writeAccess?.type === MessageThreadType.GROUP
              ? BusinessCode.GROUP_FORBIDDEN
              : BusinessCode.FRIEND_NOT_FOUND,
            'conversation is read-only',
          );
        }
        const textContent =
          type === ContentType.PURE_TEXT
            ? parseTextMessageContent(content)
            : null;
        if (type === ContentType.PURE_TEXT && !textContent) {
          throw new BusinessException(
            BusinessCode.VALIDATION_FAILED,
            'invalid text message content',
          );
        }
        if (textContent) {
          for (const segment of parseMessageEntities(textContent.text)) {
            if (segment.kind !== 'entity' || segment.entityType !== 'user')
              continue;
            const localAccount = segment.entityId.endsWith('@local')
              ? segment.entityId.slice(0, -'@local'.length)
              : null;
            if (
              (localAccount === null ||
                !isValidSomfpUserAccount(localAccount)) &&
              !parseSomfpUserAddress(segment.entityId)
            ) {
              throw new BusinessException(
                BusinessCode.VALIDATION_FAILED,
                'user mention must use a valid full address',
              );
            }
          }
        }
        if (
          type === ContentType.SYSTEM &&
          !parseSystemMessageContent(content)
        ) {
          throw new BusinessException(
            BusinessCode.VALIDATION_FAILED,
            'invalid system message content',
          );
        }
        const quoteSeq = textContent?.quote?.seq;
        const quoteTarget =
          quoteSeq === undefined || quoteSeq === 0
            ? null
            : await tx.query.message
                .findFirst({
                  where: and(
                    eq(message.threadId, threadId),
                    eq(message.seq, quoteSeq),
                  ),
                })
                .then(async (row) => {
                  if (!row || row.creatorAccount === null) return row;
                  const snapshot = await tx.query.profileTable.findFirst({
                    where: and(
                      eq(profileTable.account, row.creatorAccount),
                      eq(profileTable.domain, row.creatorDomain!),
                      eq(profileTable.namespaceId, authorNamespaceId(row)),
                      eq(profileTable.profileRev, row.profileRev),
                    ),
                    columns: { displayName: true },
                  });
                  return {
                    ...row,
                    creatorItem: snapshot
                      ? { name: snapshot.displayName }
                      : undefined,
                  };
                });
        if (quoteSeq !== undefined && quoteSeq > 0 && !quoteTarget) {
          throw new BusinessException(
            BusinessCode.NOT_FOUND,
            'quoted message not found',
          );
        }
        if (
          quoteTarget &&
          (quoteTarget.isDeleted ||
            quoteTarget.contentType === ContentType.SYSTEM ||
            (quoteVisibility?.clearedThroughSeq !== null &&
              quoteVisibility?.clearedThroughSeq !== undefined &&
              quoteTarget.seq <= quoteVisibility.clearedThroughSeq) ||
            (quoteTarget.creatorAccount !== null &&
              quoteVisibility?.hideCreators?.some(
                (creator) =>
                  creator.account === quoteTarget.creatorAccount &&
                  creator.domain === quoteTarget.creatorDomain &&
                  creator.namespaceId === authorNamespaceId(quoteTarget),
              )))
        ) {
          throw new BusinessException(
            BusinessCode.NOT_FOUND,
            'quoted message not found',
          );
        }
        let storedContent =
          textContent && quoteSeq !== undefined
            ? stringifyTextMessageContent({
                text: textContent.text,
                quote: { seq: quoteSeq, namespaceId: 0 },
              })
            : content;
        storedContent = contextualizeCasUrls(storedContent, threadId, seq);
        const [msg] = await tx
          .insert(message)
          .values({
            content: storedContent,
            contentType: type,
            threadId,
            creatorAccount: writeAccess.creatorAccount,
            creatorDomain: writeAccess.creatorDomain,
            profileRev: writeAccess.profileRev,
            clientMessageId,
            seq,
            originSeq: seq,
            updatedAt: new Date(),
          })
          .returning();
        if (type === ContentType.FORWARD) {
          if (!forwardBundleId) {
            throw new Error('FORWARD message requires forwardBundleId');
          }
          await tx
            .insert(forwardMessage)
            .values({ messageId: msg.id, bundleId: forwardBundleId });
        }
        await tx
          .update(messageThread)
          .set({
            updatedAt: new Date(),
          })
          .where(eq(messageThread.id, threadId));
        // Per-object media authz: record the CAS digest this message references so the /uploads/cas/*
        // gate can authorize readers against thread membership (one indexed row). One message carries
        // one media (MediaMessage is 1:1). PURE_TEXT/
        // INVITE reference no media.
        if (
          type === ContentType.IMAGE ||
          type === ContentType.FILE ||
          type === ContentType.VIDEO ||
          type === ContentType.AUDIO ||
          type === ContentType.LINK ||
          type === ContentType.CONTACT_CARD ||
          type === ContentType.GALLERY
        ) {
          const digests = extractDigests(storedContent);
          if (digests.length) {
            await tx.insert(messageAsset).values(
              digests.map((digest) => ({
                messageId: msg.id,
                threadId,
                digest,
              })),
            );
          }
        }
        // Strip the internal BigInt id — a throughput side-channel that must never be serialized.
        // (msg.id is consumed above for the MediaMessage FK; the strip is the LAST use of the full row.)
        return stripMessageId(msg);
      });
    } catch (e) {
      // seq allocation cannot P2002 (the row lock serializes it), so the only unique-violation path is a
      // concurrent RETRY of the same send (same clientMessageId): another request inserted it first.
      // Return theirs rather than surfacing the error. (The interactive tx is poisoned, so the re-fetch
      // runs on the root client.)
      if (isUniqueViolation(e) && clientMessageId !== undefined) {
        const winner = await this.findByClientMessageId(clientMessageId);
        if (winner !== null) return winner;
      }
      throw e;
    }
  }

  /** Local server notification; content identifies event participants independently of its sender. */
  async writeSystemMessageInTx(
    tx: DatabaseTransaction,
    threadId: number,
    event: SystemMessageInput,
    options?: { threadLock?: ThreadContentLock },
  ): Promise<{ message: PublicMessage; messageId: bigint }> {
    const threadLock = await requireThreadContentLockInTx(
      tx,
      threadId,
      options?.threadLock,
    );
    const content = stringifySystemMessageContent(
      await resolveSystemMessageInTx(tx, event),
    );
    const [{ curSeq: seq, deletionSeqAllocatedThrough }] = await tx
      .update(messageThread)
      .set({ curSeq: sql`${messageThread.curSeq} + 1` })
      .where(eq(messageThread.id, threadId))
      .returning({
        curSeq: messageThread.curSeq,
        deletionSeqAllocatedThrough: messageThread.deletionSeqAllocatedThrough,
      });
    const [stored] = await tx
      .insert(message)
      .values({
        content,
        contentType: ContentType.SYSTEM,
        creatorAccount: '$system',
        creatorDomain: 'local',
        threadId,
        seq,
        updatedAt: new Date(),
      })
      .returning();
    await tx
      .update(messageThread)
      .set({
        updatedAt: new Date(),
      })
      .where(eq(messageThread.id, threadId));
    // System rows share the regular account preview window.
    // Admission remains atomic with the relationship mutation and its boundaries.
    await enqueueThreadFanoutInTx(tx, threadLock, {
      threadId,
      messageEndSeq: seq,
      tombstoneEndSeq: deletionSeqAllocatedThrough,
    });
    if (
      event.type === SystemMessageType.FRIEND_REMOVED ||
      event.type === SystemMessageType.GROUP_LEFT
    ) {
      await enqueueDepartureFanoutsInTx(
        tx,
        threadLock,
        {
          threadId,
          messageEndSeq: seq,
          tombstoneEndSeq: deletionSeqAllocatedThrough,
        },
        event.type === SystemMessageType.FRIEND_REMOVED ? 'P2P' : 'GROUP',
        event.type === SystemMessageType.GROUP_LEFT ? event.member : undefined,
      );
    }
    return { message: stripMessageId(stored), messageId: stored.id };
  }

  async writeSystemMessage(
    threadId: number,
    event: SystemMessageInput,
  ): Promise<PublicMessage> {
    const result = await this.database.db.transaction((tx) =>
      this.writeSystemMessageInTx(tx, threadId, event),
    );
    return result.message;
  }

  /** Best-effort decoration after the authoritative state transaction has committed. */
  async tryWriteSystemMessage(
    threadId: number,
    event: SystemMessageInput,
  ): Promise<PublicMessage | null> {
    try {
      return await this.writeSystemMessage(threadId, event);
    } catch (error) {
      this.logger.error(
        `failed to write local system message ${event.type} for thread ${threadId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return null;
    }
  }

  /**
   * Stage a LOCAL media send BEFORE any file is uploaded (Phase 7): create a PendingMedia(pending) row
   * carrying the message-level contentType + the batch's `fileCnt` (1 for single-file types, N for
   * GALLERY). No Message, no seq, no fan-out — the message is invisible until the barrier promote
   * ({@link promoteOutboundBatchIfReady}) runs after every file in the batch has landed. Per-file
   * display metadata (w/h, duration) is NOT staged here — it rides with each upload part.
   *
   * Creating the staging row FIRST (before any file write) is the orphan-safety guarantee: a crash
   * between staging and upload always leaves an attributable record, never the unattributed orphan the
   * old upload-then-send order produced (a file on disk with no idea who it was for). The CAS url is
   * NOT stored here — it is injected at promote from the server's own saveCas digest, so the real
   * Message.content URL is never client-supplied.
   *
   * Quota is charged per uploaded FILE (at upload time, by detected family), NOT here — staging is
   * free, so a stage that never uploads consumes no daily count. Idempotent by clientMessageId: a
   * retried send-media resumes the same stage (a retry must not reset an in-flight stage). If
   * clientMessageId already committed a Message, the send already completed → return as-is.
   */
  async stageMedia(
    userId: number,
    threadId: number,
    contentType: ContentType,
    clientMessageId: string,
    fileCnt = 1,
    retry = false,
  ): Promise<{ clientMessageId: string }> {
    const author = await this.localAuthor(userId);
    const committed = await this.database.db.query.message.findFirst({
      where: eq(message.clientMessageId, clientMessageId),
      columns: {
        creatorAccount: true,
        creatorDomain: true,
        creatorNamespaceId: true,
        sourceNamespaceId: true,
      },
    });
    if (committed) {
      if (
        committed.creatorAccount !== author.account ||
        committed.creatorDomain !== author.domain ||
        authorNamespaceId(committed) !== author.namespaceId
      ) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'invalid clientMessageId',
        );
      }
      return { clientMessageId }; // already promoted — nothing to stage
    }
    const existingRow = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.clientMessageId, clientMessageId),
    });
    const existing = existingRow
      ? requireOutboundPendingMedia(existingRow)
      : undefined;
    if (!existing) {
      try {
        await this.database.db.transaction(async (tx) => {
          await tx.insert(pendingMedia).values({
            threadId,
            creatorAccount: author.account,
            creatorDomain: author.domain,
            namespaceId: author.namespaceId,
            contentType,
            content: '{}',
            clientMessageId,
            fileCnt,
            updatedAt: new Date(),
          });
        });
        return { clientMessageId };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const winnerRow = await this.database.db.query.pendingMedia.findFirst({
          where: eq(pendingMedia.clientMessageId, clientMessageId),
        });
        const winner = winnerRow
          ? requireOutboundPendingMedia(winnerRow)
          : undefined;
        if (
          !winner ||
          winner.creatorAccount !== author.account ||
          winner.creatorDomain !== author.domain ||
          winner.namespaceId !== author.namespaceId ||
          winner.threadId !== threadId ||
          winner.contentType !== contentType
        ) {
          throw new BusinessException(
            BusinessCode.VALIDATION_FAILED,
            'invalid clientMessageId',
          );
        }
        return { clientMessageId };
      }
    }
    if (
      existing.creatorAccount !== author.account ||
      existing.creatorDomain !== author.domain ||
      existing.namespaceId !== author.namespaceId ||
      existing.threadId !== threadId ||
      existing.contentType !== contentType
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid clientMessageId',
      );
    }
    if (retry && existing.status === 'failed') {
      await this.database.db
        .update(pendingMedia)
        .set({
          status: 'pending',
          failReason: null,
          digest: null,
          content: '{}',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pendingMedia.id, existing.id),
            eq(pendingMedia.status, 'failed'),
          ),
        );
    }
    return { clientMessageId };
  }

  /** Persist the terminal outcome of a local upload attempt. Ownership is part of the update predicate:
   *  a guessed clientMessageId can never alter another user's stage. */
  async failStaged(
    userId: number,
    clientMessageId: string,
    reason: string,
  ): Promise<void> {
    const author = await this.localAuthor(userId);
    await this.database.db
      .update(pendingMedia)
      .set({
        status: 'failed',
        failReason: reason.slice(0, 255),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pendingMedia.clientMessageId, clientMessageId),
          eq(pendingMedia.creatorAccount, author.account),
          eq(pendingMedia.creatorDomain, author.domain),
          eq(pendingMedia.namespaceId, author.namespaceId),
          eq(pendingMedia.status, 'pending'),
        ),
      );
  }

  /** Recoverable server-side state for refresh/cross-device reconciliation. */
  async queryMediaStages(userId: number, threadId: number) {
    const author = await this.localAuthor(userId);
    return this.database.db.query.pendingMedia.findMany({
      where: and(
        eq(pendingMedia.threadId, threadId),
        eq(pendingMedia.creatorAccount, author.account),
        eq(pendingMedia.creatorDomain, author.domain),
        eq(pendingMedia.namespaceId, author.namespaceId),
        isNotNull(pendingMedia.clientMessageId),
      ),
      columns: {
        clientMessageId: true,
        contentType: true,
        content: true,
        status: true,
        failReason: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: asc(pendingMedia.createdAt),
    });
  }

  /**
   * Record one uploaded file of an outbound batch as SUCCEEDED (Phase 7 type-agnostic upload, design
   * doc §12.3). Each upload part upserts a FileSyncProgress(OUTBOUND, SUCCEEDED) row keyed by
   * (batchId, digest) carrying the server-authored per-file payload. The barrier promote
   * ({@link promoteOutboundBatchIfReady}) assembles message content from these payloads once `fileCnt`
   * files have landed. This replaces the old single-file linkStagedDigest + promoteStaged pair: a
   * multi-file (GALLERY) batch is N independent upserts whose Nth upload triggers the promote.
   *
   * `overrideContentType` handles the IMAGE→FILE fallback (HEIC/AVIF bytes that cannot inline-render):
   * when set, the stage's contentType is updated before the barrier check so the promote assembles FILE
   * content. Only valid for single-file (N=1) batches, where there is no concurrent race.
   *
   * Returns the promote result (the committed Message + whether THIS call newly committed it, so the
   * caller fires fan-out exactly once), or null while the barrier is not yet met / the stage is gone.
   */
  async markOutboundFileSucceeded(
    clientMessageId: string,
    partId: string,
    position: number,
    digest: string,
    payload: OutboundFilePayload,
    userId: number,
    overrideContentType?: ContentType,
  ): Promise<{
    message: PublicMessage;
    newlyPromoted: boolean;
  } | null> {
    const author = await this.localAuthor(userId);
    const stage = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(pendingMedia.clientMessageId, clientMessageId),
        eq(pendingMedia.creatorAccount, author.account),
        eq(pendingMedia.creatorDomain, author.domain),
        eq(pendingMedia.namespaceId, author.namespaceId),
      ),
      columns: {
        id: true,
        batchId: true,
        status: true,
        contentType: true,
        fileCnt: true,
      },
    });
    // Already promoted (stage gone) or no stage / not pending → nothing to record for this caller.
    if (!stage || stage.status !== 'pending') return null;
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position >= stage.fileCnt
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid upload part position',
      );
    }
    if (
      overrideContentType !== undefined &&
      overrideContentType !== stage.contentType
    ) {
      await this.database.db
        .update(pendingMedia)
        .set({ contentType: overrideContentType, updatedAt: new Date() })
        .where(
          and(
            eq(pendingMedia.id, stage.id),
            eq(pendingMedia.status, 'pending'),
          ),
        );
    }
    await this.database.db
      .insert(fileSyncProgress)
      .values({
        batchId: stage.batchId,
        partId,
        position,
        digest,
        direction: 'OUTBOUND',
        kind: familyToFileSyncKind(payload.family),
        status: 'SUCCEEDED',
        bytesTotal: BigInt(payload.size),
        bytesReceived: BigInt(payload.size),
        namespaceId: author.namespaceId,
        payload: payload as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      // Same digest in the same batch is byte-identical → idempotent re-upload is a no-op.
      .onConflictDoNothing();
    return this.promoteOutboundBatchIfReady(clientMessageId, userId);
  }

  /** The staged message-level contentType for a pending outbound batch (the upload `intent`), or null
   *  when there is no pending stage for this clientMessageId/user. The type-agnostic upload route uses
   *  this to gate family detection (IMAGE→FILE fallback, VIDEO/AUDIO container checks). */
  async getStagedIntent(
    clientMessageId: string,
    userId: number,
  ): Promise<ContentType | null> {
    const author = await this.localAuthor(userId);
    const stage = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(pendingMedia.clientMessageId, clientMessageId),
        eq(pendingMedia.creatorAccount, author.account),
        eq(pendingMedia.creatorDomain, author.domain),
        eq(pendingMedia.namespaceId, author.namespaceId),
      ),
      columns: { contentType: true, status: true },
    });
    if (!stage || stage.status !== 'pending') return null;
    return stage.contentType;
  }

  /**
   * Promote a staged outbound batch to a real Message once every expected file has landed (Phase 7
   * barrier model). Atomically allocates the seq, checks membership, and stores the Message
   * with its messageAsset rows, then deletes the PendingMedia row and the batch's
   * FileSyncProgress rows. Materializing an outbound message does not advance read.
   *
   * Concurrency: the win-guard is `DELETE FROM pendingMedia WHERE id = stage.id AND status = 'pending'
   * RETURNING` inside the transaction — only one of N racing uploads wins (returns a row); losers get
   * 0 rows and return null without touching the Message. Idempotent on retry: if clientMessageId
   * already committed a Message, it is returned with `newlyPromoted: false` (no re-fan-out). Returns
   * null while the barrier is not yet met (fewer than `fileCnt` SUCCEEDED files) or when this caller
   * lost the promote race.
   */
  async promoteOutboundBatchIfReady(
    clientMessageId: string,
    userId?: number,
  ): Promise<{
    message: PublicMessage;
    newlyPromoted: boolean;
  } | null> {
    const committed = await this.findByClientMessageId(clientMessageId);
    if (committed) return { message: committed, newlyPromoted: false };
    const stageRow = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.clientMessageId, clientMessageId),
    });
    const stage = stageRow ? requireOutboundPendingMedia(stageRow) : undefined;
    if (
      !stage ||
      stage.status !== 'pending' ||
      (userId !== undefined &&
        !(await this.localAuthor(userId).then(
          (author) =>
            author.account === stage.creatorAccount &&
            author.domain === stage.creatorDomain &&
            author.namespaceId === stage.namespaceId,
        )))
    ) {
      return null;
    }
    const files = await this.database.db.query.fileSyncProgress.findMany({
      where: eq(fileSyncProgress.batchId, stage.batchId),
      columns: {
        digest: true,
        payload: true,
        status: true,
        partId: true,
        position: true,
      },
    });
    const succeeded = files.filter((f) => f.status === 'SUCCEEDED');
    if (succeeded.length < stage.fileCnt) return null; // barrier not yet met
    if (succeeded.length !== stage.fileCnt) return null;
    const positions = new Set(succeeded.map((file) => file.position));
    if (
      positions.size !== stage.fileCnt ||
      [...positions].some(
        (position) =>
          position === null || position < 0 || position >= stage.fileCnt,
      )
    ) {
      return null;
    }
    const payloads = succeeded
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((f) => f.payload as unknown as OutboundFilePayload);
    const unboundContent = assembleOutboundContent(stage.contentType, payloads);
    let created: PublicMessage | null = null;
    try {
      created = await this.previews.commitMessage(
        stage.threadId,
        async (tx) => {
          // Win-guard: only the caller that deletes the still-pending stage promotes. A concurrent winner
          // already deleted it → RETURNING is empty → this caller returns null (no-op, no double insert).
          const [winner] = await tx
            .delete(pendingMedia)
            .where(
              and(
                eq(pendingMedia.id, stage.id),
                eq(pendingMedia.status, 'pending'),
              ),
            )
            .returning({ id: pendingMedia.id });
          if (!winner) return null;
          const creator = await tx.query.account.findFirst({
            where: and(
              eq(user.account, stage.creatorAccount),
              eq(user.domain, stage.creatorDomain),
              eq(user.namespaceId, stage.namespaceId),
            ),
            columns: { id: true },
          });
          if (!creator)
            throw new Error('local staged message author is missing');
          const creatorUserId = creator.id;
          const [participant] = await tx
            .select({
              type: messageThread.type,
              dissolvedAt: groupStateFields.dissolvedAt,
            })
            .from(accountThreadState)
            .innerJoin(
              messageThread,
              eq(messageThread.id, accountThreadState.threadId),
            )
            .leftJoin(group, eq(group.id, messageThread.id))
            .where(
              and(
                eq(accountThreadState.accountId, creatorUserId),
                eq(accountThreadState.threadId, stage.threadId),
              ),
            )
            .limit(1);
          if (
            !participant ||
            !(await isThreadMutuallyAuthorized(
              tx,
              creatorUserId,
              stage.threadId,
            ))
          ) {
            throw new BusinessException(
              participant?.type === MessageThreadType.P2P
                ? BusinessCode.FRIEND_NOT_FOUND
                : BusinessCode.GROUP_FORBIDDEN,
              'conversation is read-only',
            );
          }
          if (participant.dissolvedAt != null) {
            throw new BusinessException(
              BusinessCode.GROUP_DISSOLVED,
              'group has been dissolved',
            );
          }
          const [{ curSeq: seq }] = await tx
            .update(messageThread)
            .set({ curSeq: sql`${messageThread.curSeq} + 1` })
            .where(eq(messageThread.id, stage.threadId))
            .returning({ curSeq: messageThread.curSeq });
          if (
            !(await isThreadMutuallyAuthorized(
              tx,
              creatorUserId,
              stage.threadId,
            ))
          ) {
            throw new BusinessException(
              participant.type === MessageThreadType.P2P
                ? BusinessCode.FRIEND_NOT_FOUND
                : BusinessCode.GROUP_FORBIDDEN,
              'conversation is read-only',
            );
          }
          const content = contextualizeCasUrls(
            unboundContent,
            stage.threadId,
            seq,
          );
          const [msg] = await tx
            .insert(message)
            .values({
              content,
              contentType: stage.contentType,
              threadId: stage.threadId,
              creatorAccount: stage.creatorAccount,
              creatorDomain: stage.creatorDomain,
              profileRev: sql`(
              SELECT profile."defaultProfileRev" FROM "Account" profile
              WHERE profile.account = ${stage.creatorAccount}
                AND profile.domain = ${stage.creatorDomain}
                AND profile."namespaceId" = ${stage.namespaceId}
              LIMIT 1
            )`,
              clientMessageId,
              seq,
              originSeq: seq,
              updatedAt: new Date(),
            })
            .returning();
          await tx
            .update(messageThread)
            .set({
              updatedAt: new Date(),
            })
            .where(eq(messageThread.id, stage.threadId));
          // Insert EVERY referenced digest (1 for single-file, N for GALLERY) — the old promoteStaged
          // path only inserted the first, which silently dropped authz rows for multi-digest content.
          const digests = extractDigests(content);
          if (digests.length) {
            await tx.insert(messageAsset).values(
              digests.map((digest) => ({
                messageId: msg.id,
                threadId: stage.threadId,
                digest,
              })),
            );
          }
          await tx
            .delete(fileSyncProgress)
            .where(eq(fileSyncProgress.batchId, stage.batchId));
          return stripMessageId(msg);
        },
      );
    } catch (e) {
      // Concurrent retry race (P2002 on clientMessageId) → return the winner rather than surfacing.
      if (isUniqueViolation(e)) {
        const winner = await this.findByClientMessageId(clientMessageId);
        if (winner !== null) return { message: winner, newlyPromoted: false };
      }
      throw e;
    }
    if (created === null) return null; // lost the promote race
    return { message: created, newlyPromoted: true };
  }

  /** Builds one client history page from one PostgreSQL snapshot. Message presentation enrichment
   * happens after the snapshot, but cannot change the selected message coordinates or gap facts. */
  async queryClientMessagePage(userId: number, query: ClientMessagePageQuery) {
    const page = await this.database.db.transaction(
      async (tx) => {
        const [scope] = await tx
          .select({
            clearedSeq: messageThread.clearedSeq,
            visibleThroughSeq: accountThreadState.messageVisibleThroughSeq,
            currentEnd: messageThread.curSeq,
          })
          .from(accountThreadState)
          .innerJoin(
            messageThread,
            eq(messageThread.id, accountThreadState.threadId),
          )
          .where(
            and(
              eq(accountThreadState.accountId, userId),
              eq(accountThreadState.threadId, query.threadId),
            ),
          )
          .limit(1);
        if (!scope)
          throw new BusinessException(
            BusinessCode.THREAD_NOT_FOUND,
            `no thread [${query.threadId}]`,
          );

        const lower = scope.clearedSeq ?? 0;
        const upper =
          Math.min(
            scope.currentEnd,
            scope.visibleThroughSeq ?? scope.currentEnd,
          ) + 1;
        const cursorData = { resumeAfter: lower, resumeBefore: upper };
        const { after, before, through } = query;
        if (after === undefined && before === undefined)
          throw new BusinessException(
            BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
            'after or before is required; initialize the message query cursor',
            HttpStatus.OK,
            cursorData,
          );
        if (
          (after !== undefined && (after < lower || after >= upper)) ||
          (before !== undefined && (before <= lower + 1 || before > upper))
        )
          throw new BusinessException(
            BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
            'message query cursor is outside the available coordinate space',
            HttpStatus.OK,
            cursorData,
          );

        const forward = after !== undefined;
        const queryEnd = forward
          ? Math.min(through ?? upper - 1, upper - 1)
          : 0;
        const queryStart = forward
          ? 0
          : Math.max(through ?? lower + 1, lower + 1);

        const rows = await this.queryMessageRows(
          tx,
          query.threadId,
          {
            skip: 1,
            take: query.take + 1,
            orderBy: { seq: forward ? 'asc' : 'desc' },
            cursor: {
              threadId_seq: {
                threadId: query.threadId,
                seq: forward ? after : before!,
              },
            },
            truncateSeq: forward ? queryEnd + 1 : queryStart - 1,
          },
          {
            clearedThroughSeq: scope.clearedSeq,
            visibleThroughSeq: scope.visibleThroughSeq,
          },
        );
        const hasMore = rows.length > query.take;
        const messages = hasMore ? rows.slice(0, query.take) : rows;
        const scannedThrough = hasMore
          ? messages.at(-1)!.seq
          : forward
            ? queryEnd
            : queryStart;
        const scanStart = forward ? after! + 1 : scannedThrough;
        const scanEnd = forward ? scannedThrough : before! - 1;
        const gaps =
          scanStart > scanEnd
            ? []
            : await this.queryClientHistoryGaps(
                tx,
                query.threadId,
                scanStart,
                scanEnd,
                lower + 1,
                upper - 1,
              );

        for (const selected of messages) {
          if (
            gaps.some(
              (gap) =>
                selected.seq >= gap.startSeq && selected.seq <= gap.endSeq,
            )
          )
            throw new Error(
              `message ${query.threadId}:${selected.seq} overlaps a history gap`,
            );
        }
        const deletedSeqs = messages
          .filter((row) => row.isDeleted)
          .map((row) => row.seq);
        const deletionFacts =
          deletedSeqs.length === 0
            ? []
            : await tx.query.deletedMessage.findMany({
                where: and(
                  eq(deletedMessage.threadId, query.threadId),
                  inArray(deletedMessage.messageSeq, deletedSeqs),
                ),
                columns: { messageSeq: true, type: true },
              });
        const types = new Map(
          deletionFacts.map((fact) => [fact.messageSeq, fact.type]),
        );
        const tombs = new Map<number, ClientMessageTomb>();
        for (const row of messages) {
          if (!row.isDeleted) continue;
          const deletionType = types.get(row.seq);
          if (!deletionType)
            throw new Error(
              `Deleted message ${query.threadId}:${row.seq} has no deletion fact`,
            );
          tombs.set(row.seq, {
            threadId: row.threadId,
            seq: row.seq,
            profileRev: row.profileRev,
            creator: stripMessageId(row).creator,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            contentType: 'TOMB',
            isDeleted: true,
            deletionType,
          });
        }
        return {
          messages,
          tombs,
          gaps,
          scannedThrough,
          hasMore,
          filters: {
            clearedThroughSeq: scope.clearedSeq,
            visibleThroughSeq: scope.visibleThroughSeq,
          },
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const live = await this.attachMediaStatus(
      await this.attachQuotePreviews(
        page.messages.filter((row) => !row.isDeleted),
        page.filters,
      ),
    );
    const bySeq = new Map(live.map((row) => [row.seq, row]));
    const messages = page.messages.map((row) =>
      row.isDeleted ? page.tombs.get(row.seq)! : bySeq.get(row.seq)!,
    );
    return {
      messages,
      gaps: page.gaps,
      scannedThrough: page.scannedThrough,
      hasMore: page.hasMore,
    };
  }

  private async queryMessageRows(
    db: Database | DatabaseTransaction,
    threadId: number,
    params: MessageQueryParams,
    filters?: {
      clearedThroughSeq?: number | null;
      visibleThroughSeq?: number | null;
    },
  ) {
    // The viewer's per-thread filters, layered on top of the membership-resolved threadId. The
    // thread-wide clearedThroughSeq is validated before this query and is retained only for quote
    // preview filtering; it is deliberately not repeated as a SQL row predicate here.
    const conditions: SQL[] = [eq(message.threadId, threadId)];
    if (
      filters?.visibleThroughSeq !== null &&
      filters?.visibleThroughSeq !== undefined
    )
      conditions.push(lte(message.seq, filters.visibleThroughSeq));
    const cursorSeq = params.cursor?.threadId_seq.seq;
    if (cursorSeq !== undefined) {
      conditions.push(
        params.orderBy?.seq === 'asc'
          ? params.skip === 0
            ? gte(message.seq, cursorSeq)
            : gt(message.seq, cursorSeq)
          : params.skip === 0
            ? lte(message.seq, cursorSeq)
            : lt(message.seq, cursorSeq),
      );
    }
    if (params.truncateSeq !== undefined) {
      conditions.push(
        params.orderBy?.seq === 'asc'
          ? lt(message.seq, params.truncateSeq)
          : gt(message.seq, params.truncateSeq),
      );
    }
    // id is fetched here (not omitted) so attachMediaStatus can resolve MediaMessage authz by messageId;
    // attachMediaStatus strips id before returning (id is the internal global throughput side-channel
    // and must never reach a client).
    return db.query.message.findMany({
      where: and(...conditions),
      orderBy:
        params.orderBy?.seq === 'asc'
          ? asc(message.seq)
          : sql`${message.seq} DESC`,
      limit: params.take,
      offset: cursorSeq === undefined ? params.skip : 0,
    });
  }

  private async queryClientHistoryGaps(
    tx: DatabaseTransaction,
    threadId: number,
    scanStart: number,
    scanEnd: number,
    visibleStart: number,
    visibleEnd: number,
  ): Promise<ClientMessageHistoryGap[]> {
    const rows = await tx
      .select({
        startSeq: federationThreadHistoryGap.startSeq,
        endSeq: federationThreadHistoryGap.endSeq,
        messageSeqOffset: federationThreadHistoryGap.messageSeqOffset,
        recoverable: federationThreadHistoryGap.recoverable,
      })
      .from(federationThreadHistoryGap)
      .where(eq(federationThreadHistoryGap.threadId, threadId));
    const gaps = rows
      .map((row) => ({
        startSeq: Math.max(row.startSeq + row.messageSeqOffset, visibleStart),
        endSeq: Math.min(row.endSeq + row.messageSeqOffset, visibleEnd),
        recoverable: row.recoverable,
      }))
      .filter(
        (gap) =>
          gap.startSeq <= gap.endSeq &&
          gap.startSeq <= scanEnd &&
          gap.endSeq >= scanStart,
      )
      .sort((a, b) => a.startSeq - b.startSeq || a.endSeq - b.endSeq);
    for (let index = 1; index < gaps.length; index++) {
      if (gaps[index]!.startSeq <= gaps[index - 1]!.endSeq)
        throw new Error(`thread ${threadId} has overlapping history gaps`);
    }
    return gaps;
  }

  private deriveReplyText(
    author: string,
    contentType: ContentType,
    content: string,
  ): Pick<ReplyPreview, 'author' | 'body' | 'contentType'> {
    const body = truncateText(derivePreview(contentType, content), 100);
    return {
      author,
      body,
      contentType,
    };
  }

  private async resolveReplyVisual(
    contentType: ContentType,
    rawContent: string,
  ): Promise<
    Pick<
      ReplyPreview,
      'image' | 'imageLabel' | 'imageIdentity' | 'imageSize' | 'imageShape'
    >
  > {
    try {
      const content = JSON.parse(rawContent) as Record<string, unknown>;
      if (
        contentType === ContentType.IMAGE &&
        typeof content['url'] === 'string'
      )
        return {
          image: content['url'],
          imageSize:
            typeof content['size'] === 'number' ? content['size'] : undefined,
          imageShape: 'thumbnail',
        };
      if (contentType === ContentType.LINK) {
        const link = JSON.parse(rawContent) as Record<string, unknown>;
        return typeof link['image'] === 'string'
          ? { image: link['image'], imageShape: 'thumbnail' }
          : {};
      }
      if (contentType === ContentType.CONTACT_CARD) {
        const card = JSON.parse(rawContent) as Record<string, unknown>;
        return {
          ...(typeof card['avatar'] === 'string'
            ? { image: card['avatar'] }
            : {}),
          ...(typeof card['displayName'] === 'string'
            ? { imageLabel: card['displayName'] }
            : {}),
          ...(typeof card['account'] === 'string'
            ? { imageIdentity: card['account'] }
            : {}),
          imageShape: 'avatar',
        };
      }
      if (contentType === ContentType.GALLERY) {
        // Reply thumbnail = the first item that carries a CAS url (digest-sorted order).
        const items = Array.isArray(content['items'])
          ? (content['items'] as Array<Record<string, unknown>>)
          : [];
        const firstUrl = items
          .map((it) => it['url'])
          .find((u): u is string => typeof u === 'string');
        return firstUrl !== undefined
          ? { image: firstUrl, imageShape: 'thumbnail' }
          : {};
      }
    } catch {
      // Malformed legacy content degrades to a text-only reply summary.
    }
    return {};
  }

  /** Batch-enrich stored `{text, quote:{seq}}` envelopes without persisting a preview. Cross-thread
   * callers may provide viewer visibility independently for each source thread. */
  async attachQuotePreviews<T extends Message>(
    msgs: T[],
    filters?:
      | {
          clearedThroughSeq?: number | null;
          visibleThroughSeq?: number | null;
          hideCreators?: MessageAuthorAddress[];
        }
      | Map<
          number,
          {
            clearedThroughSeq?: number | null;
            visibleThroughSeq?: number | null;
            hideCreators?: MessageAuthorAddress[];
          }
        >,
  ): Promise<T[]> {
    if (
      msgs.some(
        (m) =>
          m.sourceNamespaceId > 0 && parseTextMessageContent(m.content)?.quote,
      )
    ) {
      msgs = await this.database.db.transaction(
        (tx) => resolveStoredQuotes(tx, msgs),
        {
          isolationLevel: 'repeatable read',
          accessMode: 'read only',
        },
      );
    }
    const refs = new Map<number, Set<number>>();
    for (const message of msgs) {
      if (message.contentType !== ContentType.PURE_TEXT) continue;
      const quoteSeq = parseTextMessageContent(message.content)?.quote?.seq;
      if (quoteSeq === undefined) continue;
      const seqs = refs.get(message.threadId) ?? new Set<number>();
      seqs.add(quoteSeq);
      refs.set(message.threadId, seqs);
    }
    if (refs.size === 0) return msgs;

    const targetConditions: SQL[] = [
      or(
        ...[...refs].map(([threadId, seqs]) =>
          and(eq(message.threadId, threadId), inArray(message.seq, [...seqs])),
        ),
      )!,
      eq(message.isDeleted, false),
    ];
    const targets = await this.database.db.query.message.findMany({
      where: and(...targetConditions),
    });
    const authorAddresses = targets.flatMap((target) =>
      target.creatorAccount === null || target.creatorDomain === null
        ? []
        : [
            {
              account: target.creatorAccount,
              domain: target.creatorDomain,
              namespaceId: authorNamespaceId(target),
              profileRev: target.profileRev,
            },
          ],
    );
    const authors =
      authorAddresses.length === 0
        ? []
        : await this.database.db.query.profileTable.findMany({
            where: or(
              ...authorAddresses.map((author) =>
                and(
                  eq(profileTable.account, author.account),
                  eq(profileTable.domain, author.domain),
                  eq(profileTable.namespaceId, author.namespaceId),
                  eq(profileTable.profileRev, author.profileRev),
                ),
              ),
            ),
            columns: {
              account: true,
              domain: true,
              namespaceId: true,
              displayName: true,
              profileRev: true,
            },
          });
    const authorNames = new Map(
      authors.map((author) => [
        JSON.stringify([
          author.account,
          author.domain,
          author.namespaceId,
          author.profileRev,
        ]),
        author.displayName,
      ]),
    );
    const visibleTargets = targets.filter((target) => {
      const viewerFilters =
        filters instanceof Map ? filters.get(target.threadId) : filters;
      return !(
        (viewerFilters?.clearedThroughSeq !== null &&
          viewerFilters?.clearedThroughSeq !== undefined &&
          target.seq <= viewerFilters.clearedThroughSeq) ||
        (viewerFilters?.visibleThroughSeq !== null &&
          viewerFilters?.visibleThroughSeq !== undefined &&
          target.seq > viewerFilters.visibleThroughSeq) ||
        (target.creatorAccount !== null &&
          viewerFilters?.hideCreators?.some(
            (creator) =>
              creator.account === target.creatorAccount &&
              creator.domain === target.creatorDomain &&
              creator.namespaceId === authorNamespaceId(target),
          ))
      );
    });
    const previews = await Promise.all(
      visibleTargets.map(async (target): Promise<[string, ReplyPreview]> => {
        const text = this.deriveReplyText(
          target.creatorAccount === null
            ? 'System'
            : (authorNames.get(
                JSON.stringify([
                  target.creatorAccount,
                  target.creatorDomain,
                  authorNamespaceId(target),
                  target.profileRev,
                ]),
              ) ?? target.creatorAccount),
          target.contentType,
          target.content,
        );
        const visual =
          target.localState === 'STUB'
            ? {}
            : await this.resolveReplyVisual(target.contentType, target.content);
        return [
          `${target.threadId}:${target.seq}`,
          {
            ...text,
            ...visual,
          },
        ];
      }),
    );
    const byKey = new Map(previews);
    return msgs.map((message) => {
      if (message.contentType !== ContentType.PURE_TEXT) return message;
      const content = parseTextMessageContent(message.content);
      if (!content?.quote) return message;
      const preview = byKey.get(`${message.threadId}:${content.quote.seq}`);
      const viewerFilters =
        filters instanceof Map ? filters.get(message.threadId) : filters;
      const outsideVisibility =
        content.quote.seq > 0 &&
        ((viewerFilters?.clearedThroughSeq != null &&
          content.quote.seq <= viewerFilters.clearedThroughSeq) ||
          (viewerFilters?.visibleThroughSeq != null &&
            content.quote.seq > viewerFilters.visibleThroughSeq));
      return {
        ...message,
        content: stringifyTextMessageContent({
          text: content.text,
          quote: {
            seq: content.quote.seq,
            ...(outsideVisibility
              ? { status: 'NOT_FOUND' as const }
              : content.quote.status
                ? { status: content.quote.status }
                : {}),
            ...(preview ?? {}),
          },
        }),
      };
    });
  }

  /** Attach the current four-state media availability to each message by
   *  checking, in bulk, whether every CAS digest in its content has a MediaMessage authz row for THIS
   *  message AND a READY MediaAsset. Non-media messages (no digest)
   *  are trivially 'ready'. Two batch queries serve a whole page — no per-row N+1. Strips the internal
   *  id (it never reaches a client). Drives the query-messages response and the media-status probe. */
  async attachMediaStatus<T extends Message>(
    msgs: T[],
  ): Promise<(PublicMessage<T> & { mediaStatus: MediaStatus })[]> {
    if (msgs.length === 0) return [];
    const byMsg = new Map<bigint, string[]>();
    const allDigests = new Set<string>();
    for (const m of msgs) {
      // Reply previews on PURE_TEXT messages may contain a target thumbnail URL. That target owns
      // the MediaMessage authorization row; it must not make the text reply itself look like a
      // failed media upload.
      const ds =
        m.contentType === ContentType.PURE_TEXT
          ? []
          : extractDigests(m.content);
      byMsg.set(m.id, ds);
      for (const d of ds) allDigests.add(d);
    }
    const ids = msgs.map((m) => m.id);
    const [authRows, assetRows, pendingRows] = await Promise.all([
      this.database.db.query.messageAsset.findMany({
        where: inArray(messageAsset.messageId, ids),
        columns: { messageId: true, digest: true },
      }),
      allDigests.size === 0
        ? Promise.resolve([] as { digest: string; isDeleted: boolean }[])
        : this.database.db.query.mediaAsset.findMany({
            where: inArray(mediaAsset.digest, [...allDigests]),
            columns: { digest: true, isDeleted: true },
          }),
      this.database.db.query.pendingMedia.findMany({
        where: and(
          eq(pendingMedia.direction, 'INBOUND'),
          inArray(pendingMedia.messageId, ids),
        ),
        columns: { messageId: true, status: true },
      }),
    ]);
    // A digest is ready for message m iff an authz row (messageId, digest) exists AND the asset is a
    // live (non-deleted) blob. messageId is BigInt; String(1n) === "1" so the key is collision-free.
    const auth = new Set(authRows.map((r) => `${r.messageId}:${r.digest}`));
    const present = new Set(
      assetRows.filter((a) => !a.isDeleted).map((a) => a.digest),
    );
    const jobs = new Map(
      pendingRows
        .filter((row) => row.messageId !== null)
        .map((row) => [row.messageId!, row.status]),
    );
    return msgs.map((m) => {
      if (m.localState !== 'READY') {
        const jobStatus = jobs.get(m.id);
        return {
          ...stripMessageId(m),
          mediaStatus:
            m.localState === 'FAILED'
              ? MEDIA_STATUS.FAILED
              : jobStatus === 'pending'
                ? MEDIA_STATUS.PENDING
                : jobStatus === 'downloading'
                  ? MEDIA_STATUS.DOWNLOADING
                  : MEDIA_STATUS.FAILED,
        };
      }
      const ds = byMsg.get(m.id) ?? [];
      const ready =
        ds.length === 0 ||
        ds.every((d) => auth.has(`${m.id}:${d}`) && present.has(d));
      return {
        ...stripMessageId(m),
        mediaStatus: ready ? MEDIA_STATUS.READY : MEDIA_STATUS.FAILED,
      };
    });
  }

  /** Bulk media-status snapshot for mounted messages in one thread. Returns {seq, status} per
   *  requested seq that exists; missing seqs
   *  are omitted (the client keeps its last known state). Reuses attachMediaStatus for the digest check;
   *  never exposes content/id. */
  async queryMediaStatus(
    threadId: number,
    seqs: number[],
  ): Promise<Array<{ seq: number; status: MediaStatus }>> {
    if (seqs.length === 0) return [];
    const msgs = await this.database.db.query.message.findMany({
      where: and(
        eq(message.threadId, threadId),
        inArray(message.seq, seqs),
        eq(message.isDeleted, false),
      ),
    });
    const attached = await this.attachMediaStatus(msgs);
    return attached.map((m) => ({
      seq: m.seq,
      status: m.mediaStatus,
    }));
  }

  /**
   * Substring search over a conversation's text and uploaded-media filenames. Returns lightweight
   * {seq, createdAt} matches (no full bodies) — the client jumps the kernel to each seq and the server
   * renders the bubble via the normal query-messages path on demand. Keyset-paginated by message seq
   * (descending): the client's lastSeq cursor asks for the next older page. Only the text envelope and
   * uploaded-media `name` field are searched, so author names and quote previews never create false hits.
   */
  async searchMessages(
    threadId: number,
    keyword: string,
    take: number,
    lastSeq?: number,
    clearedSeq?: number | null,
  ) {
    if (
      clearedSeq !== null &&
      clearedSeq !== undefined &&
      lastSeq !== undefined &&
      lastSeq <= clearedSeq + 1
    )
      return [];
    const cursor =
      lastSeq === undefined ? sql.empty() : sql`AND seq < ${lastSeq}`;
    const rows = await this.queryRaw<Array<{ seq: number; createdAt: string }>>`
      SELECT seq, "createdAt"
      FROM "Message"
      WHERE "threadId" = ${threadId}
        AND "isDeleted" = false
        AND "localState" = 'READY'
        ${cursor}
        AND (
          (
            "contentType" = 'PURE_TEXT'
            AND (content::jsonb ->> 'text') ILIKE ${`%${keyword}%`}
          )
          OR (
            "contentType" IN ('IMAGE', 'FILE', 'VIDEO', 'AUDIO')
            AND (content::jsonb ->> 'name') ILIKE ${`%${keyword}%`}
          )
          OR (
            "contentType" = 'GALLERY'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(content::jsonb -> 'items') AS item
              WHERE (item ->> 'name') ILIKE ${`%${keyword}%`}
            )
          )
        )
      ORDER BY seq DESC
      LIMIT ${take + 1}
    `;
    return rows
      .filter(
        (row) =>
          clearedSeq === null ||
          clearedSeq === undefined ||
          row.seq > clearedSeq,
      )
      .map((row) => ({
        ...row,
        createdAt: rawDate(row.createdAt, 'Message.createdAt'),
      }));
  }

  /** Single message lookup by per-thread (threadId, seq) identity — seq is unique only within a thread,
   *  so both parts of the compound unique are required. Tombstones remain valid read cursors: deletion
   *  removes a body from the visible log, not its position in the thread's monotonic seq space. */
  findMessageBySeq(threadId: number, seq: number) {
    return this.database.db.query.message
      .findFirst({
        where: and(eq(message.threadId, threadId), eq(message.seq, seq)),
      })
      .then((row) => (row ? stripMessageId(row) : null));
  }

  /** Single thread lookup (used by mark-read to resolve "mark all current messages read"). */
  findThread(id: number) {
    return this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, id),
    });
  }
}

function truncateText(value: string, max: number): string {
  return [
    ...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(value),
  ]
    .slice(0, max)
    .map((part) => part.segment)
    .join('');
}
