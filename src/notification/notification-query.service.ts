import { Injectable } from '@nestjs/common';
import { MessageService } from '../message/message.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { UserService } from '../user/user.service.js';
import { GroupService } from '../group/group.service.js';
import { UserBlockService } from '../user-block/user-block.service.js';

/**
 * One thread's unread state, in the minimal shape the notification paths need. This is the single
 * shape produced and consumed by:
 *  - POST /notifications/missed `{ summary: true }` (the FCM/WorkManager coalesced-notification HTTP
 *    response — the Android foreground service consumes `/events` directly now, so there is no longer a
 *    separate notification SSE feed)
 *  - the FGS / WorkManager / FCM notification renderers on-device (coalesced into ONE away-notification)
 *
 * `latestMessageId` is the per-thread dedup cursor (BigInt→string), shared with FCM so the background
 * paths never double-notify the same message.
 */
export interface UnreadThreadItem {
  threadId: number;
  type: 'P2P' | 'GROUP';
  displayName: string;
  unreadCount: number;
  latestMessageId: string | null;
}

/**
 * Builds the "what did I miss" unread-threads snapshot for a user — the reusable building block
 * behind the notification surface. Extracted from NotificationController.missed() so the SAME
 * hydration feeds both the HTTP poll endpoint and the live notification stream pushed to the
 * Android foreground service (and, via the send-message fan-out, kept current as new messages land).
 *
 * Reuses the existing per-thread unread query (`countUnreadByThread`, one SQL query over the
 * Message(threadId,id) index) and the P2P/group display-name resolution. Newest-unread-first.
 *
 * `providedIn`-less on purpose: declared as a provider in AppModule so both NotificationController
 * and MessageController (both declared in AppModule) can inject it.
 */
@Injectable()
export class NotificationQueryService {
  constructor(
    private readonly participantService: ThreadParticipantService,
    private readonly messageService: MessageService,
    private readonly userService: UserService,
    private readonly groupService: GroupService,
    private readonly userBlockService: UserBlockService,
  ) {}

  /** The current unread-threads snapshot for `userId`, newest lastMessageAt first. Empty array when
   *  the user has no active threads or none with unread. */
  async buildUnreadSnapshot(userId: number): Promise<UnreadThreadItem[]> {
    const list = await this.participantService.queryParticipants({
      where: { userId, leftAt: null },
      orderBy: { id: 'asc' },
      include: { thread: true },
    });
    if (list.length === 0) return [];

    const unread = await this.messageService.countUnreadByThread(
      userId,
      list.map((p) => p.threadId),
    );
    // Unread + NOT muted: muted conversations never trigger the away-notification (the user explicitly
    // silenced them). Unread is still tracked for the in-app list badge — this filter is about the
    // heads-up notification surface only.
    const withUnread = list.filter(
      (p) => !p.muted && (unread.get(p.threadId) ?? 0) > 0,
    );
    if (withUnread.length === 0) return [];

    // Most-recent unread first — the poller notifies about the freshest conversation.
    withUnread.sort((a, b) => {
      const ta = a.thread.lastMessageAt?.getTime() ?? -Infinity;
      const tb = b.thread.lastMessageAt?.getTime() ?? -Infinity;
      return tb - ta || a.threadId - b.threadId;
    });

    // Resolve P2P display names (the peer's User.name, falling back to account).
    const p2pThreadIds = withUnread
      .filter((p) => p.thread.type === 'P2P')
      .map((p) => p.threadId);
    const peers = await this.participantService.findP2PPeers(p2pThreadIds, userId);
    const peerUsers =
      p2pThreadIds.length > 0
        ? await this.userService.queryUsers({
            where: { id: { in: peers.map((p) => p.userId) }, isDeleted: false },
          })
        : [];
    const peerNameByThread = new Map<number, string>();
    peers.forEach((p) => {
      const u = peerUsers.find((u) => u.id === p.userId) as
        | (typeof peerUsers)[number]
        | undefined;
      peerNameByThread.set(p.threadId, u?.name || 'Unknown');
    });

    // Resolve GROUP display names (Group.name by threadId).
    const groupThreadIds = withUnread
      .filter((p) => p.thread.type === 'GROUP')
      .map((p) => p.threadId);
    const groupByThread =
      await this.groupService.resolveGroupUsersByThreadIds(groupThreadIds);
    const groupNameByThread = new Map<number, string>();
    groupByThread.forEach((gu, threadId) => groupNameByThread.set(threadId, gu.name));

    return withUnread.map((p) => ({
      threadId: p.threadId,
      type: p.thread.type,
      displayName:
        p.thread.type === 'P2P'
          ? (peerNameByThread.get(p.threadId) ?? 'Unknown')
          : (groupNameByThread.get(p.threadId) ?? 'Unknown'),
      unreadCount: unread.get(p.threadId) ?? 0,
      latestMessageId: p.thread.lastMessageSeq?.toString() ?? null,
    }));
  }

