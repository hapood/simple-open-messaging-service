import {
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  trigger,
  transition,
  state,
  style,
  animate,
  type AnimationEvent,
} from '@angular/animations';
import { LayoutService, type LayoutMode } from '../../services/layout.service';
import {
  NavStateMachineService,
  type AsidePanel,
} from '../../services/nav-state.service';
import { IconRailComponent } from '../desktop/icon-rail/icon-rail.component';
import { ChatListPaneComponent } from '../desktop/chat-list-pane/chat-list-pane.component';
import { ChatPaneComponent } from '../desktop/chat-pane/chat-pane.component';
import { PeerProfileComponent } from '../peer-profile/peer-profile.component';
import { GroupInfoComponent } from '../group-info/group-info.component';
import { HomeHeaderComponent } from '../home-header/home-header.component';
import { ConversationItem } from '../../services/model';
import { ConversationListService } from '../../services/conversation-list.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { UploadDetailDialogComponent } from '../upload-detail-dialog/upload-detail-dialog.component';

const LIST_WIDTH_KEY = 'soms.client.listWidth';
const MIN_LIST = 280,
  MAX_LIST = 480,
  DEFAULT_LIST = 360;
const LIST_KEY_STEP = 16;

/** Pure keyboard-width reducer kept outside the component so the resizer contract is regression-testable
 *  without mounting the full authenticated shell. Returns undefined for keys the separator does not own. */
export function nextConversationListWidth(
  current: number,
  key: string,
): number | undefined {
  let candidate: number;
  if (key === 'ArrowLeft') candidate = current - LIST_KEY_STEP;
  else if (key === 'ArrowRight') candidate = current + LIST_KEY_STEP;
  else if (key === 'Home') candidate = MIN_LIST;
  else if (key === 'End') candidate = MAX_LIST;
  else return undefined;
  return Math.min(MAX_LIST, Math.max(MIN_LIST, candidate));
}

/** Only expanded has a different top-level destination model (rail + dialogs instead of inline sections). */
export function crossesExpandedLayout(
  previous: LayoutMode,
  next: LayoutMode,
): boolean {
  return previous !== next && (previous === 'expanded' || next === 'expanded');
}

/** Compact overlay transition state. `static` = medium/expanded (inline chat / side panel, no transform);
 *  `mobile-closed` = off-screen right + hidden; `mobile-open` = in place as a full-screen overlay. The
 *  animation-state names stay stable to avoid a noisy motion migration while the layout vocabulary changes. */
type OverlaySlideState = 'static' | 'mobile-closed' | 'mobile-open';

/** Mobile drill-in slide for the chat and aside overlays. Replaces the old display:none↔flex flip (display
 *  is not animatable): on mobile both slots use translate3d + visibility so the overlay glides in from the
 *  right and out again. Desktop/tablet resolve to `static` (transform:none, visible) — the inline columns
 *  are untouched, and the tablet aside keeps its display:none↔flex show/hide. The 0ms `* <=> static`
 *  transitions snap instantly on breakpoint change (resize/rotate), so a slide never plays on non-mobile.
 *  `(@overlaySlide.start)/.done` double as deterministic immunity-frame hooks. One trigger bound on two
 *  elements; each slides independently from its own bound state. */
const overlaySlide = trigger('overlaySlide', [
  state('static', style({ transform: 'none', visibility: 'visible' })),
  state(
    'mobile-closed',
    style({ transform: 'translate3d(100%, 0, 0)', visibility: 'hidden' }),
  ),
  state(
    'mobile-open',
    style({ transform: 'translate3d(0, 0, 0)', visibility: 'visible' }),
  ),
  // Same timing language as root-popup's ENTER/LEAVE so motion is consistent across the app.
  transition(
    'mobile-closed => mobile-open',
    animate('300ms cubic-bezier(0.32, 0.72, 0, 1)'),
  ),
  transition(
    'mobile-open => mobile-closed',
    animate('200ms cubic-bezier(0.4, 0, 1, 1)'),
  ),
  transition('* => static', animate('0ms')),
  transition('static => *', animate('0ms')),
]);

