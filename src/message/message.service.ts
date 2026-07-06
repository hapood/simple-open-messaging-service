import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { ContentType, Message, MessageThreadType, Prisma } from '../prisma/generated/client.js';

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
/** One message hit in a global-search result. The snippet is server-built (keyword-centered excerpt for
 *  PURE_TEXT, attachment name for FILE); the client highlights the keyword by splitting on it. */
export interface MessageSearchHit {
  id: string;
  threadId: number;
  snippet: string;
  contentType: ContentType;
  createdAt: Date;
  creatorName: string;
  threadDisplayName: string;
  threadAvatar: string;
  threadType: MessageThreadType;
}

/** One conversation/contact hit in a global-search result. `name` is already the display name (the
 *  caller's alias takes precedence over the real group/peer name), matching the conversation list. */
export interface ThreadSearchHit {
  threadId: number;
  type: MessageThreadType;
  name: string;
  avatar: string;
  lastMessageAt: Date | null;
}

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

  // ===== global cross-conversation search =====

  /**
   * Escape a user keyword for ILIKE: backslash-escape the pattern metacharacters `%` and `_` (and
   * backslash itself first) so a literal "50%" or "a_b" matches itself rather than acting as a
   * wildcard. Returns the escaped keyword WITHOUT the surrounding `%` — callers wrap it for a
   * contains query.
   */
  private escapeIlike(keyword: string): string {
    return keyword.replace(/\\/g, '\\\\').replace(/[%_]/g, (c) => '\\' + c);
  }

  /**
   * Server-built display snippet for a message hit. PURE_TEXT centers on the first case-insensitive
   * keyword occurrence with ~40 chars of context each side (ellipsis when truncated); FILE hits show
   * the attachment name verbatim (the name IS the matchable payload). The client highlights the
   * keyword by splitting the snippet on it.
   */
  private makeSearchSnippet(content: string, type: ContentType, keyword: string): string {
    if (type === ContentType.FILE) {
      try {
        const parsed = JSON.parse(content) as { name?: unknown };
        return typeof parsed.name === 'string' ? parsed.name : content.slice(0, 120);
      } catch {
        return content.slice(0, 120);
      }
    }
    const lower = content.toLowerCase();
    const idx = lower.indexOf(keyword.toLowerCase());
    const CTX = 40;
    if (idx < 0) return content.slice(0, CTX * 2);
    const start = Math.max(0, idx - CTX);
    const end = Math.min(content.length, idx + keyword.length + CTX);
    return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
  }

  /**
   * Message wing of global search. Scans every thread the caller actively participates in for
   * PURE_TEXT bodies or FILE attachment names containing `keyword` (case-insensitive), re-applying the
   * caller's clearedAt watermark and block list (mirroring query-messages). Keyset-paginated by id
   * descending (lastMsgId cursor); take+1 probes hasMore.
   *
   * One query joins everything needed to render a row — sender display name, and the thread's display
   * name + avatar + type — using COALESCE(tp.alias, <group name | peer name>) so the result matches
   * the conversation list's display-name rule. The CASE over contentType keeps the jsonb cast (FILE
   * name) off PURE_TEXT rows: Postgres evaluates only the matching THEN, so a non-JSON body never
   * reaches the cast. The trigram GIN index backs the PURE_TEXT branch; FILE rows re-check without it
   * (a small subset — see migration 20260706140000_search_trigram).
   */
  async searchMessagesGlobal(
    userId: number,
    keyword: string,
    take: number,
    lastMsgId?: bigint,
  ): Promise<{ hits: MessageSearchHit[]; hasMore: boolean }> {
    const kw = `%${this.escapeIlike(keyword)}%`;
    const cursor = lastMsgId ?? null;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: bigint;
        threadId: number;
        content: string;
        contentType: ContentType;
        createdAt: Date;
        creatorName: string | null;
        threadDisplayName: string | null;
        threadAvatar: string | null;
        threadType: MessageThreadType;
      }>
    >`
      SELECT m.id, m."threadId", m.content, m."contentType", m."createdAt",
             sender_ue.name AS "creatorName",
             COALESCE(tp.alias,
               CASE m_thread.type
                 WHEN 'GROUP' THEN g.name
                 WHEN 'P2P' THEN peer_ue.name
               END
             ) AS "threadDisplayName",
             CASE m_thread.type
               WHEN 'GROUP' THEN g.avatar
               WHEN 'P2P' THEN peer_ue.avatar
             END AS "threadAvatar",
             m_thread.type AS "threadType"
      FROM "Message" m
      JOIN "MessageThread" m_thread ON m_thread.id = m."threadId"
      JOIN "ThreadParticipant" tp ON tp."threadId" = m."threadId" AND tp."userId" = ${userId}
      LEFT JOIN "UserBlock" ub ON ub."blockerId" = ${userId} AND ub."blockedId" = m.creator
      LEFT JOIN "User" sender ON sender.id = m.creator
      LEFT JOIN "UserExtra" sender_ue ON sender_ue.id = sender."userExtraId"
      LEFT JOIN "Group" g ON g."threadId" = m."threadId" AND m_thread.type = 'GROUP'
      LEFT JOIN "ThreadParticipant" peer_tp
        ON peer_tp."threadId" = m."threadId" AND peer_tp."userId" <> ${userId}
        AND peer_tp."leftAt" IS NULL AND m_thread.type = 'P2P'
      LEFT JOIN "User" peer_u ON peer_u.id = peer_tp."userId"
      LEFT JOIN "UserExtra" peer_ue ON peer_ue.id = peer_u."userExtraId"
      WHERE tp."leftAt" IS NULL
        AND ub.id IS NULL
        AND m."isDeleted" = false
        AND m."createdAt" > COALESCE(tp."clearedAt", '1970-01-01'::timestamp)
        AND CASE m."contentType"
          WHEN 'PURE_TEXT' THEN m.content ILIKE ${kw}
          WHEN 'FILE' THEN (m.content::jsonb->>'name') ILIKE ${kw}
          ELSE false
        END
        AND (${cursor}::bigint IS NULL OR m.id < ${cursor}::bigint)
      ORDER BY m.id DESC
      LIMIT ${take + 1}
    `;

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const hits: MessageSearchHit[] = page.map((r) => ({
      id: r.id.toString(),
      threadId: r.threadId,
      snippet: this.makeSearchSnippet(r.content, r.contentType, keyword),
      contentType: r.contentType,
      createdAt: r.createdAt,
      creatorName: r.creatorName ?? '',
      threadDisplayName: r.threadDisplayName ?? '',
      threadAvatar: r.threadAvatar ?? '',
      threadType: r.threadType,
    }));
    return { hits, hasMore };
  }

  /**
   * Conversation/contact wing of global search. Matches the caller's active threads whose display
   * name (alias if set, else the group name / P2P peer name) contains `keyword`. UNION of GROUP and
   * P2P wings, recent-first by the thread's last-message time. `name` is already the display name
   * (alias precedence), matching the conversation list — the client renders it as-is.
   */
  async searchThreadsGlobal(
    userId: number,
    keyword: string,
    take: number,
  ): Promise<ThreadSearchHit[]> {
    const kw = `%${this.escapeIlike(keyword)}%`;
    const rows = await this.prisma.$queryRaw<
      Array<{
        threadId: number;
        type: MessageThreadType;
        name: string;
        avatar: string | null;
        lastMessageAt: Date | null;
      }>
    >`
      SELECT * FROM (
        SELECT t.id AS "threadId", 'GROUP'::text AS type,
               COALESCE(tp.alias, g.name) AS name, g.avatar, t."lastMessageAt"
          FROM "ThreadParticipant" tp
          JOIN "MessageThread" t ON t.id = tp."threadId"
          JOIN "Group" g ON g."threadId" = t.id
         WHERE tp."userId" = ${userId} AND tp."leftAt" IS NULL AND t.type = 'GROUP'
           AND (g.name ILIKE ${kw} OR tp.alias ILIKE ${kw})
        UNION ALL
        SELECT t.id, 'P2P'::text, COALESCE(tp.alias, peer_ue.name), peer_ue.avatar, t."lastMessageAt"
          FROM "ThreadParticipant" tp
          JOIN "MessageThread" t ON t.id = tp."threadId"
          JOIN "ThreadParticipant" peer_tp
            ON peer_tp."threadId" = t.id AND peer_tp."userId" <> ${userId} AND peer_tp."leftAt" IS NULL
          JOIN "User" peer_u ON peer_u.id = peer_tp."userId"
          JOIN "UserExtra" peer_ue ON peer_ue.id = peer_u."userExtraId"
         WHERE tp."userId" = ${userId} AND tp."leftAt" IS NULL AND t.type = 'P2P'
           AND (peer_ue.name ILIKE ${kw} OR tp.alias ILIKE ${kw})
      ) AS u
      ORDER BY "lastMessageAt" DESC NULLS LAST
      LIMIT ${take}
    `;
    return rows.map((r) => ({
      threadId: r.threadId,
      type: r.type,
      name: r.name,
      avatar: r.avatar ?? '',
      lastMessageAt: r.lastMessageAt,
    }));
  }
}
