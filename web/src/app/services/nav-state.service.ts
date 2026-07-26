import { computed, effect, inject, Injectable, signal, type Type } from '@angular/core';

/** The chat-scoped aside overlay kinds — peer-profile / group-info, opened from within a chat. Single-depth
 *  (no drill-in here); the Settings sub-page has its own {@link NavStateMachineService.settingsCategoryStack}
 *  state, so this type is purely overlay panels. */
export type AsidePanel = 'profile' | 'group-info';

/** The active mobile home section (`'chats'` = conversation list; `'settings'` / `'profile'` are opened
 *  from the account menu and swap the section content inline). Desktop never reads this — its icon-rail
 *  branch is independent. NOTE: the `'profile'` here is the SELF profile section, distinct from
 *  {@link AsidePanel}'s `'profile'` (a chat-scoped PEER profile overlay) — TypeScript keeps them apart; the
 *  overlap is only lexical. */
export type TopSection = 'chats' | 'settings' | 'profile';

/** One entry on the aside overlay stack. Single-depth — peer-profile / group-info are root-only. */
export interface AsideEntry {
  readonly id: number;
  readonly panel: AsidePanel;
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
   *  Settings dialog). Ignored on mobile (full-screen sheet). */
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
 * Layered model (back peels top-down): paneStack → aside → search → chat → settingsCategoryStack → topSection.
 * `settingsCategoryStack` (the Settings drill-down) and `chatThreadId` are mutually exclusive in practice —
 * the settings section is mobile-only and you can't be on it while a chat is open — so their relative order
 * in `back()` never matters. `topSection` is peeled last, before exit.
 *
 * This service owns only the navigation state + the URL mirror. `ConversationListService.openThreadId`
 * remains the chat data-layer signal, coordinated by `HomeShellComponent` (which reads `chatThreadId` —
 * with the mobile close-slide lag — the way it used to read the routed thread id). All other readers
 * (ChatPane, thread-list, peer-profile, group-info) are unchanged.
 *
 * URL mirror covers the chat thread only (`/` or `/chat/N`). The aside panel, the in-chat search field, the
 * top-level section, and the settings category are session-state, NOT mirrored — they aren't deep-linkable,
 * and an `(aside:…)` URL segment would make the router try to match an auxiliary outlet we no longer have.
 */
@Injectable({ providedIn: 'root' })
export class NavStateMachineService {
  /** The open chat thread id, or `undefined` at the conversation list (home). */
  readonly chatThreadId = signal<number | undefined>(undefined);
  /** The aside overlay stack (peer-profile / group-info). Single-depth — 0 or 1 entry. */
  readonly aside = signal<readonly AsideEntry[]>([]);
  /** The topmost aside entry, or `undefined` when the aside is closed. */
  readonly asideTop = computed(() => {
    const s = this.aside();
    return s.length ? s[s.length - 1] : undefined;
  });
  /** Whether the in-chat search field is open in the foreground chat. A session-state nav layer (like
   *  `aside`, NOT mirrored to the URL); {@link back} peels it before the chat so hardware-back exits
   *  search before leaving the thread. */
  readonly searchOpen = signal(false);
  /** The active mobile home section (`'chats'` = conversation list; `'settings'` / `'profile'` are opened
   *  from the account menu and swap the section content inline). Desktop never reads this. Switching
   *  sections clears the aside + settings drill-down (clean slate). {@link back} peels a non-chats section
   *  back to `'chats'` before exit. */
  readonly topSection = signal<TopSection>('chats');
  /** The Settings drill-down stack (mobile settings section). Each entry is an opaque category id; the
   *  settings component owns the id→category mapping, keeping this service decoupled from the category
   *  registry. A STACK so drill-in can be multi-level (root → category → sub-category → …) and {@link back}
   *  pops one level at a time. Owned here — NOT on the aside stack — so the aside stays a pure chat-scoped
   *  overlay concept. Mobile-only (desktop Settings is a dialog). */
  readonly settingsCategoryStack = signal<readonly string[]>([]);
  /** The active (topmost) Settings category, or `undefined` at the root list. What readers display. */
  readonly settingsCategoryTop = computed(() => {
    const s = this.settingsCategoryStack();
    return s.length ? s[s.length - 1] : undefined;
  });
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
   *  Also clears the pane stack and the in-chat search — a thread switch scopes away any open
   *  dialog/overlay/search. */
  openChat(threadId: number): void {
    this.closeAllPanes();
    if (this.chatThreadId() !== threadId) this.aside.set([]);
    this.searchOpen.set(false);
    this.chatThreadId.set(threadId);
  }
  /** Leave the chat → home. Also closes the aside + search and clears the pane stack. */
  closeChat(): void {
    this.closeAllPanes();
    this.chatThreadId.set(undefined);
    this.aside.set([]);
    this.searchOpen.set(false);
  }

  // --- aside layer ---
  /** Open a chat-scoped overlay panel (peer-profile / group-info), replacing any current aside. */
  openAside(panel: AsidePanel): void {
    this.aside.set([{ id: nextAsideId++, panel }]);
  }
  /** Close the aside (bound to the desktop scrim click). */
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

  // --- settings section drill-down (mobile) ---
  /** Drill one level deeper into Settings (pushes onto {@link settingsCategoryStack}). Multi-level: root →
   *  category → sub-category → …; {@link back} pops one level at a time. */
  openSettingsCategory(categoryId: string): void {
    this.settingsCategoryStack.update((s) => [...s, categoryId]);
  }

  /** Switch the active mobile section. Clears the aside + settings drill-down so each section starts
   *  clean. */
  setTopSection(section: TopSection): void {
    this.topSection.set(section);
    this.aside.set([]);
    this.settingsCategoryStack.set([]);
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
   *  so a thread switch or going home dismisses any open dialog/overlay. */
  closeAllPanes(): void {
    const stack = this.paneStack();
    if (stack.length === 0) return;
    this.paneStack.set([]);
    for (let i = stack.length - 1; i >= 0; i--) stack[i].onResult?.(undefined);
  }

  /** Reset every transient nav layer (open dialogs, the aside, in-chat search, the settings drill-down, and
   *  the active section) but KEEP {@link chatThreadId}. Called when the viewport crosses the desktop/mobile
   *  breakpoint: the section / overlay model differs per layout, so transient state that doesn't make sense
   *  in the new layout is dropped, while the open chat — the user's anchor context — survives. */
  resetTransientExceptChat(): void {
    this.closeAllPanes();
    this.aside.set([]);
    this.searchOpen.set(false);
    this.settingsCategoryStack.set([]);
    this.topSection.set('chats');
  }

  /**
   * Peel one layer: topmost pane → aside → search → chat → settings sub-page → top section → home. Returns
   * whether a layer was consumed. `false` (at home) means the mobile caller should exit the app; on
   * desktop/PWA browser-back has already exited (history is flat).
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
      // Close the chat-scoped overlay (single-depth — peeling the one entry empties the stack).
      this.aside.set([]);
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
    // A drilled Settings level peels one stack entry (sub-page → its parent; the root entry popping leaves
    // the root list, then the next back falls through to the topSection check).
    if (this.settingsCategoryStack().length > 0) {
      this.settingsCategoryStack.update((s) => s.slice(0, -1));
      return true;
    }
    // A non-chats mobile section peels back to Chats before exit.
    if (this.topSection() !== 'chats') {
      this.setTopSection('chats');
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
