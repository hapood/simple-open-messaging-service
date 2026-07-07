import { Injectable, inject, signal } from '@angular/core';
import { LayoutService } from './layout.service';
import { NavStateMachineService } from './nav-state.service';

/**
 * Global-search overlay coordinator. The overlay itself is a signal-gated panel in the home shell
 * (NOT a route — search is a transient browsing surface, not a deep-linkable page), so this service
 * owns its open/close state and the one cross-component handshake it needs: the message-id the
 * chat-pane should center the kernel on after a message-hit click.
 *
 * Layout split:
 *  - Desktop: the panel covers the conversation-list column alongside the chat (dual-pane). Clicking a
 *    result opens the thread in the chat column with `replaceUrl` (mirrors the list's own openChat) and
 *    KEEPS the panel open for continued browsing.
 *  - Tablet/Mobile: the panel is a full-screen takeover. A sentinel history entry pushed on open lets
 *    system-back close it; clicking a result opens the thread (replaceUrl consumes the sentinel) and
 *    dismisses the panel signal-only (no history.back — the sentinel is already gone).
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly nav = inject(NavStateMachineService);
  private readonly layout = inject(LayoutService);

  /** Whether the global-search overlay is currently open. */
  readonly searchActive = signal(false);
  /** {threadId, msgId} of a message hit to center the kernel on. ChatPane only forwards the msgId when
   *  its open thread matches threadId, so a stale value can never fire on the wrong thread; it is
   *  consumed (cleared) after the jump lands — in ChatPane.onReady for a thread switch, via a timer
   *  for a same-thread jump — so re-opening the thread from the list doesn't re-jump to an old hit. */
  readonly pendingJump = signal<{ threadId: number; msgId: string } | undefined>(undefined);

  /** History traversals this service initiated (a sentinel pop on close). A matching popstate is
   *  suppressed so it isn't mistaken for a user system-back. */
  private selfBackPending = 0;

  constructor() {
    // System-back while the overlay is open closes it (mirrors the popup-dlg pattern in RouteService).
    window.addEventListener('popstate', () => this.onPopState());
  }

  /** Tablet/mobile = full-screen takeover (needs the sentinel for system-back); desktop = side column. */
  private get isFullscreen(): boolean {
    return this.layout.mode() !== 'desktop';
  }

  /** Open the search overlay. On tablet/mobile pushes a sentinel history entry so system-back closes
   *  the overlay instead of leaving the app. */
  open(): void {
    if (this.searchActive()) return;
    if (this.isFullscreen) history.pushState({ tag: 'soms-search' }, '');
    this.searchActive.set(true);
  }

  /** Programmatic close (the X button). Clears state; on tablet/mobile pops the sentinel entry. */
  close(): void {
    if (!this.searchActive()) return;
    this.searchActive.set(false);
    this.pendingJump.set(undefined);
    if (this.isFullscreen) {
      this.selfBackPending++;
      history.back();
    }
  }

  /** Open a conversation (land on latest). `replaceUrl` makes the chat take the list URL's place in
   *  history (back from the chat returns to the conversation list). Desktop keeps the panel open;
   *  tablet/mobile dismiss it — the navigate's replaceUrl already consumed the sentinel, so dismissal
   *  is signal-only (no history.back). */
  openThread(threadId: number): void {
    // openChat's replaceState consumes the search sentinel (the current entry) on fullscreen, so the
    // signal-only dismiss is correct (no history.back — that would pop the just-replaced chat entry).
    // Desktop has no sentinel; the conditional keeps the panel open there for continued browsing.
    this.nav.openChat(threadId);
    if (this.isFullscreen) this.dismissSilently();
  }

  /** Open a conversation AND center the kernel on a matched message. Sets pendingJump, which ChatPane
   *  forwards to <app-message-thread [startMsgId]> only when its open thread matches; the jump runs on
   *  thread init (openAround) or, if the thread is already open, via MessageThread's startMsgId effect. */
  openThreadAtMessage(threadId: number, msgId: string): void {
    this.pendingJump.set({ threadId, msgId });
    this.nav.openChat(threadId);
    if (this.isFullscreen) this.dismissSilently();
  }

  /** Called by ChatPane once the kernel has applied the jump — clears the value so it can't re-fire
   *  on a later thread switch. */
  consumeJump(): void {
    this.pendingJump.set(undefined);
  }

  /** Tablet/mobile: hide the overlay without touching history (openChat's replaceState already consumed
   *  the sentinel, so there is nothing to pop). */
  dismissSilently(): void {
    this.searchActive.set(false);
    this.pendingJump.set(undefined);
  }

  private onPopState(): void {
    if (this.selfBackPending > 0) {
      this.selfBackPending--;
      return;
    }
    // Genuine system-back while the overlay is open: close it signal-only (the popstate already did
    // the back, so no second history.back).
    if (this.searchActive()) {
      this.searchActive.set(false);
      this.pendingJump.set(undefined);
    }
  }
}
