import { Injectable, inject, signal } from '@angular/core';
import { UserService } from './user.service';
import { ConversationItem } from './model';
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

  private readonly _items = signal<ConversationItem[]>([]);
  readonly items = this._items.asReadonly();

  private readonly _status = signal<ConversationLoadStatus>('LOADING');
  readonly status = this._status.asReadonly();

  private readonly _error = signal('');
  readonly error = this._error.asReadonly();

  private readonly _openThreadId = signal<number | undefined>(undefined);
  readonly openThreadId = this._openThreadId.asReadonly();

  /** Fetch the conversation list from the server (authoritative state). */
  load() {
    this._status.set('LOADING');
    this._error.set('');
    // Page through the full thread set (query-thread/valid is @Max(50) per request) so client-side
    // folder filtering sees every conversation, not just the first page.
    this.userService.queryAllUserThreads().subscribe({
      next: (items) => this.applyItems(items),
      error: (err) => {
        this._error.set(toFriendlyHttpError(err));
        this._status.set('ERROR');
      },
    });
  }

  private applyItems(items: ConversationItem[]): void {
    this._items.set(items);
    this._status.set('READY');
  }

  /** Mark a thread as open (selected); fire mark-read + clear its badge optimistically. */
  open(threadId: number) {
    const prev = this._openThreadId();
    this._openThreadId.set(threadId);
    if (threadId !== prev) {
      this.clearUnread(threadId);
      this.userService.markRead({ threadId }).subscribe();
    }
  }

  /** Clear the open thread (chat-pane unmounted / mobile popup closed). */
  close() {
    this._openThreadId.set(undefined);
  }

  // ── live group-lifecycle updates (driven by GroupEventService from the GROUP_* SSE events) ──

  /** Apply a rename / avatar change from a GROUP_UPDATED event (live list + header refresh). */
  applyGroupUpdate(threadId: number, patch: { name?: string; avatar?: string }): void {
    this._items.update((list) =>
      list.map((t) => {
        if (t.threadId !== threadId || !t.group) return t;
        const group = { ...t.group };
        if (patch.name !== undefined) group.name = patch.name;
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
    contentType: string;
    content: string;
    creator: number;
    createdAt: number;
  }) {
    const preview = previewFor(msg.contentType, msg.content);
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
      const next = list.slice();
      next.splice(idx, 1);
      next.unshift(updated);
      return next;
    });
    if (!existed) this.load();
  }
}

/** Derive the short list preview by content type — mirrors backend derivePreview (keep in sync). */
export function previewFor(contentType: string, content: string): string {
  switch (contentType) {
    case 'PURE_TEXT':
      return content.replace(/\s+/g, ' ').trim().slice(0, 200);
    case 'IMAGE':
      return '[Photo]';
    case 'INVITE':
      return '[Group invite]';
    case 'VIDEO':
      return '[Video]';
    case 'FILE':
      return '[File]';
    case 'AUDIO':
      return '[Voice message]';
    default:
      return content.slice(0, 200);
  }
}
