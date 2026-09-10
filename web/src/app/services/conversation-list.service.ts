import { Injectable, inject } from '@angular/core';
import { UserService } from './user.service';
import { ThreadRepository } from './thread-store.service';
import { User } from './model';

export { ConversationLoadStatus } from './thread-store.service';

export interface UnreadEntryBoundary {
  threadId: number;
  serverLastReadSeq: number | null;
  localStableReadSeq: number | null;
  effectiveLastReadSeq: number | null;
  firstUnreadSeq: number;
  unreadCount: number;
  latestSeq: number;
}

/**
 * UI-layer facade over {@link ThreadRepository} — the thin view-state + write-orchestration layer for the
 * conversation list. The DB-layer data (items, load status, SSE handling, IDB persistence, boot-from-cache)
 * lives in {@link ThreadRepository}; this service is what the ~20 UI injectors talk to, so its public
 * signal/method surface is preserved byte-for-byte (zero call-site changes).
 *
 * What stays HERE (and ONLY here) is the WRITE orchestration the 3-tier contract forbids from the DB layer:
 *  - {@link open}: freezes the entry-time unread boundary before selecting the thread.
 *  - {@link markReadStable}: persists a viewport-dwelled position locally, then advances the server cursor.
 *  - {@link close}: clears the open thread and its session-only unread boundary.
 * The `markRead` write is the reason this facade exists: the DB layer never POSTs. Everything else delegates.
 */
@Injectable({ providedIn: 'root' })
export class ConversationListService {
  private readonly repo = inject(ThreadRepository);
  private readonly userService = inject(UserService);

  private readonly unreadEntryBoundaries = new Map<
    number,
    UnreadEntryBoundary
  >();

  constructor() {}

  // ── delegated data signals (the same references the repo owns) ──
  readonly items = this.repo.items;
  readonly threadSeq$ = this.repo.threadSeq$;
  readonly threadNotifications$ = this.repo.threadNotifications$;
  refreshBackgroundThreadFeed(userId: number): Promise<void> {
    return this.repo.refreshBackgroundThreadFeed(userId);
  }
  latestSeq(threadId: number): number | undefined {
    return this.repo.latestSeq(threadId);
  }
  readonly status = this.repo.status;
  readonly error = this.repo.error;
  readonly openThreadId = this.repo.openThreadId;
  readonly topInserted = this.repo.topInserted;

  /** Load (or force-refresh) the conversation list. Delegates to the repo's boot-from-cache + snapshot. */
  load(opts?: { force?: boolean }) {
    this.repo.load(opts);
  }

  /**
   * Mark a thread as open and freeze its entry-time unread boundary before any viewport dwell can advance the
   * read cursor. Opening alone does not mark anything read. The P2P/group metadata refreshes remain lazy.
   */
  open(threadId: number) {
    const prev = this.repo.openThreadId();
    if (threadId === prev) return;
    if (prev !== undefined) {
      this.unreadEntryBoundaries.delete(prev);
    }
    const item = this.repo.items().find((t) => t.threadId === threadId);
    const latestSeq = item?.lastMessageSeq;
    const unreadCount = item?.unreadCount ?? 0;
    if (unreadCount > 0 && typeof latestSeq === 'number') {
      const cursor = this.repo.readCursorState(threadId);
      const effectiveLastReadSeq =
        cursor.effectiveLastReadSeq ?? item?.lastReadSeq ?? null;
      // unreadCount excludes the caller's own messages, so it cannot locate the boundary.
      // The read HWM is the sole boundary authority; the scroller repairs a cleared-history miss.
      const firstUnreadSeq =
        effectiveLastReadSeq === null ? 0 : effectiveLastReadSeq + 1;
      if (firstUnreadSeq <= latestSeq) {
        this.unreadEntryBoundaries.set(threadId, {
          threadId,
          serverLastReadSeq: cursor.serverLastReadSeq,
          localStableReadSeq: cursor.localStableReadSeq,
          effectiveLastReadSeq,
          firstUnreadSeq,
          unreadCount,
          latestSeq,
        });
      }
    } else {
      this.unreadEntryBoundaries.delete(threadId);
    }
    void this.repo.setOpenThread(threadId);
  }

  /** Clear the open thread and discard its session-only entry boundary. An unstable (<500ms) viewport
   *  candidate lives only in MessageThread and is deliberately not flushed by navigation. */
  close() {
    const threadId = this.repo.openThreadId();
    void this.repo.setOpenThread(undefined);
    if (threadId !== undefined) this.unreadEntryBoundaries.delete(threadId);
  }

  /** Frozen unread boundary captured before this open session advances any local/server read cursor. */
  unreadEntryBoundary(threadId: number): UnreadEntryBoundary | undefined {
    return this.unreadEntryBoundaries.get(threadId);
  }

  /** Viewport dwell supplies throttled progress; submission has no pending-read barrier. */
  markReadStable(threadId: number, seq: number): void {
    if (!this.repo.commitLocalRead(threadId, seq)) return;
    this.userService.markRead({ threadId, localReadHwm: seq }).subscribe({
      error: (error) =>
        console.warn('[thread-feed] read submission failed', error),
    });
  }

  // ── delegated data mutations (the repo owns IDB write-through + SSE-derived ordering) ──

  /** Clear the `topInserted` pulse after the list has played its enter/FLIP animation. */
  clearTopInserted(): void {
    this.repo.clearTopInserted();
  }

  /** Force `threadId` to index 0 on the next update so the row animates in. */
  markTopOnNextUpdate(threadId: number): void {
    this.repo.markTopOnNextUpdate(threadId);
  }

  /** Patch per-user thread metadata (mute/pin/block/alias); called from local optimistic actions. */
  applyThreadMeta(
    threadId: number,
    patch: {
      muted?: boolean;
      pinned?: boolean;
      pinnedAt?: number | null;
      blocked?: boolean;
      friendshipActive?: boolean;
      conversationState?: 'ACTIVE' | 'READ_ONLY';
      alias?: string | null;
    },
  ): void {
    this.repo.applyThreadMeta(threadId, patch);
  }

  markAuthorityNamespaceInactive(threadId: number): void {
    this.repo.markAuthorityNamespaceInactive(threadId);
  }

  /** Replace a P2P item's peerUser (avatar/name/bio) after a profile sync. */
  updatePeerUser(threadId: number, user: User): void {
    this.repo.updatePeerUser(threadId, user);
  }

  /** Apply an optimistic local group metadata patch. Durable replacement arrives via state delta. */
  applyGroupUpdate(
    threadId: number,
    patch: {
      name?: string;
      description?: string;
      avatar?: string;
      dissolvedAt?: number | null;
    },
  ): void {
    this.repo.applyGroupUpdate(threadId, patch);
  }

  /** Drop a thread (self-kick / self-left / unfriend). */
  removeThread(threadId: number): Promise<void> {
    return this.repo.removeThread(threadId);
  }
}
