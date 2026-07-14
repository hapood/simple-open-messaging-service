import { computed, effect, inject, Injectable, signal, type Type } from '@angular/core';

/** The aside auxiliary panel kinds (the old `(aside:...)` outlet segments, now signal-driven). */
export type AsidePanel = 'profile' | 'group-info' | 'settings';

/** One entry on the aside navigation stack. The aside is now a STACK so a panel can drill into
 *  sub-pages (e.g. Settings root → a category page → a sub-category). `params` carries per-entry
 *  context the rendered component reads (e.g. `{ category: 'notifications' }` for Settings). */
export interface AsideEntry {
  readonly id: number;
  readonly panel: AsidePanel;
  readonly params?: Record<string, unknown>;
}

/** Transient pane kinds stacked above the chat/aside layers. The host template renders each by `kind`. */
export type PaneKind = 'dialog' | 'gallery' | 'file-detail' | 'invite-detail';

/**
 * One entry on the transient pane stack. `component`/`inputs`/`onResult` are dialog-specific (RootPopup
 * renders dialogs via `*ngComponentOutlet`); gallery/file-detail/invite-detail carry their payload
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
  /** Dialog-only: render the desktop centered card wider than the default 480px (e.g. a two-column
   *  Settings dialog). Ignored on tablet/mobile (full-screen sheet). */
  readonly wide?: boolean;
}

let nextPaneId = 0;
let nextAsideId = 0;

/**
 * The single source of truth for app view state — replaces the Angular Router + the sentinel system for
 * in-app navigation (chat thread, aside panel, transient panes). Browser history is NOT used for app
 * navigation: state mirrors to the URL one-way via `history.replaceState` (history stays a single entry
 * deep, so browser-back naturally exits on desktop/PWA), and mobile intercepts hardware back natively
 * and calls {@link back}.
 *
 * Layered model: `chatThreadId` (base) ← `searchOpen` ← `aside` (a stack) ← `paneStack` (topmost last).
 * {@link back} peels one layer: topmost pane → one aside entry → search → chat → nav drawer → (home:
 * returns `false`, caller exits). The aside being a stack means a panel can drill into sub-pages and back
 * pops one level. The nav drawer is a home-screen overlay (only ever open at home) peeled last, before exit.
 *
 * This service owns only the navigation state + the URL mirror. `ConversationListService.openThreadId`
 * remains the chat data-layer signal, coordinated by `HomeShellComponent` (which reads `chatThreadId` —
 * with the mobile close-slide lag — the way it used to read the routed thread id). All other readers
 * (ChatPane, thread-list, peer-profile, group-info) are unchanged.
 *
 * URL mirror covers the chat thread only (`/` or `/chat/N`). The aside panel, the in-chat search field,
 * AND the nav drawer are session-state, NOT mirrored — they aren't deep-linkable, and an `(aside:…)` URL
 * segment would make the router try to match an auxiliary outlet we no longer have.
 */
