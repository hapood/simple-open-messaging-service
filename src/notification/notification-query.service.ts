import { Injectable } from '@nestjs/common';
import { MessageService } from '../message/message.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { UserService } from '../user/user.service.js';
import { GroupService } from '../group/group.service.js';
import { UserBlockService } from '../user-block/user-block.service.js';
import { AvatarStackService } from '../upload/avatar-stack.service.js';
import { pickLocale, type SupportedLocale } from '../common/locale.js';
import {
  composeMessageSummaryDescriptors,
  type NotificationDescriptor,
} from './notification-descriptor.js';

/**
 * One thread's missed-summary row — the data view consumed by the threadlist pre-warm (body hydration) AND
 * the input to the notification descriptor. The BigInt `id` is NEVER present — only per-thread `seq` + time.
 * `senderAvatarUrl` / `senderUserId` feed the stacked-avatar composite (P2P peer / GROUP group identity).
 */
export interface MissedThreadItem {
  threadId: number;
  type: 'P2P' | 'GROUP';
  displayName: string;
  unreadCount: number;
  /** Per-user mute flag — the away-notification filters unread+unmuted. */
  muted: boolean;
  /** The sender's avatar URL for the stacked icon (P2P peer avatar / GROUP group avatar); '' when none. */
  senderAvatarUrl: string;
  /** The sender's stable id for the icon's cache key + initial-letter color (P2P peer id / GROUP group id). */
  senderUserId: number;
  latestMessage:
    | {
        threadId: number;
        seq: number;
        contentType: string;
        content: string;
        creator: number;
        createdAt: number;
        mediaStatus: 'ready' | 'failed';
        sv: number;
      }
    | null;
}

/** The forward-pagination cursor — the client's last-accounted message, identified by its per-thread
 *  `(threadId, seq)` (uniquely resolves to one internal BigInt `id`, never exposed). Absent → snapshot. */
export interface MissedCursor {
  threadId: number;
  seq: number;
}

/**
 * Builds the "what did I miss" response for `POST /notifications/missed` — TWO views over ONE query:
 *  - `items[]`        — one row per thread (newest message body + unread + display name), the threadlist
 *                       pre-warm data source (now cursor-ordered);
 *  - `notifications[]`— the server-authored {@link NotificationDescriptor} list (localized title/body +
 *                       composited stacked-avatar icon) every notification renderer consumes verbatim.
 *
 * Cursor (replaces the old time-bound `since`): `{threadId, seq}` resolves to the internal message `id`,
 * then per-thread rows are filtered to `latestMessageId > cursorId` and ordered by `latestMessageId` ASC
 * (a strict total order — adjacent pages never overlap, so the same-ms ambiguity + the idempotent-apply
 * dedup it forced are gone). Absent cursor → a snapshot of the newest `take` threads (the background
 * away-notification path). `nextCursor` = the page's max-id item's cursor in both modes (the single
 * advancement rule).
 *
 * The BigInt `id` is NEVER exposed — `(threadId, seq)` is the only handle the client holds.
 *
 * `providedIn`-less on purpose: declared as a provider in MessageFanoutModule so NotificationController
 * (and historically MessageController) can inject it.
 */
@Injectable()
export class NotificationQueryService {
  constructor(
    private readonly participantService: ThreadParticipantService,
    private readonly messageService: MessageService,
    private readonly userService: UserService,
    private readonly groupService: GroupService,
    private readonly userBlockService: UserBlockService,
    private readonly avatarStack: AvatarStackService,
  ) {}

