import { Injectable, inject, computed, signal } from '@angular/core';
import { NavStateMachineService } from './nav-state.service';

/**
 * Global-search overlay coordinator. The overlay is a signal-gated panel in the home shell (NOT a route —
 * search is a transient browsing surface, not a deep-linkable page). This service owns its open/close state
 * as an entry on {@link NavStateMachineService.paneStack} (kind `'search'`) and the one cross-component
 * handshake it needs: the message-id the chat-pane should center the kernel on after a message-hit click.
 *
 * `openThread` / `openThreadAtMessage` open a chat via the nav state machine, whose `openChat` clears the
 * pane stack — so jumping to a hit closes the search panel (and any open dialog) automatically.
 *
 * Layout split (unchanged from the router era): desktop = the panel covers the conversation-list column
 * alongside the chat; tablet/mobile = full-screen takeover. Positioning is per-mode in the stylesheet.
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly nav = inject(NavStateMachineService);

  /** Whether the global-search overlay is currently open (derived: a `search` entry is on the pane stack). */
  readonly searchActive = computed(() => this.nav.paneStack().some((p) => p.kind === 'search'));
  /** {threadId, msgId} of a message hit to center the kernel on. ChatPane only forwards the msgId when
   *  its open thread matches threadId, so a stale value can never fire on the wrong thread; it is
   *  consumed (cleared) after the jump lands — in ChatPane.onReady for a thread switch, via a timer
   *  for a same-thread jump — so re-opening the thread from the list doesn't re-jump to an old hit. */
  readonly pendingJump = signal<{ threadId: number; msgId: string } | undefined>(undefined);

  /** Open the search overlay (pushes a `search` entry onto the pane stack). */
  open(): void {
    if (this.searchActive()) return;
    this.nav.pushPane({ kind: 'search' });
  }

  /** Programmatic close (the X button / scrim) — removes the `search` entry from the pane stack. */
  close(): void {
    const stack = this.nav.paneStack();
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === 'search') {
        this.nav.closePane(stack[i].id);
        return;
      }
    }
  }

  /** Open a conversation (land on latest). openChat clears the pane stack, so the search panel closes. */
  openThread(threadId: number): void {
    this.nav.openChat(threadId);
  }

  /** Open a conversation AND center the kernel on a matched message. Sets pendingJump, which ChatPane
   *  forwards to <app-message-thread [startMsgId]> only when its open thread matches; the jump runs on
   *  thread init (openAround) or, if the thread is already open, via MessageThread's startMsgId effect. */
  openThreadAtMessage(threadId: number, msgId: string): void {
    this.pendingJump.set({ threadId, msgId });
    this.nav.openChat(threadId);
  }

  /** Called by ChatPane once the kernel has applied the jump — clears the value so it can't re-fire
   *  on a later thread switch. */
  consumeJump(): void {
    this.pendingJump.set(undefined);
  }
}
