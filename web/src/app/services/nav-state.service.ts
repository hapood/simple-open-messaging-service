import {
  computed,
  effect,
  inject,
  Injectable,
  signal,
  type Type,
} from '@angular/core';
import { UserService } from './user.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SessionLifecycleService } from './session-lifecycle.service';
import {
  validThreadNavigationId,
  type ThreadNavigationIntent,
} from './thread-navigation-intent';

/** The chat-scoped aside overlay kinds — peer-profile / group-info, opened from within a chat. */
export type AsidePanel =
  | 'profile'
  | 'group-info'
  | 'group-members'
  | 'group-join-requests';

/** The active mobile home section (`'chats'` = conversation list; `'settings'` / `'profile'` are opened
 *  from the account menu and swap the section content inline). Desktop never reads this — its icon-rail
 *  branch is independent. NOTE: the `'profile'` here is the SELF profile section, distinct from
 *  {@link AsidePanel}'s `'profile'` (a chat-scoped PEER profile overlay) — TypeScript keeps them apart; the
 *  overlap is only lexical. */
export type TopSection = 'chats' | 'settings' | 'profile';

/** One-shot visual intent for opening a chat. Ordinary navigation stays lightweight; a successful group
 *  join may opt into the celebratory reveal. The intent is tied to a thread so a later navigation cannot
 *  accidentally replay it on another conversation. */
export type ChatOpenTransition = 'standard' | 'group-joined';

/** One entry on the aside overlay stack. */
export interface AsideEntry {
  readonly id: number;
  readonly panel: AsidePanel;
}

/** Transient pane kinds stacked above the chat/aside layers. The host template renders each by `kind`. */
export type PaneKind = 'dialog' | 'gallery' | 'file-detail';

/** Rendering policy for a dialog pane. The root popup owns layout, motion, backdrop, focus, and safe-area
 * behavior for each policy, so individual dialog components only render their content. */
export type DialogPresentation = 'page' | 'modal' | 'viewer' | 'chatbox';
export type DialogDesktopSize = 'standard' | 'wide';
export type DialogDesktopHeight = 'content' | 'workspace';