  /**
   * The paginated, message-based catch-up that supersedes the snapshot model for the in-app client.
   * Two modes (driven by `since`/`cursor`):
   *  - no `since` and no `cursor` → INIT: the newest message per thread (a bounded preview seed so every
   *    conversation has a latest message locally), `hasMore:false` (one shot).
   *  - `since` (first page, the client's local high-water-mark = newest message `createdAt`) or `cursor`
   *    (subsequent pages) → CATCH-UP: every message with `(createdAt, id) > bound`, time-ascending,
   *    paginated until `hasMore:false`. The client applies each message the same way it applies a live
   *    SSE `NEW_MESSAGE` (idempotent `[threadId,seq]` put), so SSE and catch-up are one apply path.
   *
   * The returned `messages` carry NO internal `id` (stripped by `attachMediaStatus`); `nextCursor` is an
   * opaque `base64url("<createdAtMs>:<id>")` the client echoes for the next page — `id` never leaves the
   * cursor, and the composite bound keeps paging strictly monotonic (no same-ms skip, no re-fetch loop).
   * Blocked creators are hidden (mirrors `queryMessages`'s P2P block filter).
   */
  async buildMissedPage(
    userId: number,
    opts: { since?: number | null; cursor?: string; take: number },
  ): Promise<{
    messages: Array<Omit<import('../prisma/generated/client.js').Message, 'id'> & { mediaStatus: 'ready' | 'failed'; sv: number }>;
    hasMore: boolean;
    nextCursor?: string;
  }> {
    const blocked = await this.userBlockService.blockedByMe(userId);
    const hideCreatorIds = blocked.size > 0 ? [...blocked] : [];

    let init: boolean;
    let sinceMs: number | null;
    let sinceId: bigint;
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      init = false;
      sinceMs = c.ms;
      sinceId = c.id;
    } else if (opts.since !== undefined && opts.since !== null) {
      init = false;
      sinceMs = opts.since;
      sinceId = 0n;
    } else {
      init = true;
      sinceMs = null;
      sinceId = 0n;
    }

    const rows = await this.messageService.missedMessages(userId, {
      init,
      sinceMs,
      sinceId,
      take: opts.take,
      hideCreatorIds,
    });

    if (init) {
      return { messages: await this.messageService.attachMediaStatus(rows), hasMore: false };
    }

    const hasMore = rows.length > opts.take;
    const pageRows = hasMore ? rows.slice(0, opts.take) : rows;
    const messages = await this.messageService.attachMediaStatus(pageRows);
    const nextCursor =
      hasMore && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1]) : undefined;
    return { messages, hasMore, nextCursor };
  }
}

/** Opaque pagination cursor: base64url("<createdAtMs>:<id>"). The internal BigInt `id` is NEVER exposed
 *  to clients as a field — it lives only inside this opaque token, where it disambiguates same-ms rows. */
function encodeCursor(m: { createdAt: Date; id: bigint }): string {
  return Buffer.from(`${m.createdAt.getTime()}:${m.id.toString()}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { ms: number; id: bigint } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf(':');
  if (sep < 0) throw new Error('invalid missed cursor');
  const ms = Number(decoded.slice(0, sep));
  const id = BigInt(decoded.slice(sep + 1));
  if (!Number.isFinite(ms)) throw new Error('invalid missed cursor');
  return { ms, id };
}
