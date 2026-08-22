import { Injectable, Logger } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  gte,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  ContentType,
  MessageThreadType,
  ThreadParticipantState,
} from '../database/enums.js';
import {
  forwardMessage,
  mediaAsset,
  messageAsset,
  message,
  messageThread,
  pendingMedia,
  fileSyncProgress,
  threadParticipant,
  user,
} from '../database/schema.js';
import { isUniqueViolation } from '../database/database-error.js';
import {
  assembleOutboundContent,
  extractDigests,
  familyToFileSyncKind,
  type OutboundFilePayload,
} from '../upload/file-content.js';
import { contextualizeCasUrls } from '../upload/cas-url.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import { MEDIA_STATUS } from '../common/media-status.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import {
  parseMessageEntities,
  toDisplayText,
} from '../common/message-entity.js';
import {
  isValidSocfpUserAccount,
  parseSocfpUserAddress,
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
} from './system-message.js';
import { loadFederationConfig } from '../federation/federation.config.js';

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
export interface MessageQueryParams {
  skip?: number;
  take?: number;
  orderBy?: { seq: 'asc' | 'desc' };
  cursor?: { threadId_seq: { threadId: number; seq: number } };
  truncateSeq?: number;
}

export interface ThreadAttentionState {
  count: number;
  mention: UnreadMentionState;
}

export interface CommittedThreadReadState extends ThreadAttentionState {
  lastReadSeq: number;
  readRevision: number;
}

export interface AwayThreadAttentionState extends ThreadAttentionState {
  latestSeq: number;
}

export interface AwayNotificationMessage {
  threadId: number;
  seq: number;
  creator: number;
  senderName: string;
  contentType: ContentType;
  content: string;
  createdAt: Date;
}

/**
 * Drop the internal BigInt `id` from a Message row. `id` is a global autoincrement — a cross-conversation
 * throughput side-channel whose deltas leak server-wide volume — so it must never reach a client or
 * federation payload; only the per-thread `seq` is public. Applied at every response/SSE boundary. (The
 * create path needs `id` for the MediaMessage FK, so the row is created in full and the id stripped only
 * on the way out — hence a post-hoc strip rather than a query-level omit on the create.)
 */
export function stripMessageId<T extends { id: bigint }>(
  msg: T,
): Omit<T, 'id'> {
  const { id, ...rest } = msg;
  return rest;
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
 * Friendship model). This service now deals only with Message rows + the MessageThread last-message
 * denormalization. Membership authorization (is the caller an active ThreadParticipant of this thread?)
 * is handled by ThreadParticipantService in the controllers before write/query is called.
 */
