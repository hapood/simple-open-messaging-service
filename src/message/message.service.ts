import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { ContentType, Message, Prisma } from '../prisma/generated/client.js';
import { extractDigests } from '../upload/file-content.js';

/** Max characters of a PURE_TEXT message kept in the denormalized last-message preview. */
const PREVIEW_TEXT_MAX = 200;

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
   *  - the sender's own message never counts as unread to themselves (their lastReadMsgId jumps to
   *    what they just sent), removing the need for a client post-send mark-read round-trip and keeping
   *    multi-device badge counts correct.
   * Returns the full Message (BigInt/Date serialized by the global interceptor).
   *
   * Idempotent when a clientMessageId is supplied: a retried send (network blip after the server
   * committed) returns the ORIGINAL Message row instead of creating a duplicate. The partial unique
   * index on Message.clientMessageId is the dedup authority; the pre-check avoids throwing in the
   * common serial-retry case and the P2002 branch wins the concurrent-retry race (the interactive tx
   * is poisoned by the error, so the re-fetch runs on the root client).
   *
   * Also allocates the per-(thread, sender) originSeq (MAX+1) inside the tx — the cross-server
   * federation pull cursor (Step 2). A same-user concurrent-send race on the (threadId, creator,
   * originSeq) unique index is resolved by a bounded tx retry (distinct from the clientMessageId race).
   */
  async writeMsgToThread(
    userId: number,
    threadId: number,
    content: string,
    type: ContentType,
    clientMessageId?: string,
  ): Promise<Message> {
    if (clientMessageId !== undefined) {
      const existing = await this.prisma.message.findUnique({
        where: { clientMessageId },
      });
      if (existing !== null) return existing; // retry → return the original message
    }
    // The (threadId, creator, originSeq) unique index collides when two concurrent sends from the SAME
    // user race (both read the same MAX+1 before either commits). A bounded retry resolves it: re-read
    // MAX on a fresh tx and re-create. (Different users never contend — different creator.) This is
    // distinct from the clientMessageId P2002 below, which is a concurrent RETRY of the same send.
    const MAX_SEQ_RACES = 5;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // Allocate the per-(thread, sender) originSeq = (MAX ?? -1) + 1 — the cross-server federation
          // pull cursor. 0-INDEXED: the first federated send in a (thread, sender) is seq 0, then 1, 2, …
          // NULLs (legacy rows + never-federating threads) are ignored by _max, so an empty (thread,
          // sender) yields -1 → first send = 0. Always assigned: local-only threads pay one cheap
          // aggregate now and are ready if they ever federate. See docs/federation-step2-design.md §2.1.
          const lastSeq = await tx.message.aggregate({
            where: { threadId, creator: userId },
            _max: { originSeq: true },
          });
          const originSeq = (lastSeq._max.originSeq ?? -1) + 1;
          const msg = await tx.message.create({
            data: {
              content,
              contentType: type,
              threadId,
              creator: userId,
              clientMessageId,
              originSeq,
            },
          });
          await tx.messageThread.update({
            where: { id: threadId },
            data: {
              lastMessageId: msg.id,
              lastMessagePreview: derivePreview(type, content),
              lastMessageSenderId: userId,
              lastMessageAt: msg.createdAt,
            },
          });
          // Sender has implicitly "read" what they just sent; msg.id is a fresh autoincrement so it is
          // always strictly greater than the prior watermark — a forward move, never a regression.
          await tx.threadParticipant.update({
            where: { userId_threadId: { userId, threadId } },
            data: { lastReadMsgId: msg.id },
          });
          // Per-object media authz: record every CAS digest this message references so the /uploads/shards/*
          // gate can authorize readers against thread membership (one indexed EXISTS). One row per distinct
          // digest; skipDuplicates honors @@unique([messageId, digest]) for album duplicates. PURE_TEXT/
          // INVITE reference no media; legacy-flat URLs carry no digest and are skipped by extractDigests.
          if (
            type === ContentType.IMAGE ||
            type === ContentType.FILE ||
            type === ContentType.VIDEO ||
            type === ContentType.AUDIO
          ) {
            const digests = extractDigests(content);
            if (digests.length > 0) {
              await tx.mediaMessage.createMany({
                data: digests.map((digest) => ({ messageId: msg.id, threadId, digest })),
                skipDuplicates: true,
              });
            }
          }
          return msg;
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          const target = ((e.meta?.target as string[] | undefined) ?? []);
          // Concurrent RETRY of the same send (same clientMessageId): another request inserted it
          // first. Return theirs rather than surfacing the unique-violation. (The interactive tx is
          // poisoned by the error, so the re-fetch runs on the root client.)
          if (clientMessageId !== undefined && target.includes('clientMessageId')) {
            const winner = await this.prisma.message.findUnique({
              where: { clientMessageId },
            });
            if (winner !== null) return winner;
          }
          // Same-user concurrent-send race on originSeq: retry the tx (re-reads MAX). Bounded to avoid
          // an infinite loop under pathological contention.
          if (target.includes('originSeq') && attempt < MAX_SEQ_RACES) continue;
        }
        throw e;
      }
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
  async searchMessages(threadId: number, keyword: string, take: number, lastId?: bigint) {
    const where: Prisma.MessageWhereInput = {
      threadId,
      contentType: ContentType.PURE_TEXT,
      content: { contains: keyword, mode: 'insensitive' },
    };
    if (lastId !== undefined) {
      where.id = { lt: lastId };
    }
    const rows = await this.prisma.message.findMany({
      where,
      orderBy: { id: 'desc' },
      take: take + 1, // take+1 hasMore trick — same idiom as queryMessages
      select: { id: true, createdAt: true },
    });
    return rows;
  }

  /** Single message lookup (used by mark-read to validate the cursor belongs to the thread). */
  findMessageById(id: bigint) {
    return this.prisma.message.findUnique({ where: { id } });
  }

  /** Single thread lookup (used by mark-read to resolve "mark all current messages read"). */
  findThread(id: number) {
    return this.prisma.messageThread.findUnique({ where: { id } });
  }

  /**
   * Unread counts for a user across the given threads, in ONE query. Unread = messages with id greater
   * than the per-thread read watermark (lastReadMsgId; NULL ⇒ never read ⇒ count everything via
   * COALESCE(...,0)). Uses the Message(threadId,id) index for the range scan. Returns a Map keyed by
   * threadId; threads with zero unread are present with value 0 (LEFT JOIN guarantees one row each).
   */
  async countUnreadByThread(
    userId: number,
    threadIds: number[],
  ): Promise<Map<number, number>> {
    if (threadIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ threadId: number; unread: number }>>`
      SELECT tp."threadId" AS "threadId", COUNT(m.id)::int AS "unread"
      FROM "ThreadParticipant" tp
      LEFT JOIN "Message" m
        ON m."threadId" = tp."threadId"
       AND m.id > COALESCE(tp."lastReadMsgId", 0)
      WHERE tp."userId" = ${userId}
        AND tp."leftAt" IS NULL
        AND tp."threadId" IN (${Prisma.join(threadIds)})
      GROUP BY tp."threadId"
    `;
    return new Map(rows.map((r) => [r.threadId, r.unread]));
  }
}
