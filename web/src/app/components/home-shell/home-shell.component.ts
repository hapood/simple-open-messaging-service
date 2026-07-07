import { Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { trigger, transition, state, style, animate, type AnimationEvent } from '@angular/animations';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { LayoutService } from '../../services/layout.service';
import { IconRailComponent } from '../desktop/icon-rail/icon-rail.component';
import { NavDrawerComponent } from '../nav-drawer/nav-drawer.component';
import { ChatListPaneComponent } from '../desktop/chat-list-pane/chat-list-pane.component';
import { HomeHeaderComponent } from '../home-header/home-header.component';
import { ConnectionBannerComponent } from '../connection-banner/connection-banner.component';
import { UpdateBannerComponent } from '../update-banner/update-banner.component';
import { GlobalSearchComponent } from '../global-search/global-search.component';
import { ConversationItem } from '../../services/model';
import { ConversationListService } from '../../services/conversation-list.service';
import { SearchService } from '../../services/search.service';
import { AsideOutletService } from '../../services/aside-outlet.service';

const LIST_WIDTH_KEY = 'soms.desktop.listWidth'
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
 * The single responsive home shell. Hosts the two persistent router-outlets (primary = chat,
 * `aside` = profile/group-info) so they survive every breakpoint change — CSS reflows per layout,
 * routes never remount. The conversation list is always-mounted chrome (the base view on mobile; a
 * column on desktop/tablet). `icon-rail` is desktop-only; `nav-drawer` (hamburger) is tablet/mobile.
 *
 * Layout positioning of the outlets is CSS-driven and gated by `chat-open` / `aside-open` classes
 * derived from the current URL (e.g. the mobile chat overlay is hidden at `/`, so the list shows).
 */
@Component({
  selector: 'app-home-shell',
  imports: [RouterOutlet, IconRailComponent, NavDrawerComponent, ChatListPaneComponent, HomeHeaderComponent, ConnectionBannerComponent, UpdateBannerComponent, GlobalSearchComponent],
  templateUrl: './home-shell.component.html',
  styleUrl: './home-shell.component.scss',
  animations: [overlaySlide],
})
export class HomeShellComponent {
  private readonly router = inject(Router)
  private readonly layout = inject(LayoutService)
  private readonly convList = inject(ConversationListService)
  readonly search = inject(SearchService)
  private readonly asideOutlet = inject(AsideOutletService)
  private readonly chatListPane = viewChild(ChatListPaneComponent)

  readonly mode = this.layout.mode

  /** chat-list width (desktop), persisted across sessions. */
  readonly listWidth = signal<number>(this.readListWidth())

  /** Latest post-navigation URL as a signal — drives the chat/aside "open" classes that position the
   *  overlays per layout (e.g. hide the mobile chat overlay at `/` so the list shows through). */
  private readonly navUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.url),
    ),
    { initialValue: this.router.url },
  )
  readonly chatActive = computed(() => /\/chat\//.test(this.navUrl()))
  readonly asideActive = computed(() => /\(aside:/.test(this.navUrl()))

  /** The numeric thread id parsed from the URL (`/chat/:id`); undefined at `/`. The URL is the source of truth
   *  for which chat is open; this drives the open/close coordination below and (via ConversationListService)
   *  the routed ChatPane. */
  readonly routeThreadId = computed<number | undefined>(() => {
    const m = this.navUrl().match(/\/chat\/(\d+)/)
    return m ? Number(m[1]) : undefined
  })

  /** Drives [@overlaySlide] on the chat-slot: only mobile animates (closed↔open); desktop/tablet stay
   *  `static` so the inline flex column is never transformed. */
  readonly chatSlotState = computed<OverlaySlideState>(() =>
    this.mode() === 'mobile' ? (this.chatActive() ? 'mobile-open' : 'mobile-closed') : 'static',
  )

  /** Drives [@overlaySlide] on the aside-slot: the peer-profile / group-info overlay slides in from the
   *  right on mobile (stacking above the chat at z-index 40). Desktop/tablet stay `static` — the desktop
   *  side panel and the tablet absolute overlay are not transformed. */
  readonly asideSlotState = computed<OverlaySlideState>(() =>
    this.mode() === 'mobile' ? (this.asideActive() ? 'mobile-open' : 'mobile-closed') : 'static',
  )

  constructor() {
    // Route → openThreadId coordination. The URL selects which chat is open; this effect is the single writer
    // of openThreadId's OPEN edge (mark-read + active-row highlight + the chrome ChatPane resolving the
    // thread). The CLOSE edge is timing-aware: on mobile it LAGS so the chat-pane keeps its data through the
    // leave slide (the real chat slides out, then onSlideDone resets it); on desktop/tablet (no slide) it
    // closes immediately.
    effect(() => {
      const tid = this.routeThreadId()
      if (tid !== undefined) {
        this.convList.open(tid)
      } else if (this.mode() !== 'mobile') {
        this.convList.close()
      }
      // mobile close: deferred to onSlideDone('chat', → mobile-closed) below.
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
   *  view (desktop closed immediately in the route effect — no slide, so it never reaches here). Counter-based,
   *  so interrupted transitions stay balanced: every start has a matching done. */
  onSlideDone(event: AnimationEvent, slot: 'chat' | 'aside'): void {
    if (event.toState === 'mobile-open' || event.toState === 'mobile-closed') this.layout.thawReflow()
    if (slot === 'chat' && event.toState === 'mobile-closed' && this.routeThreadId() === undefined) {
      this.convList.close()
    }
  }

  /** Open a conversation by route, closing any open info panel (it is scoped to the previous chat).
   *
   *  History is what makes in-app back behave: drilling from the list INTO a chat PUSHES a layer (so the
   *  stack is [home, chat] and back returns to the list — one layer up); only switching from one chat to
   *  ANOTHER replaces (lateral moves from the always-mounted desktop list must not stack a thread per
   *  click). Browser-back past the list is left to the browser (no interception). */
  openChat(item: ConversationItem) {
    const lateralSwitch = /\/chat\//.test(this.router.url)
    this.router.navigate(['chat', item.threadId, { outlets: { aside: null } }], { replaceUrl: lateralSwitch })
  }

  /** Close the aside drawer (clears the named outlet). Wired to the desktop drawer-mask click. Delegates
   *  to AsideOutletService, which pops the pushed panel-open entry so back can't re-open it. */
  closeAside() {
    this.asideOutlet.close()
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
