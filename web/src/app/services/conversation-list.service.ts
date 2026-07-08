import { Injectable, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { UserService } from './user.service';
import { WebsocketService } from './websocket.service';
import { ConversationItem, User } from './model';
import { toFriendlyHttpError } from './http-error';

/**
 * Shared conversation-list store: the single client-side source of truth for the chat list, so that
 * the list view, thread-open (mark-read), and realtime SSE updates all mutate the same signal.
 *
 * - `items` / `status` / `error`: the list state, loaded from `query-thread/valid` (server-authoritative;
 *   sorted recent-first by the backend). The thread-list component is a thin view over these.
 * - `openThreadId`: the conversation currently being viewed. Drives two things: the active-row
 *   highlight, and the "don't badge a thread the user is already looking at" rule in onNewMessage.
 * - `open(id)` / `close()`: set/clear the open thread; opening fires mark-read on the server and
 *   optimistically clears the local unread badge (the two converge once the server responds).
 * - `onNewMessage(msg)`: applies an inbound NEW_MESSAGE SSE frame — refresh preview/at/senderId,
 *   bump the thread to the top, and increment unread unless it's the open thread.
 *
 * The list preview derivation (previewFor) mirrors the backend derivePreview() — kept in sync manually.
 */

/** Load status as a const object so it can be used as a VALUE in templates (LoadStatus.READY) and as a TYPE. */
export const ConversationLoadStatus = {
  LOADING: 'LOADING',
  READY: 'READY',
  ERROR: 'ERROR',
} as const;
export type ConversationLoadStatus =
  (typeof ConversationLoadStatus)[keyof typeof ConversationLoadStatus];

@Injectable({ providedIn: 'root' })
export class ConversationListService {
  private readonly userService = inject(UserService);
  private readonly transloco = inject(TranslocoService);
  private readonly ws = inject(WebsocketService);

  private readonly _items = signal<ConversationItem[]>([]);
  readonly items = this._items.asReadonly();

  private readonly _status = signal<ConversationLoadStatus>('LOADING');
  readonly status = this._status.asReadonly();

  private readonly _error = signal('');
  readonly error = this._error.asReadonly();

  private readonly _openThreadId = signal<number | undefined>(undefined);
  readonly openThreadId = this._openThreadId.asReadonly();

  /** A thread promoted to index 0 on the most recent update (and to be FLIP-animated by the list),
   *  or null. Set in applyItems when a top-insert was requested; the list clears it after animating. */
  private readonly _topInserted = signal<number | null>(null);
  readonly topInserted = this._topInserted.asReadonly();
  /** Explicit thread to force-top on the next applyItems (set by markTopOnNextUpdate). */
  private _pendingTopId: number | null = null;
  /** When true, the next applyItems promotes the first newly-appearing thread (set by
   *  markTopOnNextNewThread, for events where the new threadId is unknown, e.g. FRIEND_APPROVED). */
  private _topNextNew = false;

  /** Per-thread high-water-mark of the newest message id applied via onNewMessage. Guards against SSE
   *  redelivery (e.g. a frame duplicated across a reconnect) double-bumping the unread badge: if an
   *  inbound event's id isn't strictly newer than the last one applied for that thread, it's discarded
   *  before touching the list. BigInt ids are monotonic same-length numeric strings per thread, so
   *  lexicographic compare on equal length is exact (mirrors SomsSecureStore.advanceCursor). Not seeded
   *  from the loaded list (items carry lastReadMsgId, not lastMessageId) — so the first live event after
   *  a reload passes, which is correct (it IS new to the in-memory state); only same/older duplicates
   *  are blocked. */
  private readonly lastSeenMsgId = new Map<number, string>();

  constructor() {
    // Multi-device sync for per-user thread settings (mute/pin/clear): the server fans a THREAD_META
    // frame to the caller's OTHER connections on each change, so this device patches the affected row
    // and re-sorts without a full reload. Mirrors how onReadCursor keeps the unread badge in sync.
    this.ws.eventSubject
      .pipe(filter((m) => m.event === 'THREAD_META'))
      .subscribe((m) => {
        const d = (m.data ?? {}) as {
          threadId?: number;
          muted?: boolean;
          pinned?: boolean;
          pinnedAt?: number | null;
          clearedAt?: number | null;
          alias?: string | null;
        };
        if (d.threadId === undefined) return;
        this.applyThreadMeta(d.threadId, {
          muted: d.muted,
          pinned: d.pinned,
          pinnedAt: d.pinnedAt,
          clearedAt: d.clearedAt,
          alias: d.alias,
        });
      });
  }

  /** Patch per-user thread metadata (mute/pin/clear/block) on a row, then re-sort so pin/unpin reorders
   *  it live. Only defined fields are applied. Called from the THREAD_META SSE handler (multi-device)
   *  and from local optimistic actions (mute/pin toggle, block/unblock). */
  applyThreadMeta(
    threadId: number,
    patch: {
      muted?: boolean;
      pinned?: boolean;
      pinnedAt?: number | null;
      clearedAt?: number | null;
      blocked?: boolean;
      alias?: string | null;
    },
  ): void {
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === threadId);
      if (idx === -1) return list;
      const next = list.slice();
      next[idx] = { ...next[idx], ...patch };
      next.sort(byPinRank);
      return next;
    });
  }

  /** Fetch the conversation list from the server (authoritative state). */
  load() {
    this._status.set('LOADING');
    this._error.set('');
    // Page through the full thread set (query-thread/valid is @Max(50) per request) so client-side
    // folder filtering sees every conversation, not just the first page.
    this.userService.queryAllUserThreads().subscribe({
      next: (items) => this.applyItems(items),
      error: (err) => {
        this._error.set(toFriendlyHttpError(err, this.transloco.translate('errors.networkError')));
        this._status.set('ERROR');
      },
    });
  }

  /** Force `threadId` to index 0 on the next update and emit `topInserted` so the row animates in.
   *  Use when the caller knows the new id (group join SSE, group create response). */
  markTopOnNextUpdate(threadId: number): void {
    this._pendingTopId = threadId;
  }

  /** On the next update, promote the first newly-appearing thread to index 0 (and animate). Use when
   *  the caller cannot name the new id (FRIEND_APPROVED carries only the approver's userId). */
  markTopOnNextNewThread(): void {
    this._topNextNew = true;
  }

  /** Clear the `topInserted` pulse after the list has played its enter/FLIP animation. */
  clearTopInserted(): void {
    this._topInserted.set(null);
  }

  /** Resolve the ConversationItem for a thread the caller knows exists, waiting for a reload if it is
   *  not yet in the list (up to `timeoutMs`). Used by the join hero transition so the overlay's
   *  MessageThreadComponent can init its kernel with a real item instead of a hand-rolled stub. */
  async ensureThread(threadId: number, timeoutMs = 2000): Promise<ConversationItem | undefined> {
    const found = this._items().find((t) => t.threadId === threadId);
    if (found) return found;
    if (this._status() === 'READY') this.load();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      const it = this._items().find((t) => t.threadId === threadId);
      if (it) return it;
    }
    return undefined;
  }

  private applyItems(items: ConversationItem[]): void {
    // Server returns the page already pin-first-ordered, but sort defensively so the in-memory order
    // matches byPinRank exactly (the server and this comparator are kept in lockstep). An explicit
    // topId (markTopOnNextUpdate / markTopOnNextNewThread — a just-created/joined thread) is promoted
    // to index 0 ON TOP of the pin tier, so the user sees their new thread immediately.
    const sorted = [...items].sort(byPinRank);
    const topId = this.resolveTopId(items);
    const ordered = topId != null ? moveToTop(sorted, topId) : sorted;
    this._items.set(ordered);
    this._status.set('READY');
    if (topId != null) this._topInserted.set(topId);
  }

  /** Determine which thread (if any) to promote to index 0 on this update, consuming the pending
   *  flags. Priority: an explicit id (markTopOnNextUpdate), else the first newly-appearing thread
   *  when markTopOnNextNewThread was armed. */
  private resolveTopId(items: ConversationItem[]): number | undefined {
    let topId: number | undefined;
    if (this._pendingTopId != null && items.some((t) => t.threadId === this._pendingTopId)) {
      topId = this._pendingTopId;
    } else if (this._topNextNew) {
      const oldIds = new Set(this._items().map((t) => t.threadId));
      topId = items.find((t) => !oldIds.has(t.threadId))?.threadId;
    }
    this._pendingTopId = null;
    this._topNextNew = false;
    return topId;
  }

  /** Mark a thread as open (selected); advance its read cursor on the server and clear the badge
   *  optimistically. The HTTP mark-read is fired ONLY when the thread actually has unread messages:
   *  re-opening an already-read conversation (common — the user revisits a thread) is a server-side
   *  no-op whose request would still burn the per-IP throttle budget, so skipping it keeps mark-read
   *  volume proportional to real unread state. It also makes the call loop-proof — after the first fire
   *  clears the badge to 0, any re-entrant open() (effect re-run, close→reopen lag on mobile) is a
   *  no-op until a NEW_MESSAGE bumps unread again. The request is fire-and-forget: a 429 (rate-limited)
   *  or network failure is swallowed rather than surfacing as an uncaught HttpErrorResponse — the
   *  cursor converges on the next open() or the READ_CURSOR SSE echo. */
  open(threadId: number) {
    const prev = this._openThreadId();
    this._openThreadId.set(threadId);
    if (threadId === prev) return;
    const item = this._items().find((t) => t.threadId === threadId);
    if ((item?.unreadCount ?? 0) > 0) {
      this.clearUnread(threadId);
      this.userService.markRead({ threadId }).subscribe({
        error: () => {
          /* fire-and-forget — cursor converges on next open() / READ_CURSOR echo */
        },
      });
    }
    // Federated P2P peer: lazily refresh its avatar/name/bio if the peer's profile changed since the
    // stub was localized. Fire-and-forget (chat-open is never blocked); the server /revision probe is
    // cheap and re-pulls only when newer. The returned User flows into the item → header/avatar refresh.
    if (item && item.type === 'P2P' && item.peerUser.isForeigner) {
      this.userService.syncPeerProfile({ userId: item.peerUser.id }).subscribe({
        next: (res) => {
          if (res.code === 0 && res.data) this.updatePeerUser(threadId, res.data);
        },
        error: () => {
          /* best-effort — keep the cached profile on a transient peer outage */
        },
      });
    }
  }

  /** Replace a P2P item's peerUser (avatar/name/bio) after a federated profile sync. No-op for groups / absent
   *  items. The message header + avatar read peerUser via computed, so they refresh automatically. */
  updatePeerUser(threadId: number, user: User): void {
    this._items.update((list) =>
      list.map((t) => (t.threadId === threadId && t.type === 'P2P' ? { ...t, peerUser: user } : t)),
    );
  }

  /** Clear the open thread (chat-pane unmounted / mobile popup closed). */
  close() {
    this._openThreadId.set(undefined);
  }

  // ── live group-lifecycle updates (driven by GroupEventService from the GROUP_* SSE events) ──

  /** Apply a rename / avatar / description change from a GROUP_UPDATED event (live list + header refresh). */
  applyGroupUpdate(threadId: number, patch: { name?: string; description?: string; avatar?: string }): void {
    this._items.update((list) =>
      list.map((t) => {
        if (t.threadId !== threadId || !t.group) return t;
        const group = { ...t.group };
        if (patch.name !== undefined) group.name = patch.name;
        if (patch.description !== undefined) group.description = patch.description;
        if (patch.avatar !== undefined) group.avatar = patch.avatar;
        return { ...t, group };
      }),
    );
  }

  /** Apply my own role change from a GROUP_ROLE_CHANGED event targeting me. */
  applyRole(threadId: number, role: 'OWNER' | 'ADMIN' | 'MEMBER'): void {
    this._items.update((list) =>
      list.map((t) => (t.threadId === threadId ? { ...t, role } : t)),
    );
  }

  /** Drop a thread (self-kick / self-left). */
  removeThread(threadId: number): void {
    this._items.update((list) => list.filter((t) => t.threadId !== threadId));
    if (this._openThreadId() === threadId) this._openThreadId.set(undefined);
  }

  private clearUnread(threadId: number) {
    this._items.update((list) =>
      list.map((t) =>
        t.threadId === threadId ? { ...t, unreadCount: 0 } : t,
      ),
    );
  }

  /**
   * Apply an inbound NEW_MESSAGE SSE frame. Refreshes preview/at/senderId and bumps the thread to the
   * top; increments unread unless it is the currently-open thread OR the caller's own message (the
   * sender's own message is never unread — the server advances their read cursor on send, and this
   * mirrors that so a background tab's badge stays consistent). If the thread isn't in the list yet
   * (a brand-new conversation), reloads to fetch it from the server.
   */
  onNewMessage(msg: {
    threadId: number;
    id: string;
    contentType: string;
    content: string;
    creator: number;
    createdAt: number;
  }) {
    // High-water-mark guard: discard a redelivered/out-of-order event whose id isn't strictly newer
    // than the last one applied for this thread. SSE can re-emit a frame across a reconnect, and
    // without this the same message would double-bump the unread badge and overwrite the preview twice.
    const prev = this.lastSeenMsgId.get(msg.threadId);
    if (prev !== undefined && !isMsgNewer(msg.id, prev)) return;
    this.lastSeenMsgId.set(msg.threadId, msg.id);

    const preview = previewFor(msg.contentType, msg.content, this.transloco);
    const open = this._openThreadId();
    const mine = msg.creator === this.userService.sessionProfile()?.id;
    let existed = false;
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === msg.threadId);
      if (idx === -1) return list;
      existed = true;
      const item = list[idx];
      // Open thread → 0 (the user is viewing it). Own message in a closed thread → unchanged (the
      // sender's own message is never unread; the server advances their cursor on send). Someone
      // else's message in a closed thread → +1.
      let unread: number;
      if (open === msg.threadId) unread = 0;
      else if (mine) unread = item.unreadCount ?? 0;
      else unread = (item.unreadCount ?? 0) + 1;
      const updated: ConversationItem = {
        ...item,
        lastMessagePreview: preview,
        lastMessageAt: msg.createdAt,
        lastMessageSenderId: msg.creator,
        // A live NEW_MESSAGE can't resolve a group sender's display name cheaply, so drop any stale
        // name on group threads (own messages prefix "You:" via senderId===me; incoming go bare until
        // the next full reload re-hydrates the name). P2P names are never used by the preview.
        lastMessageSenderName:
          item.type === 'GROUP' ? null : item.lastMessageSenderName,
        unreadCount: unread,
      };
      // Re-sort by pin rank instead of unconditionally unshifting to index 0: a new message must NOT
      // displace a pinned thread (pinned stay top; the updated thread rises only to the top of its
      // tier — pinned if pinned, else the head of the unpinned tier).
      const next = list.slice();
      next[idx] = updated;
      next.sort(byPinRank);
      return next;
    });
    if (!existed) this.load();
  }
}

