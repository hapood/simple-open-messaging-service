import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { ContentType, Message, Prisma } from '../prisma/generated/client.js';
import { extractDigests } from '../upload/file-content.js';
import { MEDIA_STATUS } from '../common/media-status.js';

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
  constructor(private prisma: PrismaService) {}

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
            lastMessageSenderId: userId,
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
        // one media (MediaMessage is 1:1); legacy-flat URLs carry no digest and are skipped. PURE_TEXT/
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
  ): Promise<{ clientMessageId: string }> {
    const committed = await this.prisma.message.findUnique({
      where: { clientMessageId },
      select: { seq: true },
    });
    if (committed) return { clientMessageId }; // already promoted — nothing to stage
    await this.prisma.pendingMedia.upsert({
      where: { clientMessageId },
      create: {
        threadId,
        creatorId: userId,
        contentType,
        content: JSON.stringify(meta ?? {}),
        clientMessageId,
      },
      update: {}, // idempotent re-stage: keep the existing row's state intact
    });
    return { clientMessageId };
  }

  /**
   * Link a staged send to its on-disk asset (after saveCas wrote the file + MediaAsset). A SEPARATE
   * commit from {@link promoteStaged} so a crash between the two still leaves an attributable orphan
   * (a pending row whose digest points at the file) rather than a mystery asset. Best-effort: a missing
   * or non-pending stage is a no-op (the upload still succeeded; promote will surface the state).
   */
  async linkStagedDigest(clientMessageId: string, digest: string): Promise<void> {
    await this.prisma.pendingMedia.updateMany({
      where: { clientMessageId, status: 'pending' },
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
  ): Promise<Omit<Message, 'id'> | null> {
    const committed = await this.prisma.message.findUnique({
      where: { clientMessageId },
      omit: { id: true },
    });
    if (committed) return committed; // retry after a committed promote → return the original
    const stage = await this.prisma.pendingMedia.findUnique({
      where: { clientMessageId },
    });
    if (!stage || stage.status !== 'pending') return null; // nothing to promote
    const meta = stage.content
      ? (JSON.parse(stage.content) as Record<string, unknown>)
      : {};
    const content = JSON.stringify({ ...uploadPayload, ...meta });
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
            contentType: stage.contentType,
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
            lastMessagePreview: derivePreview(stage.contentType, content),
            lastMessageSenderId: stage.creatorId,
            lastMessageAt: msg.createdAt,
          },
        });
        await tx.threadParticipant.update({
          where: {
            userId_threadId: { userId: stage.creatorId, threadId: stage.threadId },
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
   *  message AND a MediaAsset with refs>0 (bytes on disk). Non-media / legacy-flat messages (no digest)
   *  are trivially 'ready'. Two batch queries serve a whole page — no per-row N+1. Strips the internal
   *  id (it never reaches a client). Drives the query-messages response and the media-status probe. */
  async attachMediaStatus<T extends Message>(
    msgs: T[],
  ): Promise<(Omit<T, 'id'> & { mediaStatus: 'ready' | 'failed'; sv: number })[]> {
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
    return msgs.map((m) => {
      const { id: _drop, ...rest } = m;
      const ds = byMsg.get(m.id) ?? [];
      const ready =
        ds.length === 0 || ds.every((d) => auth.has(`${m.id}:${d}`) && present.has(d));
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
    return attached.map((m) => ({ seq: m.seq, status: m.mediaStatus, sv: m.sv }));
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

  /** Single thread lookup (used by mark-read to resolve "mark all current messages read"). */
  findThread(id: number) {
    return this.prisma.messageThread.findUnique({ where: { id } });
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
