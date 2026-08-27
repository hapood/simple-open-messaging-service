import { Injectable } from '@nestjs/common';
import {
  MessageService,
  type AwayNotificationMessage,
  type UnreadMentionState,
} from '../message/message.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { UserService } from '../user/user.service.js';
import { GroupService } from '../group/group.service.js';
import { derivePreview } from '../message/message.service.js';
import { pickLocale, type SupportedLocale } from '../common/locale.js';
import {
  buildSummaryBody,
  buildSummaryTitle,
  buildPrivateBody,
  buildMentionTitle,
  actionLabel,
} from './notif-i18n.js';
import {
  AWAY_SUMMARY_TAG,
  type NotificationDescriptor,
} from './notification-descriptor.js';

/**
 * One thread's catch-up row — the data view consumed by the threadlist pre-warm (body hydration). The
 * BigInt `id` is NEVER present — only per-thread `seq` + time. `senderAvatarUrl` / `senderUserId` are carried
 * for completeness (the threadlist preview does not render them — its avatars come from the conversation
 * snapshot).
 */
export interface ThreadCatchUpItem {
  threadId: number;
  type: 'P2P' | 'GROUP';
  displayName: string;
  unreadCount: number;
  /** Distinct semantic mention kinds in the caller's unread range. */
  mentionUnread: UnreadMentionState;
  /** Per-user mute flag (the snapshot carries it for parity). */
  muted: boolean;
  /** The caller's server-confirmed per-thread read watermark (null = never read). */
  lastReadSeq: number | null;
  /** The sender's avatar URL (P2P peer avatar / GROUP group avatar); '' when none. */
  senderAvatarUrl: string;
  /** The sender's stable id (P2P peer id / GROUP group id). */
  senderUserId: number;
  latestMessage: {
    threadId: number;
    seq: number;
    contentType: string;
    content: string;
    creator: { account: string; domain: string } | null;
    createdAt: Date;
    mediaStatus: 'ready' | 'failed';
    sv: number;
  } | null;
}

/**
 * Shared hydration/read model behind the message-feed catch-up and notification-feed presentation layers.
 * Durable discovery and pagination live in their feed services; this class resolves current visibility,
 * unread attention, latest-message bodies and localized notification descriptors.
 */
@Injectable()
export class NotificationQueryService {
  constructor(
    private readonly participantService: ThreadParticipantService,
    private readonly messageService: MessageService,
    private readonly userService: UserService,
    private readonly groupService: GroupService,
  ) {}

  /** Hydrate feed-discovered threads with the current list preview and authoritative read state. The feed
   * owns discovery/order; this read model owns visibility, unread and presentation data. */
  async hydrateCatchUpThreads(
    userId: number,
    changes: Array<{ threadId: number; messageEndSeq: number }>,
  ): Promise<ThreadCatchUpItem[]> {
    if (changes.length === 0) return [];
    const threadIds = changes.map((change) => change.threadId);
    const ctx = await this.loadThreadContext(
      userId,
      threadIds,
      new Map(changes.map((change) => [change.threadId, change.messageEndSeq])),
      true,
    );
    const byId = new Map(ctx.active.map((row) => [row.threadId, row]));
    const rows = threadIds
      .map((threadId) => byId.get(threadId))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    const self = await this.userService.findUniqueUser({ id: userId });
    const attention = self
      ? await this.messageService.unreadAttentionByThread(
          userId,
          self.account,
          rows.map((row) => row.threadId),
        )
      : new Map();
    return this.hydrateItems(
      userId,
      rows,
      new Map(
        [...attention].map(([threadId, state]) => [threadId, state.count]),
      ),
      ctx.attachedByThread,
      new Map(
        [...attention].map(([threadId, state]) => [threadId, state.mention]),
      ),
    );
  }

