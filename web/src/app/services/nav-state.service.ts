import { computed, effect, inject, Injectable, signal, type Type } from '@angular/core';

/** The aside auxiliary panel kinds (the old `(aside:...)` outlet segments, now signal-driven). */
export type AsidePanel = 'profile' | 'group-info' | 'settings';

/** Transient pane kinds stacked above the chat/aside layers. The host template renders each by `kind`. */
export type PaneKind = 'dialog' | 'gallery' | 'file-detail' | 'invite-detail' | 'search';

/**
 * One entry on the transient pane stack. `component`/`inputs`/`onResult` are dialog-specific (RootPopup
 * renders dialogs via `*ngComponentOutlet`); gallery/file-detail/invite-detail/search carry their payload
 * in `payload` and are rendered by a host `@switch` on `kind`.
 */
export interface PaneEntry {
  readonly id: number;
  readonly kind: PaneKind;
  readonly component?: Type<unknown>;
  readonly inputs?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
  /** Delivered the close result (dialog) or `undefined` (back/cancel). */
  readonly onResult?: (result: unknown) => void;
}

let nextPaneId = 0;

/**
 * The single source of truth for app view state — replaces the Angular Router + the sentinel system for
 * in-app navigation (chat thread, aside panel, transient panes). Browser history is NOT used for app
 * navigation: state mirrors to the URL one-way via `history.replaceState` (history stays a single entry
 * deep, so browser-back naturally exits on desktop/PWA), and mobile intercepts hardware back natively
 * and calls {@link back}.
 *
 * Layered model: `chatThreadId` (base) ← `aside` (overlay 1) ← `paneStack` (overlay 2, topmost last).
 * {@link back} peels one layer: topmost pane → aside → chat → (home: returns `false`, caller exits).
 *
 * This service owns only the navigation state + the URL mirror. `ConversationListService.openThreadId`
 * remains the chat data-layer signal, coordinated by `HomeShellComponent` (which reads `chatThreadId` —
 * with the mobile close-slide lag — the way it used to read the routed thread id). All other readers
 * (ChatPane, thread-list, peer-profile, group-info) are unchanged.
 *
 * URL mirror covers the chat thread only (`/` or `/chat/N`). The aside panel is session-state, NOT
 * mirrored — it isn't deep-linkable, and an `(aside:…)` URL segment would make the router try to match
 * an auxiliary outlet we no longer have.
 */
@Injectable({ providedIn: 'root' })
export class NavStateMachineService {
  /** The open chat thread id, or `undefined` at the conversation list (home). */
  readonly chatThreadId = signal<number | undefined>(undefined);
  /** The open aside panel, or `undefined`. */
  readonly aside = signal<{ panel: AsidePanel } | undefined>(undefined);
  /** Transient pane stack (dialogs + overlays + search). Top = last entry. */
  readonly paneStack = signal<readonly PaneEntry[]>([]);

  /** Dialog entries (derived) — RootPopup reads this (Phase 3 rewire; today RouteService.dlgList still drives it). */
  readonly dialogs = computed(() => this.paneStack().filter((p) => p.kind === 'dialog'));

  constructor() {
    // URL mirror — one-way (state → URL), `replaceState` only (never `push`), so the history stays a
    // single entry and browser-back exits on desktop/PWA. `/chat/N`, or `/` at the list. Gated to the app
    // shell only: page routes (playground, auth, config, forbidden) own their URLs — mirroring here would
    // clobber them (e.g. rewrite `/playground/...` → `/` at boot).
    effect(() => {
      if (typeof location === 'undefined' || typeof history === 'undefined') return;
      const p = location.pathname;
      if (p !== '/' && !p.startsWith('/chat/')) return;
      const tid = this.chatThreadId();
      const url = tid === undefined ? '/' : `/chat/${tid}`;
      history.replaceState(history.state, '', url);
    });
  }

  // --- chat layer ---
  /** Open a chat thread. Closing a chat-scoped aside on a thread switch mirrors the old openChat (which
   *  cleared the `(aside:…)` outlet): a group-info/peer-profile panel belongs to the previous thread.
   *  Also clears the pane stack — a thread switch scopes away any open dialog/overlay/search. */
  openChat(threadId: number): void {
    this.closeAllPanes();
    if (this.chatThreadId() !== threadId) this.aside.set(undefined);
    this.chatThreadId.set(threadId);
  }
  /** Leave the chat → home. Also closes the aside + clears the pane stack. */
  closeChat(): void {
    this.closeAllPanes();
    this.chatThreadId.set(undefined);
    this.aside.set(undefined);
  }

  // --- aside layer ---
  openAside(panel: AsidePanel): void {
    this.aside.set({ panel });
  }
  closeAside(): void {
    this.aside.set(undefined);
  }

  // --- transient pane layer ---
  /** Push a pane; returns its id (pass to {@link closePane}). */
  pushPane(entry: Omit<PaneEntry, 'id'>): number {
    const id = nextPaneId++;
    this.paneStack.update((s) => [...s, { ...entry, id }]);
    return id;
  }
  /** Close a pane by id, delivering `result` to its `onResult`. Closing a mid-stack pane also removes
   *  everything above it (nested descendants close with `undefined`). */
  closePane(id: number, result?: unknown): void {
    const stack = this.paneStack();
    const idx = stack.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const removed = stack.slice(idx); // target + everything above
    this.paneStack.set(stack.slice(0, idx));
    for (let i = removed.length - 1; i >= 0; i--) removed[i].onResult?.(i === 0 ? result : undefined);
  }

  /** Clear the entire pane stack (each onResult gets `undefined` = cancel). Called by openChat/closeChat
   *  so a thread switch or going home dismisses any open dialog/overlay/search. */
  closeAllPanes(): void {
    const stack = this.paneStack();
    if (stack.length === 0) return;
    this.paneStack.set([]);
    for (let i = stack.length - 1; i >= 0; i--) stack[i].onResult?.(undefined);
  }

  /**
   * Peel one layer: topmost pane → aside → chat → home. Returns whether a layer was consumed.
   * `false` (at home) means the mobile caller should exit the app; on desktop/PWA browser-back has
   * already exited (history is flat).
   */
  back(): boolean {
    const stack = this.paneStack();
    if (stack.length > 0) {
      const removed = stack[stack.length - 1];
      this.paneStack.set(stack.slice(0, -1));
      removed.onResult?.(undefined);
      return true;
    }
    if (this.aside() !== undefined) {
      this.aside.set(undefined);
      return true;
    }
    if (this.chatThreadId() !== undefined) {
      this.closeChat();
      return true;
    }
    return false;
  }

  /** Cold-load: seed the chat from the URL once at boot (HomeShell wires the call). Idempotent. */
  initFromUrl(): void {
    if (typeof location === 'undefined') return;
    const chatMatch = location.pathname.match(/^\/chat\/(\d+)/);
    if (chatMatch) this.openChat(Number(chatMatch[1]));
  }
}