/** Strict "is `id` newer than `prevId`" — BigInt message ids are monotonic same-length numeric
 *  strings within a thread, so longer = newer; equal length → lexicographic. Mirrors the Kotlin
 *  `SomsSecureStore.advanceCursor` comparison so client and native agree on ordering. */
function isMsgNewer(id: string, prevId: string): boolean {
  return id.length > prevId.length || (id.length === prevId.length && id > prevId);
}

/** Return a new array with the first item matching `threadId` moved to index 0 (no-op if absent or
 *  already first). Used by applyItems to force-top a just-joined/created thread. */
function moveToTop<T extends { threadId: number }>(items: T[], threadId: number): T[] {
  const idx = items.findIndex((t) => t.threadId === threadId);
  if (idx <= 0) return items;
  const next = items.slice();
  const [moved] = next.splice(idx, 1);
  next.unshift(moved);
  return next;
}

/**
 * Pin-aware conversation-list rank comparator — the SINGLE source of truth for client-side ordering,
 * kept in lockstep with the backend's query-thread/valid ORDER BY. Pinned tier first (most-recently-
 * pinned first via pinnedAt desc); then unpinned recent-first by lastMessageAt; empty threads sink;
 * threadId breaks ties deterministically. Used by applyItems (reload), onNewMessage (live bump), and
 * applyThreadMeta (pin/unpin reorder).
 */