  /** Build current-unread descriptors for threads discovered from the per-user compacted message feed. */
  async buildFeedNotifyResponse(
    userId: number,
    threadIds: number[],
    opts: {
      previewMode?: 'message' | 'private';
      threadHwms?: Record<number, number>;
      acceptLanguage?: string | null;
    },
  ): Promise<{ notifications: NotificationDescriptor[] }> {
    const locale = pickLocale(opts.acceptLanguage);
    if (threadIds.length === 0)
      return { notifications: [this.clearDescriptor(locale)] };
    return {
      notifications: await this.threadDescriptors(
        userId,
        locale,
        opts.previewMode ?? 'message',
        opts.threadHwms,
        threadIds,
      ),
    };
  }

  /**
   * "thread" grouping — ONE descriptor per feed-discovered conversation. The client feed determines which
   * threads changed; the optional per-thread sequence HWM determines which messages remain notification-
   * worthy. Each result becomes its own card, grouped client-side by the per-thread `tag`.
   *
   * Count is derived from unread messages, or from the supplied sequence HWM when the client previously
   * dismissed that thread. A thread whose final count is 0 is dropped.
   * `data.seq` = the thread's latest new seq — the client's per-thread dismiss target (records it in memory on
   * dismiss; advances only on dismiss; cleared on foreground). `kind:'thread-message'` discriminates the
   * render path (#5). `icon: null` (no per-thread avatar composition — resource-friendly). Returns `[]` when
   * nothing is new (the client clears all `soms-thread-*` notifications).
   */
  private async threadDescriptors(
    userId: number,
    locale: SupportedLocale,
    previewMode: 'message' | 'private',
    threadHwms?: Record<number, number>,
    threadIds?: number[],
  ): Promise<NotificationDescriptor[]> {
    const hiddenCreators = [userId];
    // Query A: threads with new LIVE messages since the global HWM — {count, latestSeq}, newest-first, capped.
    const self = await this.userService.findUniqueUser({ id: userId });
    const buckets = self
      ? await this.messageService.awayAttentionByThread(
          userId,
          self.account,
          THREAD_NOTIF_CAP,
          threadHwms ?? {},
          hiddenCreators,
          1000,
          threadIds,
        )
      : new Map();
    if (buckets.size === 0) return []; // nothing new → client clears all soms-thread-* notifications

    // Query B (ONE batched query): for each thread the client dismissed (in threadHwms), count since its HWM.
    // Threads not dismissed keep Query A's cumulative-since-foreground count.
    const counts = new Map(
      [...buckets].map(([tid, state]) => [tid, state.count]),
    );

    // Drop count-0 (dismissed with no new) BEFORE hydrating, then hydrate names SCOPED to the visible threads
    // only (not all the user's threads — loadThreadContext takes the id list).
    const visibleIds = [...counts.entries()]
      .filter(([, c]) => c > 0)
      .map(([tid]) => tid);
    if (visibleIds.length === 0) return [];
    const ctx = await this.loadThreadContext(userId, visibleIds);
    const rows = ctx.active.sort((a, b) => ctx.cmpByIdAsc(b, a)); // newest conversation first
    const items = await this.hydrateItems(
      userId,
      rows,
      counts,
      ctx.attachedByThread,
    );
    const previews: Map<number, AwayNotificationMessage[]> =
      previewMode === 'message'
        ? await this.messageService.awayNotificationMessages(
            userId,
            visibleIds,
            threadHwms ?? {},
            hiddenCreators,
            NOTIFICATION_MESSAGE_CAP,
          )
        : new Map();
    return items.map((it) => {
      const count = counts.get(it.threadId) ?? 0;
      const latestSeq =
        buckets.get(it.threadId)?.latestSeq ?? it.latestMessage?.seq ?? 0;
      const hasMention = (buckets.get(it.threadId)?.mention.length ?? 0) > 0;
      return {
        tag: `soms-thread-${it.threadId}`,
        kind: 'thread-message',
        title:
          previewMode === 'private'
            ? buildSummaryTitle(locale)
            : hasMention
              ? buildMentionTitle(locale)
              : it.displayName,
        body:
          previewMode === 'private'
            ? buildPrivateBody(locale)
            : buildSummaryBody(
                [{ displayName: it.displayName, unreadCount: count }],
                locale,
                count >= 1000,
              ),
        count,
        lang: locale,
        icon: null,
        renotify: true,
        ...(hasMention ? { attention: 'mention' as const } : {}),
        actions: [{ id: 'dismiss', title: actionLabel('dismiss', locale) }],
        ...(previewMode === 'message'
          ? {
              messages: (previews.get(it.threadId) ?? []).map((message) => ({
                seq: message.seq,
                sender: {
                  account: message.creatorAccount,
                  domain: message.creatorDomain,
                },
                senderName: message.senderName,
                text: derivePreview(message.contentType, message.content),
                timestamp: message.createdAt.getTime(),
              })),
            }
          : {}),
        previewMode,
        data: { threadId: it.threadId, seq: latestSeq },
      };
    });
  }