/**
 * One entry on the transient pane stack. `component`/`inputs`/`onResult` are dialog-specific (RootPopup
 * renders dialogs via `*ngComponentOutlet`); gallery/file-detail carry their payload
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
  /** Dialog-only rendering policy. Defaults to `page` at the typed RouteService façade. */
  readonly presentation?: DialogPresentation;
  /** Dialog-only desktop card width. Compact layout is controlled solely by `presentation`. */
  readonly desktopSize?: DialogDesktopSize;
  /** Dialog-only desktop height policy. Workspaces provide a definite viewport for internal scrolling. */
  readonly desktopHeight?: DialogDesktopHeight;
  /** Conversation-local dialogs are rendered inside the matching message thread instead of RootPopup. */
  readonly scopeThreadId?: number;
  /** This dialog owns the mobile Settings drill-down stack. While it is topmost, back peels a category
   * before closing the dialog itself; dialogs pushed above it still close first as usual. */
  readonly settingsDrilldown?: boolean;
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
 * Layered model (back peels top-down): paneStack → aside → search → settingsCategoryStack →
 * topSection → chat. A mobile Settings/Profile section may cover a still-mounted chat; Back removes that
 * visible section first and reveals the preserved chat beneath it.
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
  private readonly userService = inject(UserService);
  /** Last-seen {@link UserService.sessionUserId} for the session-end effect — gates the reset to fire only
   *  on a real session → no-session edge (id → null), not on every signal read nor at boot (starts null). */
  private prevSessionId: number | null = null;

  /** The open chat thread id, or `undefined` at the conversation list (home). */
  readonly chatThreadId = signal<number | undefined>(undefined);
  private readonly _navigationRevision = signal(0);
  readonly navigationRevision = this._navigationRevision.asReadonly();
  /** A notification cold URL is scoped, unlike an ordinary user-entered deep link.
   * Capture it before mirroring strips the query; the coordinator validates the
   * session before selecting its thread. */
  readonly bootstrapNotificationIntent: ThreadNavigationIntent | null;
  private readonly pendingChatTransition = signal<
    { readonly threadId: number; readonly kind: ChatOpenTransition } | undefined
  >(undefined);
  /** The aside overlay stack (peer-profile / group-info and their drill-down panels). */
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
  readonly dialogs = computed(() =>
    this.paneStack().filter((p) => p.kind === 'dialog'),
  );

  constructor() {
    // Capture the cold-load target before any asynchronous session initializer
    // can flush the URL mirror. This service can exist before AppComponent.
    this.bootstrapNotificationIntent = null;
    if (typeof location !== 'undefined') {
      const match = location.pathname.match(/^\/chat\/([1-9]\d*)$/);
      const threadId = match ? Number(match[1]) : undefined;
      const query = new URLSearchParams(location.search);
      if (query.has('notificationSessionId')) {
        const raw = query.get('notificationSessionId')!;
        const sessionId = /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
        if (
          validThreadNavigationId(threadId) &&
          validThreadNavigationId(sessionId)
        )
          this.bootstrapNotificationIntent = {
            source: 'web',
            id: `bootstrap:${sessionId}:${threadId}`,
            sessionId,
            threadId,
          };
      } else if (validThreadNavigationId(threadId)) {
        this.chatThreadId.set(threadId);
      }
    }

    // URL mirror — one-way (state → URL), `replaceState` only (never `push`), so the history stays a
    // single entry and browser-back exits on desktop/PWA. `/chat/N`, or `/` at the list. Gated to the app
    // shell only: page routes (playground, auth, config, forbidden) own their URLs — mirroring here would
    // clobber them (e.g. rewrite `/playground/...` → `/` at boot).
    effect(() => {
      if (typeof location === 'undefined' || typeof history === 'undefined')
        return;
      const p = location.pathname;
      if (p !== '/' && !p.startsWith('/chat/')) return;
      const tid = this.chatThreadId();
      const url = tid === undefined ? '/' : `/chat/${tid}`;
      history.replaceState(history.state, '', url);
    });

    // Logout before HELLO does not change sessionUserId, but must still close cached chat layers.
    inject(SessionLifecycleService)
      .ended$.pipe(takeUntilDestroyed())
      .subscribe(() => this.resetForSessionEnd());

    // Session-end reset: when the session ends (sessionUserId → null — clearSession on logout / 401-bounce /
    // account switch), drop ALL nav layers so the next account logging into the same live SPA cannot inherit
    // this user's open chat, dialogs, aside, or mobile section. Mirrors the session-end effects in the
    // data-layer services (thread-store / folder / message-repository) that key off the same signal — this
    // service owns the in-memory VIEW state and resets it the same way they reset their caches.
    effect(() => {
      const id = this.userService.sessionUserId();
      if (id === this.prevSessionId) return;
      this.prevSessionId = id;
      if (id === null) this.resetForSessionEnd();
    });
  }

  // --- chat layer ---
  /** Open a chat thread. Closing a chat-scoped aside on a thread switch mirrors the old openChat (which
   *  cleared the `(aside:…)` outlet): a group-info/peer-profile panel belongs to the previous thread.
   *  Also clears the pane stack and the in-chat search — a thread switch scopes away any open
   *  dialog/overlay/search. */
  openChat(
    threadId: number,
    transition: ChatOpenTransition = 'standard',
  ): void {
    this._navigationRevision.update((value) => value + 1);
    this.closeAllPanes();
    if (this.chatThreadId() !== threadId) this.aside.set([]);
    this.searchOpen.set(false);
    this.pendingChatTransition.set({ threadId, kind: transition });
    this.chatThreadId.set(threadId);
  }
  /** External taps reveal Chats even when Settings/Profile currently covers it. */
  openExternalChat(threadId: number): boolean {
    this.setTopSection('chats');
    this.openChat(threadId);
    return this.chatThreadId() === threadId;
  }

  /** Consume the transition intent exactly once when ChatPane is ready to reveal the requested thread. */
  consumeChatTransition(threadId: number): ChatOpenTransition {
    const pending = this.pendingChatTransition();
    if (pending?.threadId !== threadId) return 'standard';
    this.pendingChatTransition.set(undefined);
    return pending.kind;
  }
  /** Leave the chat → home. Also closes the aside + search and clears the pane stack. */
  closeChat(): void {
    this._navigationRevision.update((value) => value + 1);
    this.closeAllPanes();
    this.pendingChatTransition.set(undefined);
    this.chatThreadId.set(undefined);
    this.aside.set([]);
    this.searchOpen.set(false);
  }

  /** Return to the thread list and discard every chat/settings descendant. Cache maintenance uses this
   * before replacing the message database so destroying ChatBox instances cancels their subscriptions and
   * prevents a hidden pane from immediately issuing new reads against the replacement cache. */
  returnToThreadList(): void {
    this.closeChat();
    this.settingsCategoryStack.set([]);
    this.topSection.set('chats');
  }

  // --- aside layer ---
  /** Open a root chat-scoped overlay panel, replacing any current aside hierarchy. */
  openAside(panel: AsidePanel): void {
    this.aside.set([{ id: nextAsideId++, panel }]);
  }
  /** Drill into a child of the current aside so Back can restore its parent. */
  pushAside(panel: AsidePanel): void {
    this.aside.update((stack) => [...stack, { id: nextAsideId++, panel }]);
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

  /** Reset the mobile Settings drill-down when its dialog opens/closes. */
  clearSettingsCategories(): void {
    this.settingsCategoryStack.set([]);
  }

  /** Switch the active mobile section. Clears the aside + settings drill-down so each section starts
   *  clean. */
  setTopSection(section: TopSection): void {
    if (section !== 'chats')
      this._navigationRevision.update((value) => value + 1);
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
    for (let i = removed.length - 1; i >= 0; i--)
      removed[i].onResult?.(i === 0 ? result : undefined);
  }

  /** Clear the entire pane stack (each onResult gets `undefined` = cancel). Called by openChat/closeChat
   *  so a thread switch or going home dismisses any open dialog/overlay. */
  closeAllPanes(): void {
    const stack = this.paneStack();
    if (stack.length === 0) return;
    this.paneStack.set([]);
    for (let i = stack.length - 1; i >= 0; i--) stack[i].onResult?.(undefined);
  }

  /** Leave the compact/medium-only top section when entering or leaving expanded layout. Dialogs, media
   *  overlays, the chat-scoped aside, search, and the open chat all have responsive treatments and therefore
   *  survive the breakpoint. Only the inline Profile/Settings section has no expanded-layout mount point. */
  resetAdaptiveTopSection(): void {
    this.settingsCategoryStack.set([]);
    this.topSection.set('chats');
  }

  /** Drop ALL nav layers — including the open chat. Called on session end (logout / 401-bounce / account
   *  switch), where the previous user's chat thread, open dialogs, aside, and mobile section must not
   *  survive into the next account's session. Unlike {@link resetAdaptiveTopSection} (which keeps the chat
   *  and responsive overlays across an expanded-layout boundary), this clears the chat too — a session boundary is a
   *  hard reset, and a stale `chatThreadId` would otherwise make the URL-mirror effect above rewrite the
   *  fresh-login `/` back to the previous user's `/chat/N`. */
  private resetForSessionEnd(): void {
    this.closeAllPanes();
    this.pendingChatTransition.set(undefined);
    this.chatThreadId.set(undefined);
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
      if (
        removed.settingsDrilldown &&
        this.settingsCategoryStack().length > 0
      ) {
        this.settingsCategoryStack.update((s) => s.slice(0, -1));
        return true;
      }
      this.paneStack.set(stack.slice(0, -1));
      removed.onResult?.(undefined);
      return true;
    }
    if (this.aside().length > 0) {
      this.aside.update((stack) => stack.slice(0, -1));
      return true;
    }
    // In-chat search is the innermost overlay (it lives in the chat header): peel it right before the
    // chat itself, so back exits search before leaving the thread.
    if (this.searchOpen()) {
      this.searchOpen.set(false);
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
    if (this.chatThreadId() !== undefined) {
      this.closeChat();
      return true;
    }
    return false;
  }
}
