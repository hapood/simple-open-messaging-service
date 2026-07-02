import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { ContentType, Message, Prisma } from '../prisma/generated/client.js';

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
    try {
      return await this.prisma.$transaction(async (tx) => {
        const msg = await tx.message.create({
          data: {
            content,
            contentType: type,
            threadId,
            creator: userId,
            clientMessageId,
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
        return msg;
      });
    } catch (e) {
      if (
        clientMessageId !== undefined &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // Lost the concurrent-retry race: another request inserted this clientMessageId first. Return
        // theirs rather than surfacing the unique-violation.
        const winner = await this.prisma.message.findUnique({
          where: { clientMessageId },
        });
        if (winner !== null) return winner;
      }
      throw e;
    }
  }

  async queryMessages(threadId: number, params: Prisma.MessageFindManyArgs) {
    const data = await this.prisma.message.findMany({
      ...params,
      where: {
        threadId: threadId,
      },
    });
    return data;
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