  /** A `clear` descriptor — cancel the tagged away notification (nothing new / first-ever / unresolvable). */
  private clearDescriptor(locale: SupportedLocale): NotificationDescriptor {
    return {
      tag: AWAY_SUMMARY_TAG,
      kind: 'clear',
      title: '',
      body: '',
      count: 0,
      lang: locale,
      icon: null,
      renotify: false,
      actions: [],
      data: {},
    };
  }

  /**
   * The shared per-thread context both the summary walk + (historically) the descriptor fold build on: the
   * user's active threads (membership + a latest message, minus P2P-blocked latest senders) with their
   * latest-message id (the strict-total-order key) + the id-stripped body + unread counts. Pass `threadIds`
   * to SCOPE every query to just those threads (the away-descriptor path hydrates only the ≤30 bucket threads,
   * not all of the user's threads).
   */
  private async loadThreadContext(
    userId: number,
    threadIds?: number[],
    previewSeqByThread?: Map<number, number>,
    includeRetained = false,
  ): Promise<{
    active: Array<{
      threadId: number;
      muted: boolean;
      blocked: boolean;
      lastReadSeq: number | null;
      thread: {
        type: 'P2P' | 'GROUP';
        lastMessageSeq: number | null;
        lastMessageAt: Date | null;
      };
    }>;
    latestIdByThread: Map<number, bigint>;
    attachedByThread: Map<number, AttachedMessage>;
    cmpByIdAsc: (a: { threadId: number }, b: { threadId: number }) => number;
  }> {
    const list = await this.participantService.queryParticipants({
      where: {
        userId,
        ...(includeRetained ? {} : { active: true }),
        ...(threadIds ? { threadId: { in: threadIds } } : {}),
      },
      orderBy: { id: 'asc' },
      include: { thread: true },
    });
    // Latest message per thread (BigInt id intact — the strict-total-order key).
    const pairs = list
      .map((p) => ({
        threadId: p.threadId,
        seq: previewSeqByThread?.get(p.threadId) ?? p.thread.lastMessageSeq,
      }))
      .filter(
        (p): p is { threadId: number; seq: number } =>
          p.seq != null && p.seq >= 0,
      );
    const identityMsgs =
      pairs.length > 0
        ? await this.messageService.findMessageIdentitiesBySeqPairs(pairs)
        : [];
    const latestVisibleMsgs =
      pairs.length > 0
        ? await this.messageService.findMessagesBySeqPairs(pairs)
        : [];
    const attached =
      await this.messageService.attachMediaStatus(latestVisibleMsgs);
    const latestIdByThread = new Map<number, bigint>();
    for (const m of identityMsgs) {
      latestIdByThread.set(m.threadId, m.id);
    }
    const attachedByThread = new Map(attached.map((m) => [m.threadId, m]));
    // Active = threads with a latest message whose local participant has not blocked delivery.
    const active = list.filter(
      (p) => !p.blocked && latestIdByThread.has(p.threadId),
    );
    const cmpByIdAsc = (a: { threadId: number }, b: { threadId: number }) => {
      const ai = latestIdByThread.get(a.threadId)!;
      const bi = latestIdByThread.get(b.threadId)!;
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    };
    return { active, latestIdByThread, attachedByThread, cmpByIdAsc };
  }