@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly linkPreview: LinkPreviewService,
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

  findByClientMessageId(clientMessageId: string) {
    return this.database.db.query.message
      .findFirst({ where: eq(message.clientMessageId, clientMessageId) })
      .then((row) => (row ? stripMessageId(row) : null));
  }

  /**
   * Append a message AND update the thread's denormalized last-message cache AND advance the sender's
   * own read cursor — all in one transaction, so:
   *  - the conversation list (which reads MessageThread.lastMessage*) can never observe a message
   *    whose preview hasn't been written;
   *  - the sender's own message never counts as unread to themselves (their lastReadSeq jumps to
   *    what they just sent), removing the need for a client post-send mark-read round-trip and keeping
   *    multi-device badge counts correct.
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
   * keeps originSeq/originServerTime null until its self-authored message-feed receipt returns; the
   * publisher uses seq as the wire originSeq while the receipt is still absent.
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
      hideCreatorIds?: number[];
    },
  ): Promise<Omit<Message, 'id'>> {
    if (clientMessageId !== undefined) {
      const existing = await this.findByClientMessageId(clientMessageId);
      if (existing !== null) return existing; // retry → return the original message (already dispatched)
    }
    try {
      return await this.database.db.transaction(async (tx) => {
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
            state: threadParticipant.state,
          })
          .from(messageThread)
          .innerJoin(
            threadParticipant,
            and(
              eq(threadParticipant.threadId, messageThread.id),
              eq(threadParticipant.userId, userId),
            ),
          )
          .where(eq(messageThread.id, threadId))
          .limit(1);
        if (
          !writeAccess ||
          writeAccess.state !== ThreadParticipantState.ESTABLISHED
        ) {
          throw new BusinessException(
            writeAccess?.type === MessageThreadType.GROUP
              ? BusinessCode.GROUP_FORBIDDEN
              : BusinessCode.FRIEND_NOT_FOUND,
            'conversation is read-only',
          );
        }
        // originSeq remains null until a remote publisher returns this self-authored item as a receipt.
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
                !isValidSocfpUserAccount(localAccount)) &&
              !parseSocfpUserAddress(segment.entityId)
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
          quoteSeq === undefined
            ? null
            : await tx.query.message
                .findFirst({
                  where: and(
                    eq(message.threadId, threadId),
                    eq(message.seq, quoteSeq),
                  ),
                  with: { user: { columns: { name: true } } },
                })
                .then((row) =>
                  row ? { ...row, creatorItem: row.user } : null,
                );
        if (quoteSeq !== undefined && !quoteTarget) {
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
            quoteVisibility?.hideCreatorIds?.includes(quoteTarget.creator))
        ) {
          throw new BusinessException(
            BusinessCode.NOT_FOUND,
            'quoted message not found',
          );
        }
        let storedContent =
          textContent && quoteTarget
            ? stringifyTextMessageContent({
                text: textContent.text,
                quote: { seq: quoteTarget.seq },
              })
            : content;
        storedContent = contextualizeCasUrls(storedContent, threadId, seq);
        const [msg] = await tx
          .insert(message)
          .values({
            content: storedContent,
            contentType: type,
            threadId,
            creator: userId,
            clientMessageId,
            seq,
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
            lastMessageSeq: seq,
            lastMessagePreview: derivePreview(type, storedContent),
            lastMessageAt: msg.createdAt,
            updatedAt: new Date(),
          })
          .where(eq(messageThread.id, threadId));
        // Sender has implicitly "read" what they just sent; seq is freshly allocated so it is always
        // strictly greater than the prior watermark — a forward move, never a regression.
        await tx
          .update(threadParticipant)
          .set({ lastReadSeq: seq, updatedAt: new Date() })
          .where(
            and(
              eq(threadParticipant.userId, userId),
              eq(threadParticipant.threadId, threadId),
            ),
          );
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

  /** Server-only structured timeline notice. It is persisted for this server's clients only and is
   * never allocated to the federation message feed. Relationship/roster state remains authoritative. */
  async writeSystemMessageInTx(
    tx: DatabaseTransaction,
    actorUserId: number,
    threadId: number,
    type: SystemMessageType,
    subjectUserId?: number,
  ): Promise<{ message: Omit<Message, 'id'>; messageId: bigint }> {
    if (type !== SystemMessageType.FRIEND_ADDED && subjectUserId === undefined)
      throw new Error('system message subject is required');
    if (type === SystemMessageType.FRIEND_ADDED && subjectUserId !== undefined)
      throw new Error('FRIEND_ADDED does not accept a subject');
    const subject =
      subjectUserId === undefined
        ? undefined
        : await tx.query.user.findFirst({
            where: eq(user.id, subjectUserId),
            columns: { account: true, domain: true },
          });
    if (subjectUserId !== undefined && !subject)
      throw new Error('system message subject does not exist');
    const content = stringifySystemMessageContent({
      type,
      ...(subject
        ? {
            subject: {
              account: subject.account,
              domain:
                subject.domain === 'local'
                  ? loadFederationConfig().domain
                  : subject.domain,
            },
          }
        : {}),
    });
    const [{ curSeq: seq }] = await tx
      .update(messageThread)
      .set({ curSeq: sql`${messageThread.curSeq} + 1` })
      .where(eq(messageThread.id, threadId))
      .returning({ curSeq: messageThread.curSeq });
    const [stored] = await tx
      .insert(message)
      .values({
        content,
        contentType: ContentType.SYSTEM,
        threadId,
        creator: actorUserId,
        seq,
        updatedAt: new Date(),
      })
      .returning();
    await tx
      .update(messageThread)
      .set({
        lastMessageSeq: seq,
        lastMessagePreview: derivePreview(ContentType.SYSTEM, content),
        lastMessageAt: stored.createdAt,
        updatedAt: new Date(),
      })
      .where(eq(messageThread.id, threadId));
    await tx
      .update(threadParticipant)
      .set({ lastReadSeq: seq, updatedAt: new Date() })
      .where(
        and(
          eq(threadParticipant.userId, actorUserId),
          eq(threadParticipant.threadId, threadId),
        ),
      );
    return { message: stripMessageId(stored), messageId: stored.id };
  }

  async writeSystemMessage(
    actorUserId: number,
    threadId: number,
    type: SystemMessageType,
    subjectUserId?: number,
  ): Promise<Omit<Message, 'id'>> {
    const result = await this.database.db.transaction((tx) =>
      this.writeSystemMessageInTx(
        tx,
        actorUserId,
        threadId,
        type,
        subjectUserId,
      ),
    );
    return result.message;
  }

  /** Best-effort local timeline decoration. State/meta callers invoke this only after their authoritative
   * transaction commits; a bad payload, missing subject or storage failure must never roll state back. */
  async tryWriteSystemMessage(
    actorUserId: number,
    threadId: number,
    type: SystemMessageType,
    subjectUserId?: number,
  ): Promise<Omit<Message, 'id'> | null> {
    try {
      return await this.writeSystemMessage(
        actorUserId,
        threadId,
        type,
        subjectUserId,
      );
    } catch (error) {
      this.logger.error(
        `failed to write local system message ${type} for thread ${threadId}: ${(error as Error).message}`,
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
    const committed = await this.database.db.query.message.findFirst({
      where: eq(message.clientMessageId, clientMessageId),
      columns: { creator: true },
    });
    if (committed) {
      if (committed.creator !== userId) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'invalid clientMessageId',
        );
      }
      return { clientMessageId }; // already promoted — nothing to stage
    }
    const existing = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.clientMessageId, clientMessageId),
    });
    if (!existing) {
      try {
        await this.database.db.transaction(async (tx) => {
          await tx.insert(pendingMedia).values({
            threadId,
            creatorId: userId,
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
        const winner = await this.database.db.query.pendingMedia.findFirst({
          where: eq(pendingMedia.clientMessageId, clientMessageId),
        });
        if (
          !winner ||
          winner.creatorId !== userId ||
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
      existing.creatorId !== userId ||
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
          eq(pendingMedia.creatorId, userId),
          eq(pendingMedia.status, 'pending'),
        ),
      );
  }

  /** Recoverable server-side state for refresh/cross-device reconciliation. */
  async queryMediaStages(userId: number, threadId: number) {
    return this.database.db.query.pendingMedia.findMany({
      where: and(
        eq(pendingMedia.threadId, threadId),
        eq(pendingMedia.creatorId, userId),
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
    message: Omit<Message, 'id'>;
    newlyPromoted: boolean;
  } | null> {
    const stage = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(pendingMedia.clientMessageId, clientMessageId),
        eq(pendingMedia.creatorId, userId),
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
    const stage = await this.database.db.query.pendingMedia.findFirst({
      where: and(
        eq(pendingMedia.clientMessageId, clientMessageId),
        eq(pendingMedia.creatorId, userId),
      ),
      columns: { contentType: true, status: true },
    });
    if (!stage || stage.status !== 'pending') return null;
    return stage.contentType;
  }

  /**
   * Promote a staged outbound batch to a real Message once every expected file has landed (Phase 7
   * barrier model). Runs the SAME commit core as promoteStaged/writeMsgToThread (atomic seq
   * allocation, membership check, Message + N messageAsset rows, last-message cache, sender read
   * cursor), then deletes the PendingMedia row and the batch's FileSyncProgress rows.
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
    message: Omit<Message, 'id'>;
    newlyPromoted: boolean;
  } | null> {
    const committed = await this.findByClientMessageId(clientMessageId);
    if (committed) return { message: committed, newlyPromoted: false };
    const stage = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.clientMessageId, clientMessageId),
    });
    if (
      !stage ||
      stage.status !== 'pending' ||
      (userId !== undefined && stage.creatorId !== userId)
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
    let created: Omit<Message, 'id'> | null = null;
    try {
      created = await this.database.db.transaction(async (tx) => {
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
        const participant = await tx.query.threadParticipant.findFirst({
          where: and(
            eq(threadParticipant.userId, stage.creatorId),
            eq(threadParticipant.threadId, stage.threadId),
          ),
          with: {
            messageThread: {
              columns: { type: true },
              with: {
                user: {
                  columns: {},
                  with: { group: { columns: { dissolvedAt: true } } },
                },
              },
            },
          },
        });
        if (
          !participant ||
          participant.state !== ThreadParticipantState.ESTABLISHED
        ) {
          throw new BusinessException(
            participant?.messageThread.type === MessageThreadType.P2P
              ? BusinessCode.FRIEND_NOT_FOUND
              : BusinessCode.GROUP_FORBIDDEN,
            'conversation is read-only',
          );
        }
        if (participant.messageThread.user?.group?.dissolvedAt != null) {
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
        const activeAfterThreadLock =
          await tx.query.threadParticipant.findFirst({
            where: and(
              eq(threadParticipant.userId, stage.creatorId),
              eq(threadParticipant.threadId, stage.threadId),
              eq(threadParticipant.state, ThreadParticipantState.ESTABLISHED),
            ),
            columns: { id: true },
          });
        if (!activeAfterThreadLock) {
          throw new BusinessException(
            participant.messageThread.type === MessageThreadType.P2P
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
            creator: stage.creatorId,
            clientMessageId,
            seq,
            updatedAt: new Date(),
          })
          .returning();
        await tx
          .update(messageThread)
          .set({
            lastMessageSeq: seq,
            lastMessagePreview: derivePreview(stage.contentType, content),
            lastMessageAt: msg.createdAt,
            updatedAt: new Date(),
          })
          .where(eq(messageThread.id, stage.threadId));
        await tx
          .update(threadParticipant)
          .set({ lastReadSeq: seq, updatedAt: new Date() })
          .where(
            and(
              eq(threadParticipant.userId, stage.creatorId),
              eq(threadParticipant.threadId, stage.threadId),
            ),
          );
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
      });
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

  async queryMessages(
    threadId: number,
    params: MessageQueryParams,
    filters?: { clearedThroughSeq?: number | null; hideCreatorIds?: number[] },
  ) {
    // The viewer's per-thread filters, layered on top of the membership-resolved threadId:
    //  - clearedThroughSeq: per-user "clear history" watermark — hide rows through it for THIS user only.
    //  - hideCreatorIds: P2P block — the blocker never sees a blocked creator's messages. Scoped to P2P
    //    by the controller (group threads leave blocked members visible).
    const conditions: SQL[] = [
      eq(message.threadId, threadId),
      eq(message.isDeleted, false),
    ];
    if (
      filters?.clearedThroughSeq !== null &&
      filters?.clearedThroughSeq !== undefined
    )
      conditions.push(gt(message.seq, filters.clearedThroughSeq));
    if (filters?.hideCreatorIds?.length)
      conditions.push(notInArray(message.creator, filters.hideCreatorIds));
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
    const rows = await this.database.db.query.message.findMany({
      where: and(...conditions),
      orderBy:
        params.orderBy?.seq === 'asc'
          ? asc(message.seq)
          : sql`${message.seq} DESC`,
      limit: params.take,
      offset: cursorSeq === undefined ? params.skip : 0,
    });
    return this.attachMediaStatus(
      await this.attachQuotePreviews(rows, filters),
    );
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
      | { clearedThroughSeq?: number | null; hideCreatorIds?: number[] }
      | Map<
          number,
          { clearedThroughSeq?: number | null; hideCreatorIds?: number[] }
        >,
  ): Promise<T[]> {
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
      with: { user: { columns: { name: true } } },
    });
    const visibleTargets = targets.filter((target) => {
      const viewerFilters =
        filters instanceof Map ? filters.get(target.threadId) : filters;
      return !(
        (viewerFilters?.clearedThroughSeq !== null &&
          viewerFilters?.clearedThroughSeq !== undefined &&
          target.seq <= viewerFilters.clearedThroughSeq) ||
        viewerFilters?.hideCreatorIds?.includes(target.creator)
      );
    });
    const previews = await Promise.all(
      visibleTargets.map(async (target): Promise<[string, ReplyPreview]> => {
        const text = this.deriveReplyText(
          target.user.name,
          target.contentType,
          target.content,
        );
        const visual = await this.resolveReplyVisual(
          target.contentType,
          target.content,
        );
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
      return {
        ...message,
        content: stringifyTextMessageContent({
          text: content.text,
          quote: {
            seq: content.quote.seq,
            ...(preview ?? {}),
          },
        }),
      };
    });
  }

  /** Attach a `mediaStatus` ('ready' | 'failed') + `sv` (status version = seq) to each message by
   *  checking, in bulk, whether every CAS digest in its content has a MediaMessage authz row for THIS
   *  message AND a READY MediaAsset. Non-media messages (no digest)
   *  are trivially 'ready'. Two batch queries serve a whole page — no per-row N+1. Strips the internal
   *  id (it never reaches a client). Drives the query-messages response and the media-status probe. */
  async attachMediaStatus<T extends Message>(
    msgs: T[],
  ): Promise<
    (Omit<T, 'id'> & { mediaStatus: 'ready' | 'failed'; sv: number })[]
  > {
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
    const [authRows, assetRows] = await Promise.all([
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
    ]);
    // A digest is ready for message m iff an authz row (messageId, digest) exists AND the asset is a
    // live (non-deleted) blob. messageId is BigInt; String(1n) === "1" so the key is collision-free.
    const auth = new Set(authRows.map((r) => `${r.messageId}:${r.digest}`));
    const present = new Set(
      assetRows.filter((a) => !a.isDeleted).map((a) => a.digest),
    );
    return msgs.map((m) => {
      const { id: _drop, ...rest } = m;
      const ds = byMsg.get(m.id) ?? [];
      const ready =
        ds.length === 0 ||
        ds.every((d) => auth.has(`${m.id}:${d}`) && present.has(d));
      return {
        ...rest,
        mediaStatus: ready ? MEDIA_STATUS.READY : MEDIA_STATUS.FAILED,
        sv: m.seq,
      };
    });
  }

  /** Bulk media-status probe for a set of seqs within one thread (the client's scroll backstop for
   *  missed MEDIA_STATUS frames). Returns {seq, status, sv} per requested seq that exists; missing seqs
   *  are omitted (the client keeps its last known state). Reuses attachMediaStatus for the digest check;
   *  never exposes content/id. */
  async queryMediaStatus(
    threadId: number,
    seqs: number[],
  ): Promise<Array<{ seq: number; status: 'ready' | 'failed'; sv: number }>> {
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
      sv: m.sv,
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
  ) {
    const cursor =
      lastSeq === undefined ? sql.empty() : sql`AND seq < ${lastSeq}`;
    return this.queryRaw<Array<{ seq: number; createdAt: Date }>>`
      SELECT seq, "createdAt"
      FROM "Message"
      WHERE "threadId" = ${threadId}
        AND "isDeleted" = false
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

  /** Resolve public per-thread identities to their durable Message rows, including tombstones. Used only
   *  for cursor ordering; callers that render message bodies must use findMessagesBySeqPairs instead. */
  async findMessageIdentitiesBySeqPairs(
    pairs: Array<{ threadId: number; seq: number }>,
  ): Promise<Message[]> {
    if (pairs.length === 0) return [];
    return this.database.db.query.message.findMany({
      where: or(
        ...pairs.map((pair) =>
          and(eq(message.threadId, pair.threadId), eq(message.seq, pair.seq)),
        ),
      ),
    });
  }

  /** Batched lookup of messages by their per-thread (threadId, seq) identity — the missed summary fetches
   *  each thread's newest message body in ONE query (seq = thread.lastMessageSeq). Returns FULL Message
   *  rows (BigInt id intact) so the caller can funnel them through {@link attachMediaStatus}, which strips
   *  id before it reaches a client. Empty input → empty output (no empty-OR SQL). The composite
   *  `@@unique([threadId, seq])` index backs every branch. */
  async findMessagesBySeqPairs(
    pairs: Array<{ threadId: number; seq: number }>,
  ): Promise<Message[]> {
    if (pairs.length === 0) return [];
    return this.database.db.query.message.findMany({
      where: and(
        eq(message.isDeleted, false),
        or(
          ...pairs.map((pair) =>
            and(eq(message.threadId, pair.threadId), eq(message.seq, pair.seq)),
          ),
        ),
      ),
    });
  }

  /** Single thread lookup (used by mark-read to resolve "mark all current messages read"). */
  findThread(id: number) {
    return this.database.db.query.messageThread.findFirst({
      where: eq(messageThread.id, id),
    });
  }

  /**
   * Cross-thread message catch-up for the repurposed POST /notifications/missed — backs the app-open /
   * reconnect incremental sync (and the init seed). Membership-scoped (an active ThreadParticipant row
   * for the user) and blocked-creator-hidden, mirroring the per-viewer rules in {@link queryMessages}.
   * Returns FULL Message rows (BigInt `id` intact) — the caller funnels them through
   * {@link attachMediaStatus}, which strips `id` before it can reach a client.
   *
   * Two modes (selected by `init`):
   *  - init (no high-water-mark yet): the NEWEST message per thread (`DISTINCT ON (threadId)`), so every
   *    conversation gets a latest-message preview seed in one query. Bounded by `take` (one row per
   *    thread; threads past the cap get no seed — their preview arrives on the next live/catch-up event).
   *  - catch-up (since a high-water-mark): every message with `(createdAt, id) > (sinceMs, sinceId)`,
   *    ordered `createdAt ASC, id ASC` (the time-ascending contract the client applies in arrival order).
   *    The composite `(createdAt, id)` bound makes pagination strictly monotonic — no same-ms skip and no
   *    re-fetch loop — without ever exposing the internal `id` (it travels only inside the opaque cursor).
   *
   * Served by the `Message(createdAt)` index (migration 20260715130000) for the global time range scan;
   * the ThreadParticipant join scopes it to the user's active conversations.
   */
  async missedMessages(
    userId: number,
    opts: {
      init: boolean;
      sinceMs?: number | null;
      sinceId?: bigint;
      take: number;
      hideCreatorIds?: number[];
    },
  ): Promise<Message[]> {
    const blocked = opts.hideCreatorIds ?? [];
    const blockedClause = blocked.length
      ? sql`AND m."creator" NOT IN (${this.joinSql(blocked)})`
      : sql.empty();

    if (opts.init) {
      // Newest message per active thread. DISTINCT ON picks the first row per threadId under the given
      // ORDER BY, so `ORDER BY threadId, seq DESC` yields each thread's highest-seq (latest) message.
      const where = blocked.length
        ? sql`WHERE m."creator" NOT IN (${this.joinSql(blocked)})`
        : sql.empty();
      return this.queryRaw<Message[]>`
        SELECT DISTINCT ON (m."threadId") m.*
        FROM "Message" m
        JOIN "ThreadParticipant" tp
          ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp.state <> 'AUTHORIZED'
        ${where}
        ORDER BY m."threadId" DESC, m."seq" DESC
        LIMIT ${opts.take}
      `;
    }

    // Catch-up: composite (createdAt, id) > (sinceMs, sinceId). The `OR` same-ms branch advances past
    // rows already seen at the cursor's millisecond, so paging is strictly forward.
    const since = new Date(opts.sinceMs ?? 0);
    const sinceId = opts.sinceId ?? 0n;
    return this.queryRaw<Message[]>`
      SELECT m.*
      FROM "Message" m
      JOIN "ThreadParticipant" tp
        ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp.state <> 'AUTHORIZED'
      WHERE (m."createdAt" > ${since} OR (m."createdAt" = ${since} AND m."id" > ${sinceId}))
        ${blockedClause}
      ORDER BY m."createdAt" ASC, m."id" ASC
      LIMIT ${opts.take + 1}
    `;
  }

  /**
   * Away-notification sender aggregation for POST /notifications/missed — distinct senders + their message
   * counts for messages newer than `sinceId` (membership-scoped), sampling the first `limit` by id. LEAN:
   * selects only `creator` (NO content/body, NO threadId) — the away-summary needs only WHO + how-many, not
   * WHAT nor which threads. Hides blocked creators AND messages in threads the caller has MUTED: mute = don't
   * disturb, so a muted thread never contributes to the away count. The mute check is per-row on the already-
   * joined participant, so a sender who also messages in an UNMUTED thread still contributes those unmuted
   * messages. The caller aggregates the rows in JS (a `limit`-sized batch of one int column is trivial).
   * `overflow=true` when ≥`limit` messages exist → the "999+" capped display (the count covers only the
   * sampled `limit`). Backed by Message(id) for the id range.
   */
  async senderCountsSince(
    userId: number,
    sinceId: bigint,
    limit: number,
    hideCreatorIds: number[] = [],
  ): Promise<{ counts: Map<number, number>; overflow: boolean }> {
    const blockedClause = hideCreatorIds.length
      ? sql`AND m."creator" NOT IN (${this.joinSql(hideCreatorIds)})`
      : sql.empty();
    const rows = await this.queryRaw<Array<{ creator: number }>>`
      SELECT m."creator" AS creator
      FROM "Message" m
      JOIN "ThreadParticipant" tp
        ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp.state <> 'AUTHORIZED'
      WHERE m."id" > ${sinceId} ${blockedClause} AND tp."muted" = false
      ORDER BY m."id" ASC
      LIMIT ${limit}
    `;
    const counts = new Map<number, number>();
    for (const r of rows) {
      counts.set(r.creator, (counts.get(r.creator) ?? 0) + 1);
    }
    return { counts, overflow: rows.length >= limit };
  }

  /**
   * Folded away-notification read model. Sender counts and mention attention are computed from the exact
   * same bounded sample, so the presentation layer never performs a second mention query with a drifting
   * cursor.
   */
  async senderAttentionSince(
    userId: number,
    selfAccount: string,
    sinceId: bigint,
    limit: number,
    hideCreatorIds: number[] = [],
  ): Promise<{
    counts: Map<number, number>;
    mention: UnreadMentionState;
    overflow: boolean;
  }> {
    const hiddenClause = hideCreatorIds.length
      ? sql`AND m."creator" NOT IN (${this.joinSql(hideCreatorIds)})`
      : sql.empty();
    const rows = await this.queryRaw<
      Array<{ creator: number; contentType: string; content: string }>
    >`
      SELECT m.creator, m."contentType" AS "contentType", m.content
      FROM "Message" m
      JOIN "ThreadParticipant" tp
        ON tp."threadId" = m."threadId"
       AND tp."userId" = ${userId}
       AND tp.state <> 'AUTHORIZED'
       AND tp.muted = false
      WHERE m.id > ${sinceId}
        AND m.creator <> ${userId}
        AND m."isDeleted" = false
        ${hiddenClause}
      ORDER BY m.id ASC
      LIMIT ${limit}
    `;
    const counts = new Map<number, number>();
    const mentionContents: string[] = [];
    for (const row of rows) {
      counts.set(row.creator, (counts.get(row.creator) ?? 0) + 1);
      if (
        row.contentType === 'PURE_TEXT' &&
        (row.content.includes('](socfp://user/') ||
          row.content.includes('](socfp://audience/all)'))
      ) {
        mentionContents.push(row.content);
      }
    }
    return {
      counts,
      mention: this.mentionState(mentionContents, selfAccount),
      overflow: rows.length >= limit,
    };
  }

  /**
   * Away-notification per-thread aggregation (Query A) for `grouping:'thread'`: the threads with new LIVE
   * messages since `sinceId`, each with its count + latest seq. To BOUND the scan, it first samples the
   * `sampleLimit` (default 1000) NEWEST qualifying messages, then groups the sample by thread (newest-thread-
   * first, capped at `threadLimit` cards). So a thread's count is its share of the recent 1000 — past that the
   * exact total is unknown (the per-thread display caps at "999+"). Muted threads + blocked creators + soft-
   * deleted messages excluded. The count is a real COUNT (not seq arithmetic — soft-deletes occupy seq but
   * must not count). For threads the client has NOT dismissed (cumulative since `since`); dismissed threads
   * override via {@link threadCountsSinceBounds}. Backed by Message(id).
   */
  async threadAwayBuckets(
    userId: number,
    sinceId: bigint,
    threadLimit: number,
    hideCreatorIds: number[] = [],
    sampleLimit = 1000,
  ): Promise<Map<number, { count: number; latestSeq: number }>> {
    const blockedClause = hideCreatorIds.length
      ? sql`AND m."creator" NOT IN (${this.joinSql(hideCreatorIds)})`
      : sql.empty();
    const rows = await this.queryRaw<
      Array<{ threadId: number; cnt: bigint; latest: number }>
    >`
      WITH sample AS (
        SELECT m."threadId" AS tid, m."seq" AS seq, m."id" AS id
        FROM "Message" m
        JOIN "ThreadParticipant" tp
          ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp.state <> 'AUTHORIZED'
        WHERE m."id" > ${sinceId} ${blockedClause} AND tp."muted" = false AND m."isDeleted" = false
        ORDER BY m."id" DESC
        LIMIT ${sampleLimit}
      )
      SELECT tid AS "threadId", COUNT(*) AS "cnt", MAX(seq) AS "latest"
      FROM sample
      GROUP BY tid
      ORDER BY MAX(id) DESC
      LIMIT ${threadLimit}
    `;
    const buckets = new Map<number, { count: number; latestSeq: number }>();
    for (const r of rows)
      buckets.set(r.threadId, { count: Number(r.cnt), latestSeq: r.latest });
    return buckets;
  }

  /**
   * Away-notification per-thread count (Query B), BATCHED for all DISMISSED threads in ONE query: for each
   * `(threadId, sinceSeq)` pair, the EXACT count of LIVE messages newer than `sinceSeq` (the thread's dismiss
   * HWM) AND newer than the global `globalSinceId` (so pre-foreground messages are never re-counted). The
   * client passes its dismiss HWMs in `threadHwms`; this returns the cumulative-since-dismiss count per thread
   * (dismiss resets it to 0 until newer messages). One UNNEST join replaces N per-thread queries. Same muted /
   * blocked / soft-deleted filters. Backed by Message(id, seq). Empty input → empty map (no query).
   */
  async threadCountsSinceBounds(
    userId: number,
    globalSinceId: bigint,
    pairs: Array<{ tid: number; sinceSeq: number }>,
    hideCreatorIds: number[] = [],
  ): Promise<Map<number, number>> {
    if (pairs.length === 0) return new Map();
    const blockedClause = hideCreatorIds.length
      ? sql`AND m."creator" NOT IN (${this.joinSql(hideCreatorIds)})`
      : sql.empty();
    const tids = pairs.map((p) => p.tid);
    const seqs = pairs.map((p) => p.sinceSeq);
    const rows = await this.queryRaw<Array<{ tid: number; cnt: bigint }>>`
      SELECT u.tid AS tid, COUNT(m.id) AS cnt
      FROM UNNEST(ARRAY[${this.joinSql(tids)}]::int[], ARRAY[${this.joinSql(seqs)}]::int[]) AS u(tid, sinceseq)
      JOIN "Message" m
        ON m."threadId" = u.tid AND m."seq" > u.sinceseq AND m."id" > ${globalSinceId} AND m."isDeleted" = false
      JOIN "ThreadParticipant" tp
        ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp.state <> 'AUTHORIZED' AND tp."muted" = false
      WHERE TRUE ${blockedClause}
      GROUP BY u.tid
    `;
    const out = new Map<number, number>();
    for (const r of rows) out.set(r.tid, Number(r.cnt));
    return out;
  }

  /**
   * The user's globally-newest message across their active threads (the highest internal `id` — the strict-
   * total-order key), as a `(threadId, seq, ts)` cursor. Backs the SSE `HELLO` connect handshake: the server
   * pushes this so the client has its `to` (the missed-summary walk's pinned upper bound) the instant SSE
   * connects — no separate "get newest" round-trip, and the walk seeds/catches-up correctly on first boot
   * (no local data) AND on reopen. Membership-scoped (an active ThreadParticipant row). `null` when the user
   * has no messages yet. Backed by Message(id) DESC + the ThreadParticipant join.
   */
  async findNewestForUser(
    userId: number,
  ): Promise<{ threadId: number; seq: number; ts: number } | null> {
    const rows = await this.queryRaw<
      Array<{ threadId: number; seq: number; createdAt: Date | string }>
    >`
      SELECT m."threadId" AS "threadId", m."seq" AS seq, m."createdAt" AS "createdAt"
      FROM "Message" m
      JOIN "ThreadParticipant" tp
        ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp.state <> 'AUTHORIZED'
      ORDER BY m."id" DESC
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    const ts =
      r.createdAt instanceof Date
        ? r.createdAt.getTime()
        : new Date(r.createdAt).getTime();
    return { threadId: r.threadId, seq: r.seq, ts };
  }

  /**
   * Unread counts for a user across the given threads, in ONE query. Unread = messages authored by someone
   * else with a per-thread seq greater than the read watermark. A null watermark means "nothing read", so
   * its lower bound is 0 (message seq starts at 1). Excluding the caller here is a defensive invariant in addition
   * to the send transaction advancing their read cursor: it keeps counts correct if an older client, import,
   * or recovery path leaves that cursor behind. Uses the Message(threadId,seq) index for the range scan.
   * Threads with zero unread remain present because the message predicates stay on the LEFT JOIN.
   */
  async countUnreadByThread(
    userId: number,
    threadIds: number[],
  ): Promise<Map<number, number>> {
    if (threadIds.length === 0) return new Map();
    const rows = await this.queryRaw<
      Array<{ threadId: number; unread: number }>
    >`
      SELECT tp."threadId" AS "threadId", COUNT(m.seq)::int AS "unread"
      FROM "ThreadParticipant" tp
      LEFT JOIN LATERAL (
        SELECT msg.seq
        FROM "Message" msg
        WHERE msg."threadId" = tp."threadId"
          AND msg.seq > COALESCE(tp."lastReadSeq", 0)
          AND msg.creator <> ${userId}
          AND msg."isDeleted" = false
        ORDER BY msg.seq ASC
        LIMIT 1000
      ) m ON TRUE
      WHERE tp."userId" = ${userId}
        AND tp.state <> 'AUTHORIZED'
        AND tp."threadId" IN (${this.joinSql(threadIds)})
      GROUP BY tp."threadId"
    `;
    return new Map(rows.map((r) => [r.threadId, r.unread]));
  }

  /**
   * One read model for the ThreadList unread range. Count and mention are derived from exactly the same
   * joined rows and therefore cannot disagree about membership, creator exclusion, or the read watermark.
   * PostgreSQL aggregates the count and only returns mention-looking text bodies for semantic parsing.
   */
  async unreadAttentionByThread(
    userId: number,
    selfAccount: string,
    threadIds: number[],
  ): Promise<Map<number, ThreadAttentionState>> {
    if (threadIds.length === 0) return new Map();
    const rows = await this.queryRaw<
      Array<{ threadId: number; unread: number; mentionContents: string[] }>
    >`
      SELECT
        tp."threadId" AS "threadId",
        COUNT(m.seq)::int AS "unread",
        COALESCE(
          ARRAY_AGG(m.content::text) FILTER (
            WHERE m."contentType" = 'PURE_TEXT'
              AND (
                strpos(m.content ->> 'text', '](socfp://user/') > 0
                OR strpos(m.content ->> 'text', '](socfp://audience/all)') > 0
              )
          ),
          ARRAY[]::text[]
        ) AS "mentionContents"
      FROM "ThreadParticipant" tp
      LEFT JOIN LATERAL (
        SELECT msg.seq, msg.content, msg."contentType"
        FROM "Message" msg
        WHERE msg."threadId" = tp."threadId"
          AND msg.seq > COALESCE(tp."lastReadSeq", 0)
          AND msg.creator <> ${userId}
          AND msg."isDeleted" = false
        ORDER BY msg.seq ASC
        LIMIT 1000
      ) m ON TRUE
      WHERE tp."userId" = ${userId}
        AND tp.state <> 'AUTHORIZED'
        AND tp."threadId" IN (${this.joinSql(threadIds)})
      GROUP BY tp."threadId"
    `;
    return new Map(
      rows.map((row) => [
        row.threadId,
        {
          count: row.unread,
          mention: this.mentionState(row.mentionContents ?? [], selfAccount),
        },
      ]),
    );
  }

  /** Monotonically merge a viewport HWM and derive its capped badge from the same PostgreSQL statement. */
  async commitReadState(
    userId: number,
    threadId: number,
    localReadHwm: number,
  ): Promise<CommittedThreadReadState | null> {
    const rows = await this.queryRaw<
      Array<{
        lastReadSeq: number;
        readRevision: number;
        unread: number;
        mentionContents: string[];
        account: string;
      }>
    >`
      WITH bumped AS (
        UPDATE "User"
        SET "readRevision" = "readRevision" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${userId}
        RETURNING "readRevision"
      ), advanced AS (
        UPDATE "ThreadParticipant" AS participant
        SET "lastReadSeq" = GREATEST(COALESCE("lastReadSeq", 0), ${localReadHwm}),
            "readRevision" = bumped."readRevision",
            "updatedAt" = CURRENT_TIMESTAMP
        FROM bumped
        WHERE participant."userId" = ${userId}
          AND participant."threadId" = ${threadId}
          AND participant.state <> 'AUTHORIZED'
        RETURNING participant."lastReadSeq", participant."readRevision"
      ), sample AS (
        SELECT m.seq, m.content, m."contentType"
        FROM "Message" m, advanced a
        WHERE m."threadId" = ${threadId}
          AND m.seq > a."lastReadSeq"
          AND m.creator <> ${userId}
          AND m."isDeleted" = false
        ORDER BY m.seq ASC
        LIMIT 1000
      )
      SELECT
        a."lastReadSeq" AS "lastReadSeq",
        a."readRevision" AS "readRevision",
        COUNT(s.seq)::int AS unread,
        COALESCE(
          ARRAY_AGG(s.content::text) FILTER (
            WHERE s."contentType" = 'PURE_TEXT'
              AND (
                strpos(s.content ->> 'text', '](socfp://user/') > 0
                OR strpos(s.content ->> 'text', '](socfp://audience/all)') > 0
              )
          ),
          ARRAY[]::text[]
        ) AS "mentionContents",
        u.account
      FROM advanced a
      JOIN "User" u ON u.id = ${userId}
      LEFT JOIN sample s ON TRUE
      GROUP BY a."lastReadSeq", a."readRevision", u.account
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      lastReadSeq: row.lastReadSeq,
      readRevision: row.readRevision,
      count: row.unread,
      mention: this.mentionState(row.mentionContents ?? [], row.account),
    };
  }

  /** Current last-write-wins read states changed in `(fromRevision, toRevision]`. */
  async queryReadDelta(
    userId: number,
    fromRevision: number,
    toRevision: number,
  ) {
    const participants =
      await this.database.db.query.threadParticipant.findMany({
        where: and(
          eq(threadParticipant.userId, userId),
          eq(threadParticipant.state, ThreadParticipantState.ESTABLISHED),
          gt(threadParticipant.readRevision, fromRevision),
          lte(threadParticipant.readRevision, toRevision),
        ),
        columns: { threadId: true, lastReadSeq: true, readRevision: true },
        orderBy: asc(threadParticipant.readRevision),
      });
    if (participants.length === 0) return [];
    const self = await this.database.db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: { account: true },
    });
    const attention = self
      ? await this.unreadAttentionByThread(
          userId,
          self.account,
          participants.map((p) => p.threadId),
        )
      : new Map();
    return participants.map((p) => ({
      threadId: p.threadId,
      lastReadSeq: p.lastReadSeq ?? 0,
      readRevision: p.readRevision,
      unreadCount: attention.get(p.threadId)?.count ?? 0,
      mentionUnread: attention.get(p.threadId)?.mention ?? [],
    }));
  }

  async currentReadRevision(userId: number): Promise<number> {
    const row = await this.database.db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: { readRevision: true },
    });
    return row?.readRevision ?? 0;
  }

  /**
   * One read model for per-conversation away notifications. The global HWM and optional per-thread dismiss
   * HWM are applied before sampling; count, latest seq and mention are then derived from that same sample.
   */
  async awayAttentionByThread(
    userId: number,
    selfAccount: string,
    globalSinceId: bigint,
    threadLimit: number,
    threadHwms: Record<number, number> = {},
    hideCreatorIds: number[] = [],
    sampleLimit = 1000,
  ): Promise<Map<number, AwayThreadAttentionState>> {
    const hiddenClause = hideCreatorIds.length
      ? sql`AND m."creator" NOT IN (${this.joinSql(hideCreatorIds)})`
      : sql.empty();
    const hwmEntries = Object.entries(threadHwms)
      .map(([threadId, seq]) => ({ threadId: Number(threadId), seq }))
      .filter((p) => Number.isInteger(p.threadId) && Number.isInteger(p.seq));
    const tids = hwmEntries.map((p) => p.threadId);
    const seqs = hwmEntries.map((p) => p.seq);
    const hwmCte =
      hwmEntries.length > 0
        ? sql`SELECT * FROM UNNEST(ARRAY[${this.joinSql(tids)}]::int[], ARRAY[${this.joinSql(seqs)}]::int[]) AS x(tid, since_seq)`
        : sql`SELECT NULL::int AS tid, NULL::int AS since_seq WHERE FALSE`;
    const rows = await this.queryRaw<
      Array<{
        threadId: number;
        cnt: bigint;
        latest: number;
        mentionContents: string[];
      }>
    >`
      WITH thread_hwm AS (${hwmCte}),
      sample AS (
        SELECT m."threadId" AS tid, m.seq, m.id, m.content, m."contentType"
        FROM "Message" m
        JOIN "ThreadParticipant" tp
          ON tp."threadId" = m."threadId"
         AND tp."userId" = ${userId}
         AND tp.state <> 'AUTHORIZED'
         AND tp.muted = false
        LEFT JOIN thread_hwm h ON h.tid = m."threadId"
        WHERE m.id > ${globalSinceId}
          AND m.seq > COALESCE(h.since_seq, 0)
          AND m.creator <> ${userId}
          AND m."isDeleted" = false
          ${hiddenClause}
        ORDER BY m.id DESC
        LIMIT ${sampleLimit}
      )
      SELECT
        tid AS "threadId",
        COUNT(*) AS cnt,
        MAX(seq) AS latest,
        COALESCE(
          ARRAY_AGG(content::text) FILTER (
            WHERE "contentType" = 'PURE_TEXT'
              AND (
                strpos(content ->> 'text', '](socfp://user/') > 0
                OR strpos(content ->> 'text', '](socfp://audience/all)') > 0
              )
          ),
          ARRAY[]::text[]
        ) AS "mentionContents"
      FROM sample
      GROUP BY tid
      ORDER BY MAX(id) DESC
      LIMIT ${threadLimit}
    `;
    return new Map(
      rows.map((row) => [
        row.threadId,
        {
          count: Number(row.cnt),
          latestSeq: row.latest,
          mention: this.mentionState(row.mentionContents ?? [], selfAccount),
        },
      ]),
    );
  }

  /** Recent messages for MessagingStyle, bounded independently per conversation. */
  async awayNotificationMessages(
    userId: number,
    globalSinceId: bigint,
    threadIds: number[],
    threadHwms: Record<number, number> = {},
    hideCreatorIds: number[] = [],
    perThreadLimit = 5,
  ): Promise<Map<number, AwayNotificationMessage[]>> {
    if (threadIds.length === 0) return new Map();
    const hiddenClause = hideCreatorIds.length
      ? sql`AND m.creator NOT IN (${this.joinSql(hideCreatorIds)})`
      : sql.empty();
    const hwmEntries = Object.entries(threadHwms)
      .map(([threadId, seq]) => ({ threadId: Number(threadId), seq }))
      .filter((p) => Number.isInteger(p.threadId) && Number.isInteger(p.seq));
    const hwmCte =
      hwmEntries.length > 0
        ? sql`SELECT * FROM UNNEST(
            ARRAY[${this.joinSql(hwmEntries.map((p) => p.threadId))}]::int[],
            ARRAY[${this.joinSql(hwmEntries.map((p) => p.seq))}]::int[]
          ) AS x(tid, since_seq)`
        : sql`SELECT NULL::int AS tid, NULL::int AS since_seq WHERE FALSE`;
    const rows = await this.queryRaw<
      Array<AwayNotificationMessage & { rn: bigint }>
    >`
      WITH thread_hwm AS (${hwmCte}),
      ranked AS (
        SELECT m."threadId", m.seq, m.creator, u.name AS "senderName",
               m."contentType", m.content, m."createdAt",
               ROW_NUMBER() OVER (PARTITION BY m."threadId" ORDER BY m.seq DESC) AS rn
        FROM "Message" m
        JOIN "User" u ON u.id = m.creator AND u."isDeleted" = false
        JOIN "ThreadParticipant" tp
          ON tp."threadId" = m."threadId"
         AND tp."userId" = ${userId}
         AND tp.state <> 'AUTHORIZED'
         AND tp.muted = false
        LEFT JOIN thread_hwm h ON h.tid = m."threadId"
        WHERE m."threadId" IN (${this.joinSql(threadIds)})
          AND m.id > ${globalSinceId}
          AND m.seq > COALESCE(h.since_seq, 0)
          AND m.creator <> ${userId}
          AND m."isDeleted" = false
          ${hiddenClause}
      )
      SELECT * FROM ranked WHERE rn <= ${perThreadLimit}
      ORDER BY "threadId", seq ASC
    `;
    const result = new Map<number, AwayNotificationMessage[]>();
    for (const row of rows) {
      const list = result.get(row.threadId) ?? [];
      list.push({
        ...row,
        content:
          typeof row.content === 'string'
            ? row.content
            : JSON.stringify(row.content),
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt as unknown as string),
      });
      result.set(row.threadId, list);
    }
    return result;
  }

  private mentionState(
    contents: string[],
    selfAccount: string,
  ): UnreadMentionState {
    const normalizedSelf = selfAccount.trim().toLocaleLowerCase();
    if (!normalizedSelf) return [];
    let all = false;
    let me = false;
    for (const content of contents) {
      const text = parseTextMessageContent(content)?.text ?? '';
      for (const segment of parseMessageEntities(text)) {
        if (segment.kind !== 'entity') continue;
        if (
          segment.entityType === 'user' &&
          segment.entityId.trim().toLocaleLowerCase() === normalizedSelf
        ) {
          me = true;
        }
        if (segment.entityType === 'audience' && segment.entityId === 'all')
          all = true;
      }
    }
    return [...(all ? ['all' as const] : []), ...(me ? ['me' as const] : [])];
  }

  /**
   * Whether each requested thread's unread range contains a semantic mention of the viewer. SQL narrows the
   * scan to text rows that resemble a SOCFP mention, then the canonical parser is the authority (so escaped
   * protocol-looking plain text cannot create a false mention). `me` outranks `all`.
   */
  async unreadMentionStates(
    userId: number,
    selfAccount: string,
    threadIds: number[],
  ): Promise<Map<number, UnreadMentionState>> {
    if (threadIds.length === 0 || !selfAccount.trim()) return new Map();
    const rows = await this.queryRaw<
      Array<{ threadId: number; content: string }>
    >`
      SELECT m."threadId" AS "threadId", m.content::text AS content
      FROM "ThreadParticipant" tp
      JOIN "Message" m
        ON m."threadId" = tp."threadId"
       AND m.seq > COALESCE(tp."lastReadSeq", 0)
       AND m.creator <> ${userId}
      WHERE tp."userId" = ${userId}
        AND tp.state <> 'AUTHORIZED'
        AND tp."threadId" IN (${this.joinSql(threadIds)})
        AND m."contentType" = 'PURE_TEXT'
        AND (
          strpos(m.content ->> 'text', '](socfp://user/') > 0
          OR strpos(m.content ->> 'text', '](socfp://audience/all)') > 0
        )
    `;
    const contents = new Map<number, string[]>();
    for (const row of rows) {
      const list = contents.get(row.threadId) ?? [];
      list.push(row.content);
      contents.set(row.threadId, list);
    }
    return new Map(
      [...contents].map(([threadId, values]) => [
        threadId,
        this.mentionState(values, selfAccount),
      ]),
    );
  }

  /** Mention state among messages newer than an internal away-notification HWM. */
  async mentionStatesSinceId(
    userId: number,
    selfAccount: string,
    sinceId: bigint,
    threadIds?: number[],
    hideCreatorIds: number[] = [],
  ): Promise<Map<number, UnreadMentionState>> {
    if (!selfAccount.trim() || threadIds?.length === 0) return new Map();
    const threadClause = threadIds
      ? sql`AND m."threadId" IN (${this.joinSql(threadIds)})`
      : sql.empty();
    const hiddenClause = hideCreatorIds.length
      ? sql`AND m.creator NOT IN (${this.joinSql(hideCreatorIds)})`
      : sql.empty();
    const rows = await this.queryRaw<
      Array<{ threadId: number; content: string }>
    >`
      SELECT m."threadId" AS "threadId", m.content::text AS content
      FROM "Message" m
      JOIN "ThreadParticipant" tp
        ON tp."threadId" = m."threadId"
       AND tp."userId" = ${userId}
       AND tp.state <> 'AUTHORIZED'
       AND tp.muted = false
      WHERE m.id > ${sinceId}
        AND m.creator <> ${userId}
        ${hiddenClause}
        AND m."contentType" = 'PURE_TEXT'
        ${threadClause}
        AND (
          strpos(m.content ->> 'text', '](socfp://user/') > 0
          OR strpos(m.content ->> 'text', '](socfp://audience/all)') > 0
        )
    `;
    const contents = new Map<number, string[]>();
    for (const row of rows) {
      const list = contents.get(row.threadId) ?? [];
      list.push(row.content);
      contents.set(row.threadId, list);
    }
    return new Map(
      [...contents].map(([threadId, values]) => [
        threadId,
        this.mentionState(values, selfAccount),
      ]),
    );
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