/**
 * The single responsive home shell. Hosts the always-mounted chat surface + the aside panel — both driven
 * by {@link NavStateMachineService} signals (NO router-outlets: the router only renders this shell for `/`
 * and `/chat/:threadId`; the state machine owns which thread/panel is shown and mirrors the URL one-way via
 * replaceState). The conversation list is always-mounted chrome (the base view in compact; a column in
 * medium/expanded). The icon rail and resizer exist only in expanded.
 *
 * Layout positioning of the chat/aside slots is CSS-driven and gated by `chat-open` / `aside-open` classes
 * derived from the nav state (e.g. the mobile chat overlay is hidden when no thread is open, so the list
 * shows through).
 */
@Component({
  selector: 'app-home-shell',
  imports: [
    IconRailComponent,
    ChatListPaneComponent,
    ChatPaneComponent,
    PeerProfileComponent,
    GroupInfoComponent,
    HomeHeaderComponent,
    UploadDetailDialogComponent,
    TranslocoPipe,
  ],
  templateUrl: './home-shell.component.html',
  styleUrl: './home-shell.component.scss',
  animations: [overlaySlide],
})
export class HomeShellComponent {
  private readonly layout = inject(LayoutService);
  private readonly convList = inject(ConversationListService);
  private readonly navState = inject(NavStateMachineService);
  private readonly chatListPane = viewChild(ChatListPaneComponent);

  readonly mode = this.layout.mode;
  /** Conversation-list width (expanded only), persisted across sessions. */
  readonly listWidth = signal<number>(this.readListWidth());

  /** Chat/aside "open" classes position compact overlays and toggle medium/expanded drawers. */
  readonly chatActive = computed(
    () => this.navState.chatThreadId() !== undefined,
  );
  /** A chat-scoped overlay (peer-profile / group-info) is open. */
  readonly asideActive = computed(() => this.navState.aside().length > 0);
  /** The aside panel kind (template @switch), or undefined when no aside is open. Drawn from the topmost
   *  aside stack entry — drilling into a sub-page keeps the same `panel`, only the entry's `params` change. */
  readonly asidePanel = computed<AsidePanel | undefined>(
    () => this.navState.asideTop()?.panel,
  );

  /** Drives [@overlaySlide] on the chat-slot: only compact animates (closed↔open); medium/expanded stay
   *  `static` so the inline flex column is never transformed. */
  readonly chatSlotState = computed<OverlaySlideState>(() =>
    this.mode() === 'compact'
      ? this.chatActive()
        ? 'mobile-open'
        : 'mobile-closed'
      : 'static',
  );

  /** Drives [@overlaySlide] on the aside-slot: the peer-profile / group-info overlay slides in from the
   *  right in compact (stacking above the chat at z-index 40). Medium/expanded stay `static`. */
  readonly asideSlotState = computed<OverlaySlideState>(() =>
    this.mode() === 'compact'
      ? this.asideActive()
        ? 'mobile-open'
        : 'mobile-closed'
      : 'static',
  );

  /** Previous adaptive mode, used to distinguish compact↔medium (same top-section model) from transitions
   *  involving expanded layout, where the inline Profile/Settings section has no mount point. */
  private previousMode: LayoutMode | undefined;