  /** Resolve display names + sender avatar/id + the latest message body for one page of participant rows. */
  private async hydrateItems(
    userId: number,
    rows: Array<{
      threadId: number;
      muted: boolean;
      blocked?: boolean;
      lastReadSeq: number | null;
      thread: {
        type: 'P2P' | 'GROUP';
        lastMessageSeq: number | null;
        lastMessageAt: Date | null;
      };
    }>,
    unread: Map<number, number>,
    attachedByThread: Map<number, AttachedMessage>,
    mentions: Map<number, UnreadMentionState> = new Map(),
  ): Promise<ThreadCatchUpItem[]> {
    // P2P display name + sender = the peer user (id carries for the icon color hash + cache key).
    const p2pThreadIds = rows
      .filter((p) => p.thread.type === 'P2P')
      .map((p) => p.threadId);
    const peers = await this.participantService.findP2PPeers(
      p2pThreadIds,
      userId,
    );
    const peerUsers =
      p2pThreadIds.length > 0
        ? await this.userService.queryUsers({
            where: {
              id: { in: peers.map((p) => p.userId) },
              availability: 'AVAILABLE',
            },
          })
        : [];
    const peerByThread = new Map<
      number,
      { name: string; avatar: string; id: number }
    >();
    peers.forEach((p) => {
      const u = peerUsers.find((u) => u.id === p.userId);
      if (u)
        peerByThread.set(p.threadId, {
          name: u.name || 'Unknown',
          avatar: u.avatar ?? '',
          id: u.id,
        });
    });

    // GROUP display name + sender = the group identity row (id = the group's user id).
    const groupThreadIds = rows
      .filter((p) => p.thread.type === 'GROUP')
      .map((p) => p.threadId);
    const groupByThread =
      await this.groupService.resolveGroupsByThreadIds(groupThreadIds);

    return rows.map((p) => {
      const m = attachedByThread.get(p.threadId);
      const peer = peerByThread.get(p.threadId);
      const group = groupByThread.get(p.threadId);
      return {
        threadId: p.threadId,
        type: p.thread.type,
        muted: p.muted,
        lastReadSeq: p.lastReadSeq ?? null,
        displayName:
          p.thread.type === 'P2P'
            ? (peer?.name ?? 'Unknown')
            : (group?.name ?? 'Unknown'),
        senderAvatarUrl:
          p.thread.type === 'P2P'
            ? (peer?.avatar ?? '')
            : (group?.avatar ?? ''),
        senderUserId:
          p.thread.type === 'P2P'
            ? (peer?.id ?? p.threadId)
            : (group?.id ?? p.threadId),
        unreadCount: unread.get(p.threadId) ?? 0,
        mentionUnread: mentions.get(p.threadId) ?? [],
        latestMessage: m
          ? {
              threadId: p.threadId,
              seq: m.seq,
              contentType: m.contentType,
              content: m.content,
              creator: m.creator,
              createdAt: m.createdAt,
              mediaStatus: m.mediaStatus,
              sv: m.sv,
            }
          : null,
      };
    });
  }
}

/** Cap on per-thread notification cards in "thread" grouping. Beyond this, threads with new messages get no
 *  card (rare — 30+ simultaneous unread conversations). Android bundles whatever is posted; the client owns
 *  the group summary. */
const THREAD_NOTIF_CAP = 30;
const NOTIFICATION_MESSAGE_CAP = 5;

/** The id-stripped, mediaStatus-attached message row (the output of `MessageService.attachMediaStatus`).
 *  Only the fields hydrate reads are named; the real object (Omit<Message,'id'> & {mediaStatus,sv}) carries
 *  more, which TS structural typing accepts. */
type AttachedMessage = {
  threadId: number;
  seq: number;
  contentType: string;
  content: string;
  creator: { account: string; domain: string } | null;
  createdAt: Date;
  mediaStatus: 'ready' | 'failed';
  sv: number;
};
