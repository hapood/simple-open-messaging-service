import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { ContentType, Message, Prisma } from '../prisma/generated/client.js';
import { extractDigests } from '../upload/file-content.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import { MEDIA_STATUS } from '../common/media-status.js';
import { parseCallContent, callPreviewLabel } from '../calls/call-content.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

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
      return content.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_TEXT_MAX);
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
    private prisma: PrismaService,
    private readonly linkPreview: LinkPreviewService,
  ) {}

  async onModuleInit() {}

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
  ): Promise<Omit<Message, 'id'>> {
    if (clientMessageId !== undefined) {
      const existing = await this.prisma.message.findUnique({
        where: { clientMessageId },
        omit: { id: true },
      });
      if (existing !== null) return existing; // retry → return the original message (already dispatched)
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Atomic per-thread seq allocation: increment curSeq and read back the new value. The row lock
        // held to commit serializes concurrent sends to this thread (a brief wait, never an error) and
        // keeps curSeq == MAX(seq) by construction — no MAX() aggregate, no allocation race, no retry.
        // 0-INDEXED: curSeq defaults to -1, so the first message gets seq 0.
        const { curSeq: seq } = await tx.messageThread.update({
          where: { id: threadId },
          data: { curSeq: { increment: 1 } },
          select: { curSeq: true },
        });
        // originSeq == seq: a locally-authored message's per-thread seq IS the value a federation
        // receiver copies verbatim (the dedup key + per-(thread, sender) pull cursor).
        const msg = await tx.message.create({
          data: {
            content,
            contentType: type,
            threadId,
            creator: userId,
            clientMessageId,
            seq,
            originSeq: seq,
          },
        });
        await tx.messageThread.update({
          where: { id: threadId },
          data: {
            lastMessageSeq: seq,
            lastMessagePreview: derivePreview(type, content),
            lastMessageAt: msg.createdAt,
          },
        });
        // Sender has implicitly "read" what they just sent; seq is freshly allocated so it is always
        // strictly greater than the prior watermark — a forward move, never a regression.
        await tx.threadParticipant.update({
          where: { userId_threadId: { userId, threadId } },
          data: { lastReadSeq: seq },
        });
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
            await tx.mediaMessage.create({
              data: { messageId: msg.id, threadId, digest },
            });
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
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        clientMessageId !== undefined &&
        ((e.meta?.target as string[] | undefined) ?? []).includes(
          'clientMessageId',
        )
      ) {
        const winner = await this.prisma.message.findUnique({
          where: { clientMessageId },
          omit: { id: true },
        });
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
    const committed = await this.prisma.message.findUnique({
      where: { clientMessageId },
      select: { creator: true },
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
    const existing = await this.prisma.pendingMedia.findUnique({
      where: { clientMessageId },
    });
    if (!existing) {
      await this.prisma.pendingMedia.create({
        data: {
          threadId,
          creatorId: userId,
          contentType,
          content: JSON.stringify(meta ?? {}),
          clientMessageId,
        },
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
      await this.prisma.pendingMedia.updateMany({
        where: { id: existing.id, status: 'failed' },
        data: {
          status: 'pending',
          failReason: null,
          digest: null,
          content: JSON.stringify(meta ?? {}),
          createdAt: new Date(),
        },
      });
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
    await this.prisma.pendingMedia.updateMany({
      where: { clientMessageId, creatorId: userId, status: 'pending' },
      data: {
        status: 'failed',
        failReason: reason.slice(0, 255),
        createdAt: new Date(),
      },
    });
  }

  /** Recoverable server-side state for refresh/cross-device reconciliation. */
  async queryMediaStages(userId: number, threadId: number) {
    return this.prisma.pendingMedia.findMany({
      where: {
        threadId,
        creatorId: userId,
        clientMessageId: { not: null },
      },
      select: {
        clientMessageId: true,
        contentType: true,
        content: true,
        status: true,
        failReason: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
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
    await this.prisma.pendingMedia.updateMany({
      where: {
        clientMessageId,
        status: 'pending',
        ...(userId === undefined ? {} : { creatorId: userId }),
      },
      data: { digest },
    });
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
    const committed = await this.prisma.message.findUnique({
      where: { clientMessageId },
      omit: { id: true },
    });
    if (committed) return committed; // retry after a committed promote → return the original
    const stage = await this.prisma.pendingMedia.findUnique({
      where: { clientMessageId },
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
      created = await this.prisma.$transaction(async (tx) => {
        const { curSeq: seq } = await tx.messageThread.update({
          where: { id: stage.threadId },
          data: { curSeq: { increment: 1 } },
          select: { curSeq: true },
        });
        const msg = await tx.message.create({
          data: {
            content,
            contentType: finalContentType,
            threadId: stage.threadId,
            creator: stage.creatorId,
            clientMessageId,
            seq,
            originSeq: seq,
          },
        });
        await tx.messageThread.update({
          where: { id: stage.threadId },
          data: {
            lastMessageSeq: seq,
            lastMessagePreview: derivePreview(finalContentType, content),
            lastMessageAt: msg.createdAt,
          },
        });
        await tx.threadParticipant.update({
          where: {
            userId_threadId: {
              userId: stage.creatorId,
              threadId: stage.threadId,
            },
          },
          data: { lastReadSeq: seq },
        });
        const digest = extractDigests(content)[0];
        if (digest) {
          await tx.mediaMessage.create({
            data: { messageId: msg.id, threadId: stage.threadId, digest },
          });
        }
        await tx.pendingMedia.delete({ where: { id: stage.id } });
        return stripMessageId(msg);
      });
    } catch (e) {
      // Concurrent retry race (P2002 on clientMessageId) → return the winner rather than surfacing.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.prisma.message.findUnique({
          where: { clientMessageId },
          omit: { id: true },
        });
        if (winner !== null) return winner;
      }
      throw e;
    }
    return created;
  }

  async queryMessages(
    threadId: number,
    params: Prisma.MessageFindManyArgs,
    filters?: { clearedAfter?: Date | null; hideCreatorIds?: number[] },
  ) {
    // The viewer's per-thread filters, layered on top of the membership-resolved threadId:
    //  - clearedAfter: per-user "clear history" watermark — hide rows older than it for THIS user only.
    //  - hideCreatorIds: P2P block — the blocker never sees a blocked creator's messages. Scoped to P2P
    //    by the controller (group threads leave blocked members visible).
    const where: Prisma.MessageWhereInput = { threadId };
    if (filters?.clearedAfter) {
      where.createdAt = { gt: filters.clearedAfter };
    }
    if (filters?.hideCreatorIds && filters.hideCreatorIds.length > 0) {
      where.creator = { notIn: filters.hideCreatorIds };
    }
    // id is fetched here (not omitted) so attachMediaStatus can resolve MediaMessage authz by messageId;
    // attachMediaStatus strips id before returning (id is the internal global throughput side-channel
    // and must never reach a client).
    const rows = await this.prisma.message.findMany({
      ...params,
      where,
    });
    return this.attachMediaStatus(rows);
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
      this.prisma.mediaMessage.findMany({
        where: { messageId: { in: ids } },
        select: { messageId: true, digest: true },
      }),
      allDigests.size === 0
        ? Promise.resolve([] as { digest: string; refs: number }[])
        : this.prisma.mediaAsset.findMany({
            where: { digest: { in: [...allDigests] } },
            select: { digest: true, refs: true },
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
    const msgs = await this.prisma.message.findMany({
      where: { threadId, seq: { in: seqs } },
    });
    const attached = await this.attachMediaStatus(msgs);
    return attached.map((m) => ({
      seq: m.seq,
      status: m.mediaStatus,
      sv: m.sv,
    }));
  }

  /**
   * Substring search over a conversation's PURE_TEXT history. Returns lightweight {id, createdAt}
   * matches (no full bodies) — the client jumps the kernel to each id and the server renders the bubble
   * via the normal query-messages path on demand. Keyset-paginated by message id (descending): the
   * client's lastId cursor asks for the next older page of matches. ILIKE + the Message content trigram
   * GIN index backs the scan; non-text types are excluded (their content is a URL / JSON / token, never
   * meaningful to search and a potential URL leak).
   */
  async searchMessages(
    threadId: number,
    keyword: string,
    take: number,
    lastSeq?: number,
  ) {
    const where: Prisma.MessageWhereInput = {
      threadId,
      contentType: ContentType.PURE_TEXT,
      content: { contains: keyword, mode: 'insensitive' },
    };
    if (lastSeq !== undefined) {
      where.seq = { lt: lastSeq };
    }
    const rows = await this.prisma.message.findMany({
      where,
      orderBy: { seq: 'desc' },
      take: take + 1, // take+1 hasMore trick — same idiom as queryMessages
      select: { seq: true, createdAt: true },
    });
    return rows;
  }

  /** Single message lookup by per-thread (threadId, seq) identity — seq is unique only within a thread,
   *  so both parts of the compound unique are required. Used by mark-read to validate the cursor. */
  findMessageBySeq(threadId: number, seq: number) {
    return this.prisma.message.findUnique({
      where: { threadId_seq: { threadId, seq } },
      omit: { id: true },
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
    return this.prisma.message.findMany({
      where: { OR: pairs.map((p) => ({ threadId: p.threadId, seq: p.seq })) },
    });
  }

  /** Single thread lookup (used by mark-read to resolve "mark all current messages read"). */
  findThread(id: number) {
    return this.prisma.messageThread.findUnique({ where: { id } });
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
      ? Prisma.sql`AND m."creator" NOT IN (${Prisma.join(blocked)})`
      : Prisma.empty;

    if (opts.init) {
      // Newest message per active thread. DISTINCT ON picks the first row per threadId under the given
      // ORDER BY, so `ORDER BY threadId, seq DESC` yields each thread's highest-seq (latest) message.
      const where = blocked.length
        ? Prisma.sql`WHERE m."creator" NOT IN (${Prisma.join(blocked)})`
        : Prisma.empty;
      return this.prisma.$queryRaw<Message[]>`
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
    return this.prisma.$queryRaw<Message[]>`
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
      ? Prisma.sql`AND m."creator" NOT IN (${Prisma.join(hideCreatorIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ creator: number }>>`
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
      ? Prisma.sql`AND m."creator" NOT IN (${Prisma.join(hideCreatorIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
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
      ? Prisma.sql`AND m."creator" NOT IN (${Prisma.join(hideCreatorIds)})`
      : Prisma.empty;
    const tids = pairs.map((p) => p.tid);
    const seqs = pairs.map((p) => p.sinceSeq);
    const rows = await this.prisma.$queryRaw<
      Array<{ tid: number; cnt: bigint }>
    >`
      SELECT u.tid AS tid, COUNT(m.id) AS cnt
      FROM UNNEST(ARRAY[${Prisma.join(tids)}]::int[], ARRAY[${Prisma.join(seqs)}]::int[]) AS u(tid, sinceseq)
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
    const rows = await this.prisma.$queryRaw<
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
   * Unread counts for a user across the given threads, in ONE query. Unread = messages with a per-thread
   * seq greater than the per-thread read watermark (lastReadSeq; NULL ⇒ never read ⇒ count everything via
   * COALESCE(...,0)). Uses the Message(threadId,seq) index for the range scan. Returns a Map keyed by
   * threadId; threads with zero unread are present with value 0 (LEFT JOIN guarantees one row each).
   */
  async countUnreadByThread(
    userId: number,
    threadIds: number[],
  ): Promise<Map<number, number>> {
    if (threadIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      Array<{ threadId: number; unread: number }>
    >`
      SELECT tp."threadId" AS "threadId", COUNT(m.seq)::int AS "unread"
      FROM "ThreadParticipant" tp
      LEFT JOIN "Message" m
        ON m."threadId" = tp."threadId"
       AND m.seq > COALESCE(tp."lastReadSeq", 0)
      WHERE tp."userId" = ${userId}
        AND tp."leftAt" IS NULL
        AND tp."threadId" IN (${Prisma.join(threadIds)})
      GROUP BY tp."threadId"
    `;
    return new Map(rows.map((r) => [r.threadId, r.unread]));
  }
}
