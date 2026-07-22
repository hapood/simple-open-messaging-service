import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UserService } from './user.service';
import { GroupService } from './group.service';
import { ThreadRepository } from './thread-store.service';
import { User } from './model';
import type { MissedCursor } from './notification-descriptor.model';

export { ConversationLoadStatus } from './thread-store.service';

/**
 * UI-layer facade over {@link ThreadRepository} — the thin view-state + write-orchestration layer for the
 * conversation list. The DB-layer data (items, load status, SSE handling, IDB persistence, boot-from-cache)
 * lives in {@link ThreadRepository}; this service is what the ~20 UI injectors talk to, so its public
 * signal/method surface is preserved byte-for-byte (zero call-site changes).
 *
 * What stays HERE (and ONLY here) is the WRITE orchestration the 3-tier contract forbids from the DB layer:
 *  - {@link open}: sets the open thread on the repo (for unread suppression), optimistically clears the
 *    badge, fires the `markRead` POST (a write — bypasses the DB layer), and nudges a peer-profile refresh.
 *  - {@link close}: clears the open thread + flushes any pending markRead.
 *  - the {@link openThreadMessage$} subscription (B1): when a NEW_MESSAGE lands in the open thread, advances
 *    the server read watermark — debounced + coalesced to the max seq so a burst = one POST.
 * The `markRead` write is the reason this facade exists: the DB layer never POSTs. Everything else delegates.
 */
@Injectable({ providedIn: 'root' })
export class ConversationListService {
  private readonly repo = inject(ThreadRepository);
  private readonly userService = inject(UserService);
  private readonly groupService = inject(GroupService);

  /** Pending mark-read per thread — coalesces a burst of open-thread new messages to the MAX seq so a single
   *  POST advances the server watermark (advanceReadCursor is monotonic, so only the max matters). */
  private readonly pendingMarkRead = new Map<number, number>();
  private markReadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Epoch-ms the current debounce window opened (0 = no window armed). Bounds a SUSTAINED burst so it can't
   *  re-arm the trailing debounce forever + trip @Throttle(60,60) — mirrors ThreadRepository's missed-summary
   *  pull scheduling (PULL_DEBOUNCE_MS / PULL_MAX_WAIT_MS). */
  private markReadArmedAt = 0;
  private static readonly MARK_READ_DEBOUNCE_MS = 500;
  /** Hard ceiling on the debounce window: a sustained burst (a new message landing inside the window every
   *  time) still flushes within this bound instead of re-arming forever. At 2s ⇒ ≤30 markRead/min,
   *  comfortably under the backend's @Throttle(60,60) (60 per 60s per IP). */
  private static readonly MARK_READ_MAX_WAIT_MS = 2000;

  constructor() {
    // B1: a new message in the OPEN thread → advance the server read watermark. Coalesced + debounced so a
    // burst collapses to one POST with the max seq (a 50-message burst would otherwise trip @Throttle(60,60)).
    // The repo emits the signal (it owns SSE timing); this facade owns the write (markRead POSTs bypass the
    // DB layer, per the 3-tier contract). repo.noteOptimisticRead masks the unread regression while the POST
    // is in flight, until the next missed-summary walk confirms it server-side.
    this.repo.openThreadMessage$
      .pipe(takeUntilDestroyed())
      .subscribe(({ threadId, seq }) => {
        this.pendingMarkRead.set(threadId, Math.max(this.pendingMarkRead.get(threadId) ?? -1, seq));
        this.repo.noteOptimisticRead(threadId, seq);
        this.scheduleMarkReadFlush();
      });
  }

  /** Arm/extend the mark-read flush. Leading edge of a window → trailing debounce; mid-window → never push the
   *  fire past leading-edge + MAX_WAIT (budget spent ⇒ fire now; otherwise the smaller of the debounce + the
   *  remaining budget). Collapses a burst into one POST while bounding a sustained burst. */
  private scheduleMarkReadFlush(): void {
    const now = Date.now();
    clearTimeout(this.markReadTimer);
    if (this.markReadArmedAt === 0) {
      this.markReadArmedAt = now;
      this.markReadTimer = setTimeout(
        () => this.flushMarkRead(),
        ConversationListService.MARK_READ_DEBOUNCE_MS,
      );
      return;
    }
    const remaining = ConversationListService.MARK_READ_MAX_WAIT_MS - (now - this.markReadArmedAt);
    const delay = remaining <= 0 ? 0 : Math.min(ConversationListService.MARK_READ_DEBOUNCE_MS, remaining);
    this.markReadTimer = setTimeout(() => this.flushMarkRead(), delay);
  }

