import { Injectable, inject, signal } from '@angular/core';
import { UserService } from './user.service';
import { ConversationItem } from './model';

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
    // take:200 — folders filter over the full thread set, not just the first page.
    this.userService.queryUserThreadValid({ take: 200, skip: 0 }).subscribe({
      next: (res) => {
        if (res.code === 0) {
          this._items.set(res.data ?? []);
          this._status.set('READY');
        } else {
          this._error.set(res.message || 'Failed to load chats');
          this._status.set('ERROR');
        }
      },
      error: () => {
        this._error.set('Network error, please retry');
        this._status.set('ERROR');
      },
    });
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

  private clearUnread(threadId: number) {
    this._items.update((list) =>
      list.map((t) =>
        t.threadId === threadId ? { ...t, unreadCount: 0 } : t,
      ),
    );
  }

  /**
   * Apply an inbound NEW_MESSAGE SSE frame. Refreshes preview/at/senderId and bumps the thread to the
   * top; increments unread unless it is the currently-open thread. If the thread isn't in the list yet
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
    let existed = false;
    this._items.update((list) => {
      const idx = list.findIndex((t) => t.threadId === msg.threadId);
      if (idx === -1) return list;
      existed = true;
      const item = list[idx];
      const updated: ConversationItem = {
        ...item,
        lastMessagePreview: preview,
        lastMessageAt: msg.createdAt,
        lastMessageSenderId: msg.creator,
        unreadCount: open === msg.threadId ? 0 : (item.unreadCount ?? 0) + 1,
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
