import { Injectable, inject } from '@angular/core';
import { UserService } from './user.service';
import { GroupService } from './group.service';
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
  private readonly groupService = inject(GroupService);

  /** Viewport-dwelled HWM pending until the conversation closes; later positions fold to MAX. */
  private readonly pendingMarkRead = new Map<number, number>();
  private readonly markReadInFlight = new Set<number>();
  private readonly unreadEntryBoundaries = new Map<
    number,
    UnreadEntryBoundary
  >();

  constructor() {}

  /** Send the pending maximum for one thread. A later stable read while this request is in flight only raises
   *  pending; completion drains that newest maximum. Failure keeps it queued for the next stable read/open. */
  private flushMarkRead(threadId: number): void {
    if (this.markReadInFlight.has(threadId)) return;
    const seq = this.pendingMarkRead.get(threadId);
    if (seq === undefined) return;
    this.pendingMarkRead.delete(threadId);
    this.markReadInFlight.add(threadId);
    this.repo.beginReadCommit(threadId);
    this.userService.markRead({ threadId, localReadHwm: seq }).subscribe({
      error: () => {
        this.markReadInFlight.delete(threadId);
        this.pendingMarkRead.set(
          threadId,
          Math.max(this.pendingMarkRead.get(threadId) ?? -1, seq),
        );
        this.repo.finishReadCommit(threadId);
      },
      complete: () => {
        this.markReadInFlight.delete(threadId);
        if (this.pendingMarkRead.has(threadId)) this.flushMarkRead(threadId);
      },
    });
  }

  // ── delegated data signals (the same references the repo owns) ──
  readonly items = this.repo.items;
  readonly threadSeq$ = this.repo.threadSeq$;
  latestSeq(threadId: number): number | undefined {
    return this.repo.latestSeq(threadId);
  }
  readonly status = this.repo.status;
  readonly error = this.repo.error;
  readonly openThreadId = this.repo.openThreadId;
  readonly readCommitPending = this.repo.readCommitPending;
  readonly topInserted = this.repo.topInserted;
  /** The one persisted ClientStateFeed cursor used by foreground and away consumers. */
  stateFeedCursor(): number {
    return this.userService.stateFeedCursor() ?? 0;
  }

  /** The per-thread dismiss-HWM map (sent as `threadHwms` on the away fetch). Delegates to the repo. */
  threadHwms(): Record<number, number> {
    return this.repo.threadHwms();
  }

  /** Record a per-thread dismiss (advance that thread's HWM to `seq`). Delegates to the repo. */
  recordThreadDismiss(c: { threadId: number; seq: number }): void {
    this.repo.recordThreadDismiss(c);
  }

  /** Clear every per-thread dismiss-HWM (focus-regain reset). Delegates to the repo. */
  clearThreadDismiss(): void {
    this.repo.clearThreadDismiss();
  }

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
      this.flushMarkRead(prev);
      this.unreadEntryBoundaries.delete(prev);
    }
    const item = this.repo.items().find((t) => t.threadId === threadId);
    const latestSeq = item?.lastMessageSeq;
    const unreadCount = item?.unreadCount ?? 0;
    if (unreadCount > 0 && typeof latestSeq === 'number') {
      const cursor = this.repo.readCursorState(threadId);
      const effectiveLastReadSeq =
        cursor.effectiveLastReadSeq ?? item?.lastReadSeq ?? null;
      // unreadCount is capped and excludes the caller's own messages, so it cannot locate the boundary.
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
    if (threadId !== undefined) this.flushMarkRead(threadId);
    void this.repo.setOpenThread(undefined);
    if (threadId !== undefined) this.unreadEntryBoundaries.delete(threadId);
  }

  /** Frozen unread boundary captured before this open session advances any local/server read cursor. */
  unreadEntryBoundary(threadId: number): UnreadEntryBoundary | undefined {
    return this.unreadEntryBoundaries.get(threadId);
  }

  /** Record a stable viewport HWM locally. It is sent only when this conversation closes/switches. */
  markReadStable(threadId: number, seq: number): void {
    if (this.repo.commitLocalRead(threadId, seq)) {
      this.pendingMarkRead.set(
        threadId,
        Math.max(this.pendingMarkRead.get(threadId) ?? -1, seq),
      );
    }
  }

  /** Send the highest locally committed fully-visible cursor now. In-flight requests still coalesce by MAX. */
  flushRead(threadId: number): void {
    this.flushMarkRead(threadId);
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

  /** Patch per-user thread metadata (mute/pin/clear/block/alias); called from local optimistic actions. */
  applyThreadMeta(
    threadId: number,
    patch: {
      muted?: boolean;
      pinned?: boolean;
      pinnedAt?: number | null;
      clearedSeq?: number | null;
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
