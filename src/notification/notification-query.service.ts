import { Injectable } from '@nestjs/common';
import { MessageService } from '../message/message.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { UserService } from '../user/user.service.js';
import { GroupService } from '../group/group.service.js';
import { UserBlockService } from '../user-block/user-block.service.js';
import { AvatarStackService } from '../upload/avatar-stack.service.js';
import { pickLocale, type SupportedLocale } from '../common/locale.js';
import { buildSummaryBody, buildSummaryTitle, actionLabel } from './notif-i18n.js';
import { AWAY_SUMMARY_TAG, type NotificationDescriptor } from './notification-descriptor.js';

/**
 * One thread's missed-summary row — the data view consumed by the threadlist pre-warm (body hydration). The
 * BigInt `id` is NEVER present — only per-thread `seq` + time. `senderAvatarUrl` / `senderUserId` are carried
 * for completeness (the threadlist preview does not render them — its avatars come from the conversation
 * snapshot).
 */
export interface MissedThreadItem {
  threadId: number;
  type: 'P2P' | 'GROUP';
  displayName: string;
  unreadCount: number;
  /** Per-user mute flag (the snapshot carries it for parity). */
  muted: boolean;
  /** The caller's per-thread read watermark (ThreadParticipant.lastReadSeq; null = never read). The
   *  threadlist merges this with its optimistic value (max) to derive the displayed unread count. */
  lastReadSeq: number | null;
  /** The sender's avatar URL (P2P peer avatar / GROUP group avatar); '' when none. */
  senderAvatarUrl: string;
  /** The sender's stable id (P2P peer id / GROUP group id). */
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

/** A message identified by its per-thread `(threadId, seq)` (the backend resolves it to the internal BigInt
 *  `id` it never exposes). The threadlist's high-water mark. */
export interface MissedCursor {
  threadId: number;
  seq: number;
}

/**
 * The two POST /notifications/* endpoints, separated by purpose:
 *  - {@link buildSummary} backs `POST /notifications/missed-summary` (the threadlist body pre-warm) — a
 *    DOUBLE-BOUNDARY `(from, to]` walk of per-thread latest bodies. `to` (the newest SSE signal) is PINNED so
 *    the walk converges; `from` is the high-water mark (advancing). Stable pagination + `to ≤ from` → no-op.
 *  - {@link buildNotifyResponse} backs `POST /notifications/missed` (away-notification renderers only) — a
 *    per-sender aggregation of the messages newer than `since` (the HWM), authored into ONE descriptor
 *    ("X, Y sent you N messages" / "999+" past the 1000-sample) + a composited stacked-avatar icon. One-shot,
 *    no pagination: the away surface is a current snapshot, replace-by-tag.
 *
 * The HWM is the SAME boundary for both (the newest message the threadlist has accounted for, ordered by the
 * backend's strict-total-order `id` — NEVER SSE arrival order, which can deliver out of sequence). The
 * threadlist owns + advances it; the renderer reads it (the IDB newest at background time).
 *
 * The BigInt `id` is NEVER exposed — `(threadId, seq)` is the only handle the client holds.
 *
 * `providedIn`-less on purpose: declared as a provider in MessageFanoutModule so NotificationController can
 * inject it.
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
   * Threadlist body pre-warm: per-thread latest body for threads whose latest-message id ∈ `(from, to]`.
   * @param from the high-water mark (exclusive lower bound); absent on first boot.
   * @param to   the newest SSE signal (inclusive upper bound) — pinned for the walk (stability).
   * @param take page size (threads).
   */
  async buildSummary(
    userId: number,
    opts: { from?: MissedCursor | null; to: MissedCursor; take: number },
  ): Promise<{ items: MissedThreadItem[]; hasMore: boolean; nextCursor: MissedCursor | null }> {
    const toId = await this.resolveId(opts.to);
    if (toId === null) return { items: [], hasMore: false, nextCursor: null }; // `to` unresolvable → no-op
    const fromId = opts.from ? await this.resolveId(opts.from) : null;
    // `to ≤ from`: SSE delivered a stale/out-of-order message → empty no-op (HWM unchanged).
    if (fromId !== null && toId <= fromId) return { items: [], hasMore: false, nextCursor: null };

    const ctx = await this.loadThreadContext(userId);
    // Threads whose latest-message id sits in the half-open range (fromId, toId].
    const inRange = ctx.active
      .filter((p) => {
        const id = ctx.latestIdByThread.get(p.threadId);
        if (id === undefined) return false;
        if (fromId !== null && id <= fromId) return false;
        return id <= toId;
      })
      .sort(ctx.cmpByIdAsc);
    const take = Math.max(1, opts.take);
    const hasMore = inRange.length > take;
    const page = inRange.slice(0, take);
    const items = await this.hydrateItems(userId, page, ctx.unread, ctx.attachedByThread);
    // nextCursor = the page's MAX-id item (advance `from` toward `to`); null once this page is the last.
    let nextCursor: MissedCursor | null = null;
    if (hasMore && page.length > 0) {
      const maxRow = page.reduce((mx, p) =>
        ctx.latestIdByThread.get(p.threadId)! > ctx.latestIdByThread.get(mx.threadId)! ? p : mx,
      );
      nextCursor = { threadId: maxRow.threadId, seq: maxRow.thread.lastMessageSeq ?? 0 };
    }
    return { items, hasMore, nextCursor };
  }

