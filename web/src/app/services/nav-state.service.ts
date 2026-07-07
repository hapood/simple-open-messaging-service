import { computed, effect, inject, Injectable, signal, type Type } from '@angular/core';
import { ConversationListService } from './conversation-list.service';

/** The aside auxiliary panel kinds (mirrors the old `(aside:...)` outlet segments). */
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
 * navigation: state is mirrored to the URL one-way via `history.replaceState` (history stays a single
 * entry deep, so browser-back naturally exits on desktop/PWA), and mobile intercepts hardware back
 * natively and calls {@link back}.
 *
 * Layered model: `chatThreadId` (base) ← `aside` (overlay 1) ← `paneStack` (overlay 2, topmost last).
 * {@link back} peels one layer: topmost pane → aside → chat → (home: returns `false`, caller exits).
 *
 * `ConversationListService.openThreadId` remains the chat data-layer signal; this service is its sole
 * writer (replacing the old HomeShell URL-derived effect). All existing readers (ChatPane, thread-list,
 * peer-profile, group-info) are unchanged.
 *
 * Phase 0: dormant — `providedIn:'root'` is lazy, so until Phase 1+ inject it, this service is never
 * constructed and the URL-mirror effect never runs. No behavior change until wired in.
 */
@Injectable({ providedIn: 'root' })
export class NavStateMachineService {
  private readonly convList = inject(ConversationListService);

  /** The open chat thread id, or `undefined` at the conversation list (home). */
  readonly chatThreadId = signal<number | undefined>(undefined);
  /** The open aside panel, or `undefined`. */
  readonly aside = signal<{ panel: AsidePanel } | undefined>(undefined);
  /** Transient pane stack (dialogs + overlays + search). Top = last entry. */
  readonly paneStack = signal<readonly PaneEntry[]>([]);

  /** Dialog entries (derived) — Phase 3 wires RootPopup to this instead of `RouteService.dlgList`. */
  readonly dialogs = computed(() => this.paneStack().filter((p) => p.kind === 'dialog'));

  constructor() {
    // URL mirror — one-way (state → URL), `replaceState` only (never `push`), so the history stays a
    // single entry and browser-back exits on desktop/PWA. `/chat/N`, optionally with `(aside:panel)`.
    effect(() => {
      const tid = this.chatThreadId();
      const aside = this.aside();
      const base = tid === undefined ? '/' : `/chat/${tid}`;
      const url = aside ? (base === '/' ? `/(aside:${aside.panel})` : `${base}(aside:${aside.panel})`) : base;
      if (typeof history !== 'undefined') history.replaceState(history.state, '', url);
    });
  }

  // --- chat layer ---
  openChat(threadId: number): void {
    this.chatThreadId.set(threadId);
    this.convList.open(threadId);
  }
  /** Leave the chat → home. Closes the aside too (a chat-scoped panel can't outlive its chat). */
  closeChat(): void {
    this.chatThreadId.set(undefined);
    this.aside.set(undefined);
    this.convList.close();
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

  /** Cold-load: seed chat/aside from the URL once at boot (Phase 1 wires the call). Idempotent. */
  initFromUrl(): void {
    if (typeof location === 'undefined') return;
    const chatMatch = location.pathname.match(/^\/chat\/(\d+)/);
    if (chatMatch) this.openChat(Number(chatMatch[1]));
    const asideMatch = location.pathname.match(/\(aside:([a-z-]+)\)/);
    if (asideMatch) {
      const panel = asideMatch[1];
      if (panel === 'profile' || panel === 'group-info' || panel === 'settings') this.openAside(panel);
    }
  }
}