function byPinRank(a: ConversationItem, b: ConversationItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned) {
    const ta = a.pinnedAt ?? -Infinity;
    const tb = b.pinnedAt ?? -Infinity;
    return tb - ta || a.threadId - b.threadId;
  }
  const la = a.lastMessageAt ?? -Infinity;
  const lb = b.lastMessageAt ?? -Infinity;
  return lb - la || a.threadId - b.threadId;
}

/** Derive the short list preview by content type — mirrors backend derivePreview (keep in sync). The
 *  tag strings are localized via `t`; the backend's own denormalized preview is English (a separate,
 *  backend-side i18n concern), so this only localizes live/client-derived previews. */
export function previewFor(contentType: string, content: string, t: { translate: (k: string) => string }): string {
  switch (contentType) {
    case 'PURE_TEXT':
      return content.replace(/\s+/g, ' ').trim().slice(0, 200);
    case 'IMAGE':
      return t.translate('chat.preview.photo');
    case 'INVITE':
      return t.translate('chat.preview.invite');
    case 'VIDEO':
      return t.translate('chat.preview.video');
    case 'FILE':
      return t.translate('chat.preview.file');
    case 'AUDIO':
      return t.translate('chat.preview.voice');
    default:
      return content.slice(0, 200);
  }
}