@Injectable({ providedIn: 'root' })
export class NavStateMachineService {
  /** The open chat thread id, or `undefined` at the conversation list (home). */
  readonly chatThreadId = signal<number | undefined>(undefined);
  /** The aside navigation stack. Empty = closed; one entry = a panel at root depth; more = drilled-in
   *  sub-pages (top = last entry). Renderers read the TOP entry's `panel` (and `params`). */
  readonly aside = signal<readonly AsideEntry[]>([]);
  /** The topmost aside entry, or `undefined` when the aside is closed. The single thing renderers +
   *  components read (panel kind + drill-in params). */
  readonly asideTop = computed(() => {
    const s = this.aside();
    return s.length ? s[s.length - 1] : undefined;
  });
  /** Whether the in-chat search field is open in the foreground chat. A session-state nav layer (like
   *  `aside`, NOT mirrored to the URL); {@link back} peels it before the chat so hardware-back exits
   *  search before leaving the thread. */
  readonly searchOpen = signal(false);
  /** Whether the left nav drawer is open. A home-screen session-state overlay (NOT mirrored to the URL);
   *  {@link back} peels it at the home level so hardware-back closes the drawer before exiting the app.
   *  Owned here — not inside MatSidenav — precisely so `back()` can see it (the bug it fixes: back used to
   *  skip the drawer and exit the app). The drawer's `[opened]` binding mirrors this signal two-way
   *  (`(openedChange)` writes back), so backdrop-click and ESC closes stay in sync. */
  readonly drawerOpen = signal(false);
  /** Transient pane stack (dialogs + overlays). Top = last entry. */
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
   *  Also clears the pane stack, the in-chat search, and the nav drawer — a thread switch scopes away any
   *  open dialog/overlay/search/drawer. */
  openChat(threadId: number): void {
    this.closeAllPanes();
    if (this.chatThreadId() !== threadId) this.aside.set([]);
    this.searchOpen.set(false);
    this.drawerOpen.set(false);
    this.chatThreadId.set(threadId);
  }
  /** Leave the chat → home. Also closes the aside + search + nav drawer + clears the pane stack. */
  closeChat(): void {
    this.closeAllPanes();
    this.chatThreadId.set(undefined);
    this.aside.set([]);
    this.searchOpen.set(false);
    this.drawerOpen.set(false);
  }

  // --- aside layer ---
  /** Open a panel at ROOT depth, replacing any current aside (preserves the old single-panel
   *  semantics: opening profile while settings is open swaps it, doesn't stack). */
  openAside(panel: AsidePanel): void {
    this.aside.set([{ id: nextAsideId++, panel }]);
  }
  /** Drill one level deeper within the current aside (sub-page). Appends to the stack so {@link back}
   *  peels it one level at a time. Used by Settings category rows (and later, sibling panel drill-in). */
  pushAside(panel: AsidePanel, params?: Record<string, unknown>): void {
    this.aside.update((s) => [...s, { id: nextAsideId++, panel, params }]);
  }
  /** Close the entire aside (clears every stacked entry). Bound to the desktop/tablet scrim click and
   *  to the close affordances of panels that have no drill-in. */
  closeAside(): void {
    this.aside.set([]);
  }

  // --- in-chat search layer ---
  openSearch(): void {
    this.searchOpen.set(true);
  }
  closeSearch(): void {
    this.searchOpen.set(false);
  }

  // --- nav drawer layer ---
  openDrawer(): void { this.drawerOpen.set(true); }
  closeDrawer(): void { this.drawerOpen.set(false); }
  toggleDrawer(): void { this.drawerOpen.update((v) => !v); }

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
   *  so a thread switch or going home dismisses any open dialog/overlay. */
  closeAllPanes(): void {
    const stack = this.paneStack();
    if (stack.length === 0) return;
    this.paneStack.set([]);
    for (let i = stack.length - 1; i >= 0; i--) stack[i].onResult?.(undefined);
  }

  /**
   * Peel one layer: topmost pane → aside → search → chat → nav drawer → home. Returns whether a layer was
   * consumed. `false` (at home) means the mobile caller should exit the app; on desktop/PWA browser-back
   * has already exited (history is flat).
   */
  back(): boolean {
    const stack = this.paneStack();
    if (stack.length > 0) {
      const removed = stack[stack.length - 1];
      this.paneStack.set(stack.slice(0, -1));
      removed.onResult?.(undefined);
      return true;
    }
    if (this.aside().length > 0) {
      // Peel one aside entry: a drilled-in sub-page returns to its parent; the root entry popping
      // empties the stack and closes the aside entirely.
      this.aside.update((s) => s.slice(0, -1));
      return true;
    }
    // In-chat search is the innermost overlay (it lives in the chat header): peel it right before the
    // chat itself, so back exits search before leaving the thread.
    if (this.searchOpen()) {
      this.searchOpen.set(false);
      return true;
    }
    if (this.chatThreadId() !== undefined) {
      this.closeChat();
      return true;
    }
    // The nav drawer is a home-screen overlay — it's only ever open at home (opening a chat/aside/dialog
    // closes it first), so it's the last layer to peel before the app exits.
    if (this.drawerOpen()) {
      this.drawerOpen.set(false);
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