  /** Flush every pending mark-read now (one POST per thread, the max seq) and clear the queue. Fired on the
   *  debounce trailing edge AND on {@link close}, so navigating away mid-burst still records what was seen. */
  private flushMarkRead(): void {
    this.markReadTimer = undefined;
    this.markReadArmedAt = 0;
    for (const [threadId, seq] of this.pendingMarkRead) {
      this.userService.markRead({ threadId, lastReadSeq: seq }).subscribe({
        error: () => {
          /* fire-and-forget — the watermark converges on next open() / READ_CURSOR echo / missed-summary walk */
        },
      });
    }
    this.pendingMarkRead.clear();
  }

  // ── delegated data signals (the same references the repo owns) ──
  readonly items = this.repo.items;
  readonly status = this.repo.status;
  readonly error = this.repo.error;
  readonly openThreadId = this.repo.openThreadId;
  readonly topInserted = this.repo.topInserted;
  /** The persisted high-water mark (the away-notification `since`). Delegated — see ThreadRepository. */
  readonly missedCursor = this.repo.missedCursor;

  /** Advance the away-HWM to `cursor` — the away-notification dismiss path (acknowledge the batch so the next
   *  background fetch's `since` gates past it). Delegates to the repo. */
  advanceMissedCursor(cursor: MissedCursor): void {
    this.repo.advanceMissedCursor(cursor);
  }

  /** Load (or force-refresh) the conversation list. Delegates to the repo's boot-from-cache + snapshot. */
  load(opts?: { force?: boolean }) {
    this.repo.load(opts);
  }

  /**
   * Mark a thread as open (selected); advance its read cursor on the server and clear the badge
   * optimistically. The HTTP mark-read is fired ONLY when the thread actually has unread messages (re-opening
   * an already-read conversation is a server-side no-op whose request would burn the per-IP throttle budget).
   * The request is fire-and-forget: a 429 or network failure is swallowed — the cursor converges on the next
   * open() or the READ_CURSOR SSE echo. The P2P peer profile is lazily refreshed (repo refresh backstop).
   *
   * This is the sole WRITE path through the facade — `markRead` POSTs directly to the backend (writes bypass
   * the DB layer); the badge clear + open-thread state are repo mutations driven by this UI action.
   */
  open(threadId: number) {
    const prev = this.repo.openThreadId();
    this.repo.setOpenThread(threadId);
    if (threadId === prev) return;
    const item = this.repo.items().find((t) => t.threadId === threadId);
    const seq = item?.lastMessageSeq ?? null;
    if ((item?.unreadCount ?? 0) > 0 && seq != null) {
      this.repo.clearUnread(threadId);
      // B2 now carries the latest seq (the item's lastMessageSeq) AND sets the optimistic mask — same as B1 —
      // so a snapshot refresh racing this POST can't regress the just-cleared badge.
      this.repo.noteOptimisticRead(threadId, seq);
      this.userService.markRead({ threadId, lastReadSeq: seq }).subscribe({
        error: () => {
          /* fire-and-forget — cursor converges on next open() / READ_CURSOR echo */
        },
      });
    }
    // P2P peer (local OR federated): lazily refresh avatar/name/bio if it changed since the list snapshot.
    this.repo.refreshPeerOnOpen(threadId);
    // GROUP (local OR federated mirror): fire the chat-open catch-up hook so a federated mirror lazily
    // pulls roster + history from the origin (the GROUP twin of refreshPeerOnOpen, which no-ops for GROUP).
    // The resulting GROUP_UPDATED / GROUP_ROSTER_UPDATED SSE are already routed by GroupEventService.
    if (item?.type === 'GROUP') {
      this.groupService.syncMeta({ groupId: threadId }).subscribe({
        error: () => {
          /* fire-and-forget — an unreachable origin degrades to the next open / reconnect sweep */
        },
      });
    }
  }

  /** Clear the open thread (chat-pane unmounted / mobile popup closed). Flushes any pending mark-read first so
   *  a burst cut short by navigation is still recorded server-side. */
  close() {
    if (this.markReadTimer !== undefined) {
      clearTimeout(this.markReadTimer);
      this.flushMarkRead();
    }
    this.repo.setOpenThread(undefined);
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
      clearedAt?: number | null;
      blocked?: boolean;
      alias?: string | null;
    },
  ): void {
    this.repo.applyThreadMeta(threadId, patch);
  }

  /** Replace a P2P item's peerUser (avatar/name/bio) after a profile sync. */
  updatePeerUser(threadId: number, user: User): void {
    this.repo.updatePeerUser(threadId, user);
  }

  /** Apply a rename / avatar / description change from a GROUP_UPDATED event. */
  applyGroupUpdate(threadId: number, patch: { name?: string; description?: string; avatar?: string }): void {
    this.repo.applyGroupUpdate(threadId, patch);
  }

  /** Apply my own role change from a GROUP_ROLE_CHANGED event targeting me. */
  applyRole(threadId: number, role: 'OWNER' | 'ADMIN' | 'MEMBER'): void {
    this.repo.applyRole(threadId, role);
  }

  /** Drop a thread (self-kick / self-left / unfriend). */
  removeThread(threadId: number): void {
    this.repo.removeThread(threadId);
  }
}