  constructor() {
    // Nav state → openThreadId coordination. The state machine is the source of truth for which chat is
    // open; this effect is the single writer of openThreadId's OPEN edge (mark-read + active-row highlight
    // + the always-mounted ChatPane resolving the thread). The CLOSE edge is timing-aware: on mobile it
    // LAGS so the chat-pane keeps its data through the leave slide (the real chat slides out, then
    // onSlideDone resets it); on desktop (no slide) it closes immediately.
    effect(() => {
      const tid = this.navState.chatThreadId();
      if (tid !== undefined) {
        this.convList.open(tid);
      } else if (this.mode() !== 'compact') {
        this.convList.close();
      }
      // compact close: deferred to onSlideDone('chat', → mobile-closed) below.
    });

    // Responsive overlays, search, and chat-scoped asides survive resize/rotation. Only a transition into
    // or out of expanded layout leaves the compact/medium inline Profile/Settings section, because expanded
    // exposes those destinations through the rail/dialog model instead. Compact↔medium keeps everything.
    effect(() => {
      const mode = this.mode();
      const previous = this.previousMode;
      this.previousMode = mode;
      if (previous !== undefined && crossesExpandedLayout(previous, mode))
        this.navState.resetAdaptiveTopSection();
    });
  }

  /** (@overlaySlide.start) — open the immunity frame for the real mobile slide. The 0ms static snaps
   *  triggered by a breakpoint change are excluded (their toState is `static`), so freezing can't leak on
   *  resize. Fires for the chat and the aside slide alike; the counter absorbs concurrent/overlapping
   *  transitions (e.g. aside opening over a still-closing chat). */
  onSlideStart(event: AnimationEvent): void {
    if (event.toState === 'mobile-open' || event.toState === 'mobile-closed')
      this.layout.freezeReflow();
  }
  /** (@overlaySlide.done) — close the immunity frame, AND on a mobile chat-close finish the lagged reset:
   *  clear openThreadId so the chrome ChatPane tears down its kernel now that the real chat has slid out of
   *  view (desktop closed immediately in the nav effect — no slide, so it never reaches here). Counter-based,
   *  so interrupted transitions stay balanced: every start has a matching done. */
  onSlideDone(event: AnimationEvent, slot: 'chat' | 'aside'): void {
    if (event.toState === 'mobile-open' || event.toState === 'mobile-closed')
      this.layout.thawReflow();
    if (
      slot === 'chat' &&
      event.toState === 'mobile-closed' &&
      this.navState.chatThreadId() === undefined
    ) {
      this.convList.close();
    }
  }

  /** Open a conversation. The state machine sets chatThreadId (→ URL mirror + this shell's convList.open
   *  effect via the A/B pane buffer) and closes any chat-scoped aside on a thread switch. */
  openChat(item: ConversationItem) {
    this.navState.openChat(item.threadId);
  }

  /** Close the aside drawer (desktop drawer-mask click). The state machine clears the aside signal. */
  closeAside() {
    this.navState.closeAside();
  }

  /** After a group is created, refresh the shared thread list (forwarded to icon-rail / nav-drawer). */
  refresh = () => this.chatListPane()?.refresh();

  // --- resizable conversation-list pane (expanded only) ---
  startResize(event: MouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = this.listWidth();
    const onMove = (ev: MouseEvent) => {
      this.listWidth.set(this.clampListWidth(startW + (ev.clientX - startX)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this.saveListWidth(this.listWidth());
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  resetWidth() {
    this.listWidth.set(DEFAULT_LIST);
    this.saveListWidth(DEFAULT_LIST);
  }
  /** Keyboard equivalent of the pointer resizer. Arrow keys adjust by one spacing step; Home/End jump to
   *  bounds. Persist immediately because a keyboard interaction has no pointer-up commit edge. */
  onResizerKeydown(event: KeyboardEvent) {
    const next = nextConversationListWidth(this.listWidth(), event.key);
    if (next === undefined) return;
    event.preventDefault();
    this.listWidth.set(next);
    this.saveListWidth(next);
  }
  private readListWidth(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_LIST;
    const raw = localStorage.getItem(LIST_WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : DEFAULT_LIST;
    return Number.isFinite(n) ? this.clampListWidth(n) : DEFAULT_LIST;
  }
  private clampListWidth(w: number) {
    return Math.min(MAX_LIST, Math.max(MIN_LIST, w));
  }
  private saveListWidth(w: number) {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(LIST_WIDTH_KEY, String(w));
  }
}