  /**
   * @param cursor the client's last-accounted message `(threadId, seq)`; absent → snapshot (newest `take`).
   * @param take   page size over threads.
   * @param acceptLanguage the `Accept-Language` header → locale for the descriptor copy.
   */
  async buildNotifyResponse(
    userId: number,
    opts: { cursor?: MissedCursor | null; take: number; acceptLanguage?: string | null },
  ): Promise<{
    items: MissedThreadItem[];
    hasMore: boolean;
    nextCursor: MissedCursor | null;
    notifications: NotificationDescriptor[];
  }> {
    const locale = pickLocale(opts.acceptLanguage);

    const list = await this.participantService.queryParticipants({
      where: { userId, leftAt: null },
      orderBy: { id: 'asc' },
      include: { thread: true },
    });
    if (list.length === 0) {
      return { items: [], hasMore: false, nextCursor: null, notifications: this.clearDescriptors(locale) };
    }

    const unread = await this.messageService.countUnreadByThread(
      userId,
      list.map((p) => p.threadId),
    );

    // Resolve the cursor (threadId, seq) → its internal BigInt id (one lookup). A cursor that can't resolve
    // (message gone — impossible for immutable messages, but defensive) degrades to a snapshot.
    let cursorId: bigint | null = null;
    if (opts.cursor) {
      const [resolved] = await this.messageService.findMessagesBySeqPairs([opts.cursor]);
      cursorId = resolved?.id ?? null;
    }

    // Latest message per thread. findMessagesBySeqPairs returns FULL rows (BigInt id intact); the id is the
    // strict-total-order key for cursor filtering + ordering. attachMediaStatus then strips id + attaches
    // mediaStatus/sv for the body view — both maps are keyed by threadId so hydrate joins them.
    const pairs = list
      .map((p) => ({ threadId: p.threadId, seq: p.thread.lastMessageSeq }))
      .filter((p): p is { threadId: number; seq: number } => p.seq != null && p.seq >= 0);
    const latestMsgs = pairs.length > 0 ? await this.messageService.findMessagesBySeqPairs(pairs) : [];
    const attached = await this.messageService.attachMediaStatus(latestMsgs);
    const latestIdByThread = new Map<number, bigint>();
    const creatorByThread = new Map<number, number>();
    for (const m of latestMsgs) {
      latestIdByThread.set(m.threadId, m.id);
      creatorByThread.set(m.threadId, m.creator);
    }
    const attachedByThread = new Map(attached.map((m) => [m.threadId, m]));

    // P2P block: the recipient never sees a blocked peer's messages, so a P2P thread whose latest message
    // is from a blocked creator is dropped from the summary (mirrors query-messages' hideCreatorIds P2P
    // filter — block is P2P-scoped; GROUP threads leave blocked members visible, WhatsApp neutral-ground).
    const blocked = await this.userBlockService.blockedByMe(userId);

    // Active = threads with a latest message (an empty thread has no cursor position and is not "missed"),
    // minus P2P-blocked latest senders.
    const active = list.filter(
      (p) =>
        latestIdByThread.has(p.threadId) &&
        !(p.thread.type === 'P2P' && blocked.has(creatorByThread.get(p.threadId) ?? -1)),
    );
    const cmpByIdAsc = (a: { threadId: number }, b: { threadId: number }) => {
      const ai = latestIdByThread.get(a.threadId)!;
      const bi = latestIdByThread.get(b.threadId)!;
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    };

    const take = Math.max(1, opts.take);
    let page: typeof active;
    let hasMore: boolean;
    if (cursorId !== null) {
      // Forward: threads whose latest message is strictly newer than the cursor, ASC by id.
      const forward = active.filter((p) => latestIdByThread.get(p.threadId)! > cursorId!).sort(cmpByIdAsc);
      hasMore = forward.length > take;
      page = forward.slice(0, take);
    } else {
      // Snapshot: the newest `take` threads (DESC), returned ASC for a uniform response order.
      const desc = active.slice().sort((a, b) => -cmpByIdAsc(a, b));
      hasMore = desc.length > take;
      page = desc.slice(0, take).sort(cmpByIdAsc);
    }

    // nextCursor = the page's max-id item's (threadId, seq) — the single advancement rule for both modes.
    // Null when the page is empty (caught up / nothing to show).
    let nextCursor: MissedCursor | null = null;
    if (page.length > 0) {
      const maxRow = page.reduce((mx, p) =>
        latestIdByThread.get(p.threadId)! > latestIdByThread.get(mx.threadId)! ? p : mx,
      );
      nextCursor = { threadId: maxRow.threadId, seq: maxRow.thread.lastMessageSeq ?? 0 };
    }

    const items = await this.hydrateItems(userId, page, unread, attachedByThread);

    // Descriptor: composite the stacked avatar from the unread+unmuted senders, then compose. The composer
    // filters unread+unmuted itself + folds the body; the icon is pre-computed here (it needs the sender
    // avatars the composer deliberately doesn't carry).
    const awaySenders = items
      .filter((i) => i.unreadCount > 0 && !i.muted)
      .map((i) => ({ avatarUrl: i.senderAvatarUrl, displayName: i.displayName, userId: i.senderUserId }));
    const iconUrl =
      awaySenders.length > 0 ? await this.avatarStack.composeStackedAvatar(awaySenders) : null;
    const notifications = composeMessageSummaryDescriptors(items, { locale, iconUrl, renotify: false });

    return { items, hasMore, nextCursor, notifications };
  }

