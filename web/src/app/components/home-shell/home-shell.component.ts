import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterOutlet, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { LayoutService } from '../../services/layout.service';
import { IconRailComponent } from '../desktop/icon-rail/icon-rail.component';
import { NavDrawerComponent } from '../nav-drawer/nav-drawer.component';
import { ChatListPaneComponent } from '../desktop/chat-list-pane/chat-list-pane.component';
import { HomeHeaderComponent } from '../home-header/home-header.component';
import { ConnectionBannerComponent } from '../connection-banner/connection-banner.component';
import { WebsocketService } from '../../services/websocket.service';
import { ConversationItem } from '../../services/model';

const LIST_WIDTH_KEY = 'soms.desktop.listWidth'
const MIN_LIST = 280, MAX_LIST = 480, DEFAULT_LIST = 360

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
  imports: [RouterOutlet, IconRailComponent, NavDrawerComponent, ChatListPaneComponent, HomeHeaderComponent, ConnectionBannerComponent],
  templateUrl: './home-shell.component.html',
  styleUrl: './home-shell.component.scss',
})
export class HomeShellComponent {
  private readonly router = inject(Router)
  private readonly layout = inject(LayoutService)
  private readonly chatListPane = viewChild(ChatListPaneComponent)
  private readonly ws = inject(WebsocketService)

  readonly mode = this.layout.mode

  /** True while the connection banner is visible → the shell reserves `--conn-banner-h` top padding so
   *  desktop/tablet content is pushed down rather than covered by the fixed bar. Kept in lockstep with
   *  ConnectionBannerComponent.label (both read the same `state` signal). */
  readonly bannerActive = computed(() => {
    const s = this.ws.state()
    return s === 'connecting' || s === 'reconnecting'
  })

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
