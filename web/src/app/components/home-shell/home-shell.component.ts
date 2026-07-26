import { Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { trigger, transition, state, style, animate, type AnimationEvent } from '@angular/animations';
import { LayoutService } from '../../services/layout.service';
import { NavStateMachineService, type AsidePanel } from '../../services/nav-state.service';
import { IconRailComponent } from '../desktop/icon-rail/icon-rail.component';
import { ChatListPaneComponent } from '../desktop/chat-list-pane/chat-list-pane.component';
import { ChatPaneComponent } from '../desktop/chat-pane/chat-pane.component';
import { PeerProfileComponent } from '../peer-profile/peer-profile.component';
import { GroupInfoComponent } from '../group-info/group-info.component';
import { SettingsComponent } from '../settings/settings.component';
import { HomeHeaderComponent } from '../home-header/home-header.component';
import { ProfileSectionComponent } from '../profile-section/profile-section.component';
import { ConversationItem } from '../../services/model';
import { ConversationListService } from '../../services/conversation-list.service';

const LIST_WIDTH_KEY = 'soms.client.listWidth'
const MIN_LIST = 280, MAX_LIST = 480, DEFAULT_LIST = 360

/** Mobile overlay transition state. `static` = desktop/tablet (the slot is an inline flex column / side
 *  panel, no transform); `mobile-closed` = off-screen right + hidden (the list/chat shows through);
 *  `mobile-open` = in place as a full-screen overlay. */
type OverlaySlideState = 'static' | 'mobile-closed' | 'mobile-open'

/** Mobile drill-in slide for the chat and aside overlays. Replaces the old display:none↔flex flip (display
 *  is not animatable): on mobile both slots use translate3d + visibility so the overlay glides in from the
 *  right and out again. Desktop/tablet resolve to `static` (transform:none, visible) — the inline columns
 *  are untouched, and the tablet aside keeps its display:none↔flex show/hide. The 0ms `* <=> static`
 *  transitions snap instantly on breakpoint change (resize/rotate), so a slide never plays on non-mobile.
 *  `(@overlaySlide.start)/.done` double as deterministic immunity-frame hooks. One trigger bound on two
 *  elements; each slides independently from its own bound state. */
const overlaySlide = trigger('overlaySlide', [
  state('static', style({ transform: 'none', visibility: 'visible' })),
  state('mobile-closed', style({ transform: 'translate3d(100%, 0, 0)', visibility: 'hidden' })),
  state('mobile-open', style({ transform: 'translate3d(0, 0, 0)', visibility: 'visible' })),
  // Same timing language as root-popup's ENTER/LEAVE so motion is consistent across the app.
  transition('mobile-closed => mobile-open', animate('300ms cubic-bezier(0.32, 0.72, 0, 1)')),
  transition('mobile-open => mobile-closed', animate('200ms cubic-bezier(0.4, 0, 1, 1)')),
  transition('* => static', animate('0ms')),
  transition('static => *', animate('0ms')),
])

/**
 * The single responsive home shell. Hosts the always-mounted chat surface + the aside panel — both driven
 * by {@link NavStateMachineService} signals (NO router-outlets: the router only renders this shell for `/`
 * and `/chat/:threadId`; the state machine owns which thread/panel is shown and mirrors the URL one-way via
 * replaceState). The conversation list is always-mounted chrome (the base view on mobile; a column on
 * desktop/tablet). `icon-rail` is desktop-only; `nav-drawer` (hamburger) is tablet/mobile.
 *
 * Layout positioning of the chat/aside slots is CSS-driven and gated by `chat-open` / `aside-open` classes
 * derived from the nav state (e.g. the mobile chat overlay is hidden when no thread is open, so the list
 * shows through).
 */
@Component({
  selector: 'app-home-shell',
  imports: [IconRailComponent, ChatListPaneComponent, ChatPaneComponent, PeerProfileComponent, GroupInfoComponent, SettingsComponent, HomeHeaderComponent, ProfileSectionComponent],
  templateUrl: './home-shell.component.html',
  styleUrl: './home-shell.component.scss',
  animations: [overlaySlide],
})
export class HomeShellComponent {
  private readonly layout = inject(LayoutService)
  private readonly convList = inject(ConversationListService)
  private readonly navState = inject(NavStateMachineService)
  private readonly chatListPane = viewChild(ChatListPaneComponent)

  readonly mode = this.layout.mode
  /** Active mobile/tablet home section (the account menu opens Profile or Settings). Desktop ignores it. */
  readonly topSection = this.navState.topSection

  /** chat-list width (desktop), persisted across sessions. */
  readonly listWidth = signal<number>(this.readListWidth())

  /** Chat/aside "open" classes position the mobile overlays (and toggle the desktop drawer mask). */
  readonly chatActive = computed(() => this.navState.chatThreadId() !== undefined)
  /** A chat-scoped overlay (peer-profile / group-info) is open. */
  readonly asideActive = computed(() => this.navState.aside().length > 0)
  /** The aside panel kind (template @switch), or undefined when no aside is open. Drawn from the topmost
   *  aside stack entry — drilling into a sub-page keeps the same `panel`, only the entry's `params` change. */
  readonly asidePanel = computed<AsidePanel | undefined>(() => this.navState.asideTop()?.panel)

  /** Drives [@overlaySlide] on the chat-slot: only mobile animates (closed↔open); desktop/tablet stay
   *  `static` so the inline flex column is never transformed. */
  readonly chatSlotState = computed<OverlaySlideState>(() =>
    this.mode() === 'mobile' ? (this.chatActive() ? 'mobile-open' : 'mobile-closed') : 'static',
  )

  /** Drives [@overlaySlide] on the aside-slot: the peer-profile / group-info overlay slides in from the
   *  right on mobile (stacking above the chat at z-index 40). Desktop/tablet stay `static`. */
  readonly asideSlotState = computed<OverlaySlideState>(() =>
    this.mode() === 'mobile' ? (this.asideActive() ? 'mobile-open' : 'mobile-closed') : 'static',
  )

  /** Guards the breakpoint effect so the transient-state reset does NOT fire on the initial mode read. */
  private modeInitialized = false

  constructor() {
    // Nav state → openThreadId coordination. The state machine is the source of truth for which chat is
    // open; this effect is the single writer of openThreadId's OPEN edge (mark-read + active-row highlight
    // + the always-mounted ChatPane resolving the thread). The CLOSE edge is timing-aware: on mobile it
    // LAGS so the chat-pane keeps its data through the leave slide (the real chat slides out, then
    // onSlideDone resets it); on desktop (no slide) it closes immediately.
    effect(() => {
      const tid = this.navState.chatThreadId()
      if (tid !== undefined) {
        this.convList.open(tid)
      } else if (this.mode() !== 'mobile') {
        this.convList.close()
      }
      // mobile close: deferred to onSlideDone('chat', → mobile-closed) below.
    })

    // Viewport crossed the desktop/mobile breakpoint: drop transient nav state (open dialogs, aside,
    // in-chat search, and the active section) — the section/overlay model differs per layout — but KEEP
    // the open chat (the user's anchor context). Skipped on the initial read (state is already default).
    effect(() => {
      this.mode()
      if (!this.modeInitialized) { this.modeInitialized = true; return }
      this.navState.resetTransientExceptChat()
    })
  }

  /** (@overlaySlide.start) — open the immunity frame for the real mobile slide. The 0ms static snaps
   *  triggered by a breakpoint change are excluded (their toState is `static`), so freezing can't leak on
   *  resize. Fires for the chat and the aside slide alike; the counter absorbs concurrent/overlapping
   *  transitions (e.g. aside opening over a still-closing chat). */
  onSlideStart(event: AnimationEvent): void {
    if (event.toState === 'mobile-open' || event.toState === 'mobile-closed') this.layout.freezeReflow()
  }
  /** (@overlaySlide.done) — close the immunity frame, AND on a mobile chat-close finish the lagged reset:
   *  clear openThreadId so the chrome ChatPane tears down its kernel now that the real chat has slid out of
   *  view (desktop closed immediately in the nav effect — no slide, so it never reaches here). Counter-based,
   *  so interrupted transitions stay balanced: every start has a matching done. */
  onSlideDone(event: AnimationEvent, slot: 'chat' | 'aside'): void {
    if (event.toState === 'mobile-open' || event.toState === 'mobile-closed') this.layout.thawReflow()
    if (slot === 'chat' && event.toState === 'mobile-closed' && this.navState.chatThreadId() === undefined) {
      this.convList.close()
    }
  }

  /** Open a conversation. The state machine sets chatThreadId (→ URL mirror + this shell's convList.open
   *  effect via the A/B pane buffer) and closes any chat-scoped aside on a thread switch. */
  openChat(item: ConversationItem) {
    this.navState.openChat(item.threadId)
  }

  /** Close the aside drawer (desktop drawer-mask click). The state machine clears the aside signal. */
  closeAside() {
    this.navState.closeAside()
  }

  /** After a group is created, refresh the shared thread list (forwarded to icon-rail / nav-drawer). */
  refresh = () => this.chatListPane()?.refresh()

  // --- resizable chat-list pane (desktop only) ---
  startResize(event: MouseEvent) {
    event.preventDefault()
    const startX = event.clientX
    const startW = this.listWidth()
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_LIST, Math.max(MIN_LIST, startW + (ev.clientX - startX)))
      this.listWidth.set(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      this.saveListWidth(this.listWidth())
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  resetWidth() {
    this.listWidth.set(DEFAULT_LIST)
    this.saveListWidth(DEFAULT_LIST)
  }
  private readListWidth(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_LIST
    const raw = localStorage.getItem(LIST_WIDTH_KEY)
    const n = raw ? parseInt(raw, 10) : DEFAULT_LIST
    return Number.isFinite(n) ? Math.min(MAX_LIST, Math.max(MIN_LIST, n)) : DEFAULT_LIST
  }
  private saveListWidth(w: number) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LIST_WIDTH_KEY, String(w))
  }
}
