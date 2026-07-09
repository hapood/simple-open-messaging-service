import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { ContentType, Message, Prisma } from '../prisma/generated/client.js';
import { extractDigests } from '../upload/file-content.js';

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
      if (existing !== null) return existing; // retry → return the original message
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
    const data = await this.prisma.message.findMany({
      ...params,
      where,
      omit: { id: true }, // never expose the internal global id (throughput side-channel)
    });
    return data;
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
