import { Injectable, OnModuleInit } from '@nestjs/common';
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
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { ContentType, MessageThreadType } from '../database/enums.js';
import {
  forwardMessage,
  group,
  mediaAsset,
  mediaMessage,
  message,
  messageThread,
  pendingMedia,
  threadParticipant,
  user,
} from '../database/schema.js';
import { isUniqueViolation } from '../database/database-error.js';
import { extractDigests } from '../upload/file-content.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import { MEDIA_STATUS } from '../common/media-status.js';
import { parseCallContent, callPreviewLabel } from '../calls/call-content.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import {
  parseMessageEntities,
  toDisplayText,
} from '../common/message-entity.js';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';

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

/** Max characters of a PURE_TEXT message kept in the denormalized last-message preview. */
const PREVIEW_TEXT_MAX = 200;

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
 * Derive the short conversation-list preview for a message, by content type. Mirrored by the SQL CASE
 * in migration 20260702120000_message_thread_last_message (one-shot backfill); keep them in sync when
 * content types change. Text is whitespace-collapsed + trimmed so a multiline message renders on one line.
 */
export function derivePreview(type: ContentType, content: string): string {
  switch (type) {
    case ContentType.PURE_TEXT:
      return toDisplayText(parseTextMessageContent(content)?.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, PREVIEW_TEXT_MAX);
    case ContentType.LINK: {
      // The card title (or URL) — never the raw JSON. Degrades to a slice on a malformed payload.
      try {
        const c = JSON.parse(content) as { title?: string; url?: string };
        const t = c.title && c.title.trim() ? c.title : (c.url ?? content);
        return t.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_TEXT_MAX);
      } catch {
        return content.slice(0, PREVIEW_TEXT_MAX);
      }
    }
    case ContentType.IMAGE:
      return '[Photo]';
    case ContentType.INVITE:
      return '[Group invite]';
    case ContentType.VIDEO:
      return '[Video]';
    case ContentType.FILE:
      return '[File]';
    case ContentType.AUDIO:
      return '[Voice message]';
    case ContentType.FORWARD: {
      try {
        const c = JSON.parse(content) as { summaryLines?: string[] };
        const first = c.summaryLines?.[0]?.replace(/\s+/g, ' ').trim();
        return first
          ? `[Chat history] ${first}`.slice(0, PREVIEW_TEXT_MAX)
          : '[Chat history]';
      } catch {
        return '[Chat history]';
      }
    }
    case ContentType.CALL: {
      // A call-record bubble: the status-aware label (never the raw JSON). Degrades to a generic
      // label on a malformed payload (parseCallContent returns null).
      const c = parseCallContent(content);
      return c ? callPreviewLabel(c.status) : '[Call]';
    }
    default:
      return content.slice(0, PREVIEW_TEXT_MAX);
  }
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
export class MessageService implements OnModuleInit {
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