  /**
   * Away-notification summary: aggregate, per sender, the messages newer than `since` (the HWM), authored
   * into ONE descriptor. Samples the first 1000 by id (lean — creator + threadId only, no content); past
   * that the body shows the capped "999+". Returns `notifications[]` only (the renderer reads nothing else).
   * @param since the high-water mark (newest IDB message before backgrounding); absent → clear (first-ever).
   * @param acceptLanguage the `Accept-Language` header → locale for the copy.
   */
  async buildNotifyResponse(
    userId: number,
    opts: { since?: MissedCursor | null; acceptLanguage?: string | null },
  ): Promise<{ notifications: NotificationDescriptor[] }> {
    const locale = pickLocale(opts.acceptLanguage);
    // First-ever (no HWM yet) or unresolvable since → no baseline → clear (don't disturb).
    if (!opts.since) return { notifications: [this.clearDescriptor(locale)] };
    const sinceId = await this.resolveId(opts.since);
    if (sinceId === null) return { notifications: [this.clearDescriptor(locale)] };

    const blocked = await this.userBlockService.blockedByMe(userId);
    const { counts, overflow } = await this.messageService.senderCountsSince(
      userId,
      sinceId,
      1000,
      [...blocked],
    );
    if (counts.size === 0) return { notifications: [this.clearDescriptor(locale)] }; // nothing new → clear

    // Resolve sender display names + avatars (the icon + the folded body). Chronological order: the
    // aggregation rows are ordered by message id ASC, so the Map's insertion order = who messaged first.
    const orderedSenders = [...counts.keys()];
    const senderUsers = await this.userService.queryUsers({
      where: { id: { in: orderedSenders }, isDeleted: false },
    });
    const userById = new Map(senderUsers.map((u) => [u.id, u]));
    const name = (id: number) => userById.get(id)?.name || 'Unknown';
    const items = orderedSenders.map((id) => ({ displayName: name(id), unreadCount: counts.get(id) ?? 0 }));
    const body = buildSummaryBody(items, locale, overflow);
    const iconInputs = orderedSenders
      .slice(0, AvatarStackService.MAX_TILES)
      .map((id) => ({ avatarUrl: userById.get(id)?.avatar ?? '', displayName: name(id), userId: id }));
    const iconUrl =
      iconInputs.length > 0 ? await this.avatarStack.composeStackedAvatar(iconInputs) : null;
    // The new HWM target: the globally-newest message this summary covered (the upper bound of everything
    // aggregated above). `dismiss` is PURE frontend — it advances the client's away-HWM to this cursor + closes
    // the shade, so the next background fetch (`since` = new HWM) doesn't re-fire for these same messages. No
    // POST, no read-watermark change: lastReadSeq is untouched (the messages stay unread until the user opens
    // the thread). findNewestForUser is non-null here (counts.size > 0 ⇒ the user has messages).
    const newest = await this.messageService.findNewestForUser(userId);

    return {
      notifications: [
        {
          tag: AWAY_SUMMARY_TAG,
          kind: 'message-summary',
          title: buildSummaryTitle(locale),
          body,
          lang: locale,
          icon: iconUrl,
          renotify: true,
          // One summary-level action: dismiss (PURE frontend — advances the away-HWM to `data` + closes the
          // shade; never POSTed, never touches the read watermark). One action stays within Web Push's 2-action
          // mobile-Chrome cap; per-thread reply belongs to a future kind.
          actions: [{ id: 'dismiss', title: actionLabel('dismiss', locale) }],
          data: newest ? { threadId: newest.threadId, seq: newest.seq } : {},
        },
      ],
    };
  }

  /** Resolve a `(threadId, seq)` cursor to its internal BigInt id (one lookup); null when unresolved. */
  private async resolveId(cursor: MissedCursor): Promise<bigint | null> {
    const [m] = await this.messageService.findMessagesBySeqPairs([cursor]);
    return m?.id ?? null;
  }

  /** A `clear` descriptor — cancel the tagged away notification (nothing new / first-ever / unresolvable). */
  private clearDescriptor(locale: SupportedLocale): NotificationDescriptor {
    return {
      tag: AWAY_SUMMARY_TAG,
      kind: 'clear',
      title: '',
      body: '',
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
   * latest-message id (the strict-total-order key) + the id-stripped body + unread counts.
   */
  private async loadThreadContext(userId: number): Promise<{
    active: Array<{
      threadId: number;
      muted: boolean;
      lastReadSeq: number | null;
      thread: { type: 'P2P' | 'GROUP'; lastMessageSeq: number | null; lastMessageAt: Date | null };
    }>;
    latestIdByThread: Map<number, bigint>;
    attachedByThread: Map<number, AttachedMessage>;
    unread: Map<number, number>;
    cmpByIdAsc: (a: { threadId: number }, b: { threadId: number }) => number;
  }> {
    const list = await this.participantService.queryParticipants({
      where: { userId, leftAt: null },
      orderBy: { id: 'asc' },
      include: { thread: true },
    });
    const unread = await this.messageService.countUnreadByThread(
      userId,
      list.map((p) => p.threadId),
    );
    // Latest message per thread (BigInt id intact — the strict-total-order key).
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
    const blocked = await this.userBlockService.blockedByMe(userId);
    // Active = threads with a latest message, minus P2P-blocked latest senders.
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
    return { active, latestIdByThread, attachedByThread, unread, cmpByIdAsc };
  }

  /** Resolve display names + sender avatar/id + the latest message body for one page of participant rows. */
  private async hydrateItems(
    userId: number,
    rows: Array<{
      threadId: number;
      muted: boolean;
      lastReadSeq: number | null;
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
        lastReadSeq: p.lastReadSeq ?? null,
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