  /** A `clear` descriptor (cancel the tagged notification) — emitted when there is nothing to summarize. */
  private clearDescriptors(locale: SupportedLocale): NotificationDescriptor[] {
    return composeMessageSummaryDescriptors([], { locale, iconUrl: null, renotify: false });
  }

  /** Resolve display names + sender avatar/id + the latest message body for one page of participant rows. */
  private async hydrateItems(
    userId: number,
    rows: Array<{
      threadId: number;
      muted: boolean;
      thread: {
        type: 'P2P' | 'GROUP';
        lastMessageSeq: number | null;
        lastMessageAt: Date | null;
      };
    }>,
    unread: Map<number, number>,
    attachedByThread: Map<number, AttachedMessage>,
  ): Promise<MissedThreadItem[]> {
    // P2P display name + sender = the peer user (id carries for the icon color hash + cache key).
    const p2pThreadIds = rows.filter((p) => p.thread.type === 'P2P').map((p) => p.threadId);
    const peers = await this.participantService.findP2PPeers(p2pThreadIds, userId);
    const peerUsers =
      p2pThreadIds.length > 0
        ? await this.userService.queryUsers({
            where: { id: { in: peers.map((p) => p.userId) }, isDeleted: false },
          })
        : [];
    const peerByThread = new Map<number, { name: string; avatar: string; id: number }>();
    peers.forEach((p) => {
      const u = peerUsers.find((u) => u.id === p.userId);
      if (u) peerByThread.set(p.threadId, { name: u.name || 'Unknown', avatar: u.avatar ?? '', id: u.id });
    });

    // GROUP display name + sender = the group identity row (id = the group's user id).
    const groupThreadIds = rows.filter((p) => p.thread.type === 'GROUP').map((p) => p.threadId);
    const groupByThread = await this.groupService.resolveGroupUsersByThreadIds(groupThreadIds);

    return rows.map((p) => {
      const m = attachedByThread.get(p.threadId);
      const peer = peerByThread.get(p.threadId);
      const group = groupByThread.get(p.threadId);
      return {
        threadId: p.threadId,
        type: p.thread.type,
        muted: p.muted,
        displayName:
          p.thread.type === 'P2P' ? (peer?.name ?? 'Unknown') : (group?.name ?? 'Unknown'),
        senderAvatarUrl: p.thread.type === 'P2P' ? (peer?.avatar ?? '') : (group?.avatar ?? ''),
        senderUserId: p.thread.type === 'P2P' ? (peer?.id ?? p.threadId) : (group?.id ?? p.threadId),
        unreadCount: unread.get(p.threadId) ?? 0,
        latestMessage: m
          ? {
              threadId: p.threadId,
              seq: m.seq,
              contentType: m.contentType,
              content: m.content,
              creator: m.creator,
              createdAt: m.createdAt instanceof Date ? m.createdAt.getTime() : m.createdAt,
              mediaStatus: m.mediaStatus,
              sv: m.sv,
            }
          : null,
      };
    });
  }
}

/** The id-stripped, mediaStatus-attached message row (the output of `MessageService.attachMediaStatus`).
 *  Only the fields hydrate reads are named; the real object (Omit<Message,'id'> & {mediaStatus,sv}) carries
 *  more, which TS structural typing accepts. */
type AttachedMessage = {
  threadId: number;
  seq: number;
  contentType: string;
  content: string;
  creator: number;
  createdAt: Date | number;
  mediaStatus: 'ready' | 'failed';
  sv: number;
};