  async onModuleInit() {}

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
   * No MAX() aggregate and no retry loop: the row lock IS the allocation authority. originSeq is set to
   * seq — for a locally-authored message, this server's per-thread seq IS the federation value a
   * receiver copies verbatim (the dedup key + per-(thread, sender) pull cursor).
   */
  async writeMsgToThread(
    userId: number,
    threadId: number,
    content: string,
    type: ContentType,
    clientMessageId?: string,
    forwardBundleId?: string,
    beforeMessageCreate?: (tx: DatabaseTransaction) => Promise<void>,
    quoteVisibility?: { clearedThroughSeq?: number | null; hideCreatorIds?: number[] },
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
        // 0-INDEXED: curSeq defaults to -1, so the first message gets seq 0.
        const [{ curSeq: seq }] = await tx
          .update(messageThread)
          .set({ curSeq: sql`${messageThread.curSeq} + 1` })
          .where(eq(messageThread.id, threadId))
          .returning({ curSeq: messageThread.curSeq });
        // originSeq == seq: a locally-authored message's per-thread seq IS the value a federation
        // receiver copies verbatim (the dedup key + per-(thread, sender) pull cursor).
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
        const storedContent =
          textContent && quoteTarget
            ? stringifyTextMessageContent({
                text: textContent.text,
                quote: { seq: quoteTarget.seq },
              })
            : content;
        const [msg] = await tx
          .insert(message)
          .values({
            content: storedContent,
            contentType: type,
            threadId,
            creator: userId,
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
        // Per-object media authz: record the CAS digest this message references so the /uploads/shards/*
        // gate can authorize readers against thread membership (one indexed row). One message carries
        // one media (MediaMessage is 1:1). PURE_TEXT/
        // INVITE reference no media.
        if (
          type === ContentType.IMAGE ||
          type === ContentType.FILE ||
          type === ContentType.VIDEO ||
          type === ContentType.AUDIO
        ) {
          const digest = extractDigests(content)[0];
          if (digest) {
            await tx
              .insert(mediaMessage)
              .values({ messageId: msg.id, threadId, digest });
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

  /**
   * Stage a LOCAL media send BEFORE the file is uploaded: create a PendingMedia(pending) row carrying
   * the client-probed display metadata (`meta` — w/h, duration). No Message, no seq, no fan-out — the
   * message is invisible in the thread until {@link promoteStaged} runs after a successful upload.
   *
   * Creating the staging row FIRST (before any file write) is the orphan-safety guarantee: a crash
   * between staging and upload always leaves an attributable record, never the unattributed orphan the
   * old upload-then-send order produced (a file on disk with no idea who it was for). The CAS url is
   * NOT stored here — it is injected at promote from the server's own saveCas digest, so the real
   * Message.content URL is never client-supplied.
   *
   * Idempotent by clientMessageId: a retried send-media resumes the same stage (upsert with an empty
   * update — a retry must not reset an in-flight stage). If clientMessageId already committed a Message,
   * the send already completed → return as-is.
   */
  async stageMedia(
    userId: number,
    threadId: number,
    contentType: ContentType,
    clientMessageId: string,
    meta: Record<string, unknown>,
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
      await this.database.db.insert(pendingMedia).values({
        threadId,
        creatorId: userId,
        contentType,
        content: JSON.stringify(meta ?? {}),
        clientMessageId,
        updatedAt: new Date(),
      });
      return { clientMessageId };
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
          content: JSON.stringify(meta ?? {}),
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
   * Link a staged send to its on-disk asset (after saveCas wrote the file + MediaAsset). A SEPARATE
   * commit from {@link promoteStaged} so a crash between the two still leaves an attributable orphan
   * (a pending row whose digest points at the file) rather than a mystery asset. Best-effort: a missing
   * or non-pending stage is a no-op (the upload still succeeded; promote will surface the state).
   */
  async linkStagedDigest(
    clientMessageId: string,
    digest: string,
    userId?: number,
  ): Promise<void> {
    await this.database.db
      .update(pendingMedia)
      .set({ digest, updatedAt: new Date() })
      .where(
        and(
          eq(pendingMedia.clientMessageId, clientMessageId),
          eq(pendingMedia.status, 'pending'),
          ...(userId === undefined ? [] : [eq(pendingMedia.creatorId, userId)]),
        ),
      );
  }

  /**
   * Promote a staged media send to a real Message after the upload succeeded. Merges the server-generated
   * upload payload (url/name/size/mimeType) with the staged client-probed meta (w/h/duration) into the
   * final content, then runs the SAME commit core as writeMsgToThread (atomic seq allocation, Message +
   * MediaMessage + last-message cache + sender read cursor) and deletes the PendingMedia. Emits
   * MESSAGE_COMMITTED_EVENT so the unified fan-out runs.
   *
   * Idempotent: if clientMessageId already committed a Message (a retried upload after a committed
   * promote), returns the existing Message without re-creating. Returns null if no pending stage exists
   * for this clientMessageId (the caller passed a clientMessageId but never staged — a client bug; the
   * upload result is returned to the client unchanged).
   */
  async promoteStaged(
    clientMessageId: string,
    uploadPayload: Record<string, unknown>,
    userId?: number,
    contentTypeOverride?: ContentType,
  ): Promise<Omit<Message, 'id'> | null> {
    const committed = await this.findByClientMessageId(clientMessageId);
    if (committed) return committed; // retry after a committed promote → return the original
    const stage = await this.database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.clientMessageId, clientMessageId),
    });
    if (
      !stage ||
      stage.status !== 'pending' ||
      (userId !== undefined && stage.creatorId !== userId)
    )
      return null; // nothing to promote
    const meta = stage.content
      ? (JSON.parse(stage.content) as Record<string, unknown>)
      : {};
    const finalContentType = contentTypeOverride ?? stage.contentType;
    // A server-side format fallback can promote an IMAGE intent as FILE. Image/video/audio display
    // metadata is meaningful only while the staged and final types match; never leak w/h/duration
    // into a generic FILE content object.
    const content = JSON.stringify({
      ...uploadPayload,
      ...(finalContentType === stage.contentType ? meta : {}),
    });
    let created: Omit<Message, 'id'>;
    try {
      created = await this.database.db.transaction(async (tx) => {
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
        if (!participant || participant.leftAt !== null) {
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
        const [msg] = await tx
          .insert(message)
          .values({
            content,
            contentType: finalContentType,
            threadId: stage.threadId,
            creator: stage.creatorId,
            clientMessageId,
            seq,
            originSeq: seq,
            updatedAt: new Date(),
          })
          .returning();
        await tx
          .update(messageThread)
          .set({
            lastMessageSeq: seq,
            lastMessagePreview: derivePreview(finalContentType, content),
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
        const digest = extractDigests(content)[0];
        if (digest) {
          await tx.insert(mediaMessage).values({
            messageId: msg.id,
            threadId: stage.threadId,
            digest,
          });
        }
        await tx.delete(pendingMedia).where(eq(pendingMedia.id, stage.id));
        return stripMessageId(msg);
      });
    } catch (e) {
      // Concurrent retry race (P2002 on clientMessageId) → return the winner rather than surfacing.
      if (isUniqueViolation(e)) {
        const winner = await this.findByClientMessageId(clientMessageId);
        if (winner !== null) return winner;
      }
      throw e;
    }
    return created;
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
    const conditions: SQL[] = [eq(message.threadId, threadId)];
    if (filters?.clearedThroughSeq !== null && filters?.clearedThroughSeq !== undefined)
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

  /** Batch-enrich stored `{text, quote:{seq}}` envelopes without persisting a preview. Cross-thread
   * callers may provide viewer visibility independently for each source thread. */
  async attachQuotePreviews<T extends Message>(
    msgs: T[],
    filters?:
      | { clearedThroughSeq?: number | null; hideCreatorIds?: number[] }
      | Map<number, { clearedThroughSeq?: number | null; hideCreatorIds?: number[] }>,
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
    const byKey = new Map(
      visibleTargets.map((target) => [
        `${target.threadId}:${target.seq}`,
        truncateText(
          `${target.user.name}：${derivePreview(
            target.contentType,
            target.content,
          )}`,
          100,
        ),
      ]),
    );
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
            ...(preview === undefined ? {} : { preview }),
          },
        }),
      };
    });
  }

  /** Attach a `mediaStatus` ('ready' | 'failed') + `sv` (status version = seq) to each message by
   *  checking, in bulk, whether every CAS digest in its content has a MediaMessage authz row for THIS
   *  message AND a MediaAsset with refs>0 (bytes on disk). Non-media messages (no digest)
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
      const ds = extractDigests(m.content);
      byMsg.set(m.id, ds);
      for (const d of ds) allDigests.add(d);
    }
    const ids = msgs.map((m) => m.id);
    const [authRows, assetRows] = await Promise.all([
      this.database.db.query.mediaMessage.findMany({
        where: inArray(mediaMessage.messageId, ids),
        columns: { messageId: true, digest: true },
      }),
      allDigests.size === 0
        ? Promise.resolve([] as { digest: string; refs: number }[])
        : this.database.db.query.mediaAsset.findMany({
            where: inArray(mediaAsset.digest, [...allDigests]),
            columns: { digest: true, refs: true },
          }),
    ]);
    // A digest is ready for message m iff an authz row (messageId, digest) exists AND the asset has
    // refs>0 on disk. messageId is BigInt; String(1n) === "1" so the composite key is collision-free.
    const auth = new Set(authRows.map((r) => `${r.messageId}:${r.digest}`));
    const present = new Set(
      assetRows.filter((a) => a.refs > 0).map((a) => a.digest),
    );
    // LINK thumbnails: the DB stores only the image digest; inline it as base64 for the wire (the
    // frontend renders the card from the data URI). One read per LINK row; non-LINK is untouched.
    const forWire = await Promise.all(
      msgs.map(async (m) =>
        m.contentType === ContentType.LINK
          ? {
              ...m,
              content: await this.linkPreview.enrichForWire(
                m.contentType,
                m.content,
              ),
            }
          : m,
      ),
    );
    return forWire.map((m) => {
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
      where: and(eq(message.threadId, threadId), inArray(message.seq, seqs)),
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
        )
      ORDER BY seq DESC
      LIMIT ${take + 1}
    `;
  }

  /** Single message lookup by per-thread (threadId, seq) identity — seq is unique only within a thread,
   *  so both parts of the compound unique are required. Used by mark-read to validate the cursor. */
  findMessageBySeq(threadId: number, seq: number) {
    return this.database.db.query.message
      .findFirst({
        where: and(eq(message.threadId, threadId), eq(message.seq, seq)),
      })
      .then((row) => (row ? stripMessageId(row) : null));
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
      where: or(
        ...pairs.map((pair) =>
          and(eq(message.threadId, pair.threadId), eq(message.seq, pair.seq)),
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
          ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp."leftAt" IS NULL
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
        ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp."leftAt" IS NULL
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
        ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp."leftAt" IS NULL
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
       AND tp."leftAt" IS NULL
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
        (row.content.includes('](soms://user/') ||
          row.content.includes('](soms://audience/all?v=1)'))
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
          ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp."leftAt" IS NULL
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
        ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp."leftAt" IS NULL AND tp."muted" = false
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
        ON tp."threadId" = m."threadId" AND tp."userId" = ${userId} AND tp."leftAt" IS NULL
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
   * its lower bound is -1 (seq starts at 0). Excluding the caller here is a defensive invariant in addition
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
          AND msg.seq > COALESCE(tp."lastReadSeq", -1)
          AND msg.creator <> ${userId}
        ORDER BY msg.seq ASC
        LIMIT 1000
      ) m ON TRUE
      WHERE tp."userId" = ${userId}
        AND tp."leftAt" IS NULL
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
                strpos(m.content ->> 'text', '](soms://user/') > 0
                OR strpos(m.content ->> 'text', '](soms://audience/all?v=1)') > 0
              )
          ),
          ARRAY[]::text[]
        ) AS "mentionContents"
      FROM "ThreadParticipant" tp
      LEFT JOIN LATERAL (
        SELECT msg.seq, msg.content, msg."contentType"
        FROM "Message" msg
        WHERE msg."threadId" = tp."threadId"
          AND msg.seq > COALESCE(tp."lastReadSeq", -1)
          AND msg.creator <> ${userId}
        ORDER BY msg.seq ASC
        LIMIT 1000
      ) m ON TRUE
      WHERE tp."userId" = ${userId}
        AND tp."leftAt" IS NULL
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
        unread: number;
        mentionContents: string[];
        account: string;
      }>
    >`
      WITH advanced AS (
        UPDATE "ThreadParticipant"
        SET "lastReadSeq" = GREATEST(COALESCE("lastReadSeq", -1), ${localReadHwm})
        WHERE "userId" = ${userId}
          AND "threadId" = ${threadId}
          AND "leftAt" IS NULL
        RETURNING "lastReadSeq"
      ), sample AS (
        SELECT m.seq, m.content, m."contentType"
        FROM "Message" m, advanced a
        WHERE m."threadId" = ${threadId}
          AND m.seq > a."lastReadSeq"
          AND m.creator <> ${userId}
        ORDER BY m.seq ASC
        LIMIT 1000
      )
      SELECT
        a."lastReadSeq" AS "lastReadSeq",
        COUNT(s.seq)::int AS unread,
        COALESCE(
          ARRAY_AGG(s.content::text) FILTER (
            WHERE s."contentType" = 'PURE_TEXT'
              AND (
                strpos(s.content ->> 'text', '](soms://user/') > 0
                OR strpos(s.content ->> 'text', '](soms://audience/all?v=1)') > 0
              )
          ),
          ARRAY[]::text[]
        ) AS "mentionContents",
        u.account
      FROM advanced a
      JOIN "User" u ON u.id = ${userId}
      LEFT JOIN sample s ON TRUE
      GROUP BY a."lastReadSeq", u.account
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      lastReadSeq: row.lastReadSeq,
      count: row.unread,
      mention: this.mentionState(row.mentionContents ?? [], row.account),
    };
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
         AND tp."leftAt" IS NULL
         AND tp.muted = false
        LEFT JOIN thread_hwm h ON h.tid = m."threadId"
        WHERE m.id > ${globalSinceId}
          AND m.seq > COALESCE(h.since_seq, -1)
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
                strpos(content ->> 'text', '](soms://user/') > 0
                OR strpos(content ->> 'text', '](soms://audience/all?v=1)') > 0
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
         AND tp."leftAt" IS NULL
         AND tp.muted = false
        LEFT JOIN thread_hwm h ON h.tid = m."threadId"
        WHERE m."threadId" IN (${this.joinSql(threadIds)})
          AND m.id > ${globalSinceId}
          AND m.seq > COALESCE(h.since_seq, -1)
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
        if (
          segment.kind !== 'entity' ||
          segment.version !== 1 ||
          segment.sigil !== '@'
        )
          continue;
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
   * scan to text rows that resemble a SOMS mention, then the canonical parser is the authority (so escaped
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
       AND m.seq > COALESCE(tp."lastReadSeq", -1)
       AND m.creator <> ${userId}
      WHERE tp."userId" = ${userId}
        AND tp."leftAt" IS NULL
        AND tp."threadId" IN (${this.joinSql(threadIds)})
        AND m."contentType" = 'PURE_TEXT'
        AND (
          strpos(m.content ->> 'text', '](soms://user/') > 0
          OR strpos(m.content ->> 'text', '](soms://audience/all?v=1)') > 0
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
       AND tp."leftAt" IS NULL
       AND tp.muted = false
      WHERE m.id > ${sinceId}
        AND m.creator <> ${userId}
        ${hiddenClause}
        AND m."contentType" = 'PURE_TEXT'
        ${threadClause}
        AND (
          strpos(m.content ->> 'text', '](soms://user/') > 0
          OR strpos(m.content ->> 'text', '](soms://audience/all?v=1)') > 0
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
