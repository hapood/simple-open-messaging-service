import { Component, computed, inject, signal, viewChild } from '@angular/core';
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
import { ConversationItem } from '../../services/model';

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
  imports: [RouterOutlet, IconRailComponent, NavDrawerComponent, ChatListPaneComponent, HomeHeaderComponent, ConnectionBannerComponent, UpdateBannerComponent],
  templateUrl: './home-shell.component.html',
  styleUrl: './home-shell.component.scss',
  animations: [overlaySlide],
})
export class HomeShellComponent {
  private readonly router = inject(Router)
  private readonly layout = inject(LayoutService)
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

  /** (@overlaySlide.start) — open the immunity frame for the real mobile slide. The 0ms static snaps
   *  triggered by a breakpoint change are excluded (their toState is `static`), so freezing can't leak on
   *  resize. Fires for the chat and the aside slide alike; the counter absorbs concurrent/overlapping
   *  transitions (e.g. aside opening over a still-closing chat). */
  onSlideStart(event: AnimationEvent): void {
    if (event.toState === 'mobile-open' || event.toState === 'mobile-closed') this.layout.freezeReflow()
  }
  /** (@overlaySlide.done) — close the immunity frame. Counter-based, so interrupted transitions (a new slide
   *  beginning before the previous finishes) stay balanced: every start has a matching done. */
  onSlideDone(event: AnimationEvent): void {
    if (event.toState === 'mobile-open' || event.toState === 'mobile-closed') this.layout.thawReflow()
  }

  /** Open a conversation by route, closing any open info panel (it is scoped to the previous chat). */
  openChat(item: ConversationItem) {
    this.router.navigate(['chat', item.threadId, { outlets: { aside: null } }])
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
