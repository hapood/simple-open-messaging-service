import { Injectable, inject } from '@angular/core';
import { UserService } from './user.service';
import { ThreadRepository } from './thread-store.service';
import { User } from './model';

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
 *  - {@link close}: clears the open thread.
 * The `markRead` write is the reason this facade exists: the DB layer never POSTs. Everything else delegates.
 */
@Injectable({ providedIn: 'root' })
export class ConversationListService {
  private readonly repo = inject(ThreadRepository);
  private readonly userService = inject(UserService);

  // ── delegated data signals (the same references the repo owns) ──
  readonly items = this.repo.items;
  readonly status = this.repo.status;
  readonly error = this.repo.error;
  readonly openThreadId = this.repo.openThreadId;
  readonly topInserted = this.repo.topInserted;

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
    if ((item?.unreadCount ?? 0) > 0) {
      this.repo.clearUnread(threadId);
      this.userService.markRead({ threadId }).subscribe({
        error: () => {
          /* fire-and-forget — cursor converges on next open() / READ_CURSOR echo */
        },
      });
    }
    // P2P peer (local OR federated): lazily refresh avatar/name/bio if it changed since the list snapshot.
    this.repo.refreshPeerOnOpen(threadId);
  }

  /** Clear the open thread (chat-pane unmounted / mobile popup closed). */
  close() {
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
