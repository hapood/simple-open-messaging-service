import {
  Component, ElementRef, OnDestroy, inject, isDevMode,
  signal, viewChild, ChangeDetectionStrategy, ViewEncapsulation,
  EnvironmentInjector,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatBoxScroller, ScrollerApi, CbElement, CbItem, CbConfig, CbOptions, CbScrollInfo, CbDebugStats } from '../../lib/chat-box/chat-box-scroller';
import { ChatBoxScrollerAnchor } from '../../lib/chat-box/chat-box-scroller-anchor';
import { pickStickyDateLabel, stickyDateRowOpacity, isViewportTransformEnd } from '../../lib/sticky-date';
import { ActivatedRoute } from '@angular/router';
import { LayoutService } from '../../services/layout.service';
import { ThemeService } from '../../services/theme.service';
import { createMsgCbElement, createGhostCbElement, computeRowFlags } from '../../components/message-cards/create-item';
import { mergeAlbumItems, absorbAlbumTail } from '../../components/message-cards/merge-items';
import { GalleryViewerService } from '../../components/gallery-viewer/gallery-viewer.service';
import { FileDetailService } from '../../components/file-detail-viewer/file-detail-viewer.service';
import { ConnectionBannerComponent } from '../../components/connection-banner/connection-banner.component';
import { UpdateBannerComponent } from '../../components/update-banner/update-banner.component';
import { IndicatorSlotComponent } from '../../components/indicator-slot/indicator-slot.component';
import type { ConnectionState } from '../../services/websocket.service';
import type { AlbumImage, ChatItemData, ChatMsgData, FileInfo } from '../../components/message-cards/chat-item';
import { MockItemSource, MockUserService } from './http-item-source.mock';
import { UserAvatarComponent } from '../../components/user-avatar/user-avatar.component';
import { ChatMember } from '../../components/chat-editor/chat-editor.component';
import { ChatInputComponent, ChatSendIntent } from '../../lib/chat-input/chat-input.component';
import { KbdOffsetDirective } from '../../directives/kbd-offset.directive';
import { StickyDateOverlayComponent } from '../../components/message-cards/sticky-date-overlay/sticky-date-overlay.component';
import { uuid } from '../../lib/uuid';

// Angular production AOT sets the global ngDevMode to falsy and uses it for dead-code elimination (same pattern as the
// virtual-scroll kernel). It guards the "dev badge injection" — production builds create no badge DOM (zero overhead);
// in non-Angular environments the global is undefined, which likewise disables it.
declare const ngDevMode: boolean | null | undefined;

// Kernel tuning defaults (kept in sync with DEFAULTS in chat-box-scroller.ts / anchor.ts). mountPx was removed (dead param of the array kernel).
const CB_DEFAULTS: Required<CbConfig> = { edge: 1000, mountItem: 50, thresholdFloor: 6000, vhExtra: 2000, initBatch: 100 };

/**
 * Virtual-scroll playground.
 *
 * Rendering is identical to the real chat — createItem calls createMsgCbElement (the real message-cards components).
 * Data and behavior are fully mocked (no HTTP, no login/backend dependency): the {@link MockChatApi} generator produces
 * N stable records up front; send/upload/opponent-reply all go through mock APIs whose inputs/outputs are logged.
 *
 * Data is loaded in full (generate → setItems → scrollToBottom); no onLoadMore is supplied — balance naturally mounts
 * older items, so no history paging is needed. Jumping to a given id goes through the kernel scrollToIndex (both A/B kernels support it).
 *
 * [Style boundary] This component is ViewEncapsulation.None (global pg- prefix), but it MUST NEVER write CSS that
 * targets the inside of the chat content (.msg-row/.msg-bubble are owned by the message-cards components' _row-base) —
 * otherwise global rules would alter the measured row heights and corrupt the kernel's offsetHeight logic. This file
 * owns only the shell: stage/header/viewport containers/panel/input bar/FAB.
 */
@Component({
  selector: 'app-chatbox-playground',
  imports: [FormsModule, UserAvatarComponent, ChatInputComponent, KbdOffsetDirective, StickyDateOverlayComponent, ConnectionBannerComponent, UpdateBannerComponent, IndicatorSlotComponent],
  templateUrl: './chatbox-playground.component.html',
  styleUrl: './chatbox-playground.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class ChatboxPlaygroundComponent implements OnDestroy {
  private readonly layout = inject(LayoutService);
  private readonly route = inject(ActivatedRoute);
  /** EnvironmentInjector for dynamically creating message components (zoneless: createComponent + detectChanges drives rendering). */
  private readonly envInjector = inject(EnvironmentInjector);
  /** Album click → fullscreen gallery viewer (CDK Overlay, service-hosted; no per-host template mounting needed). */
  private readonly galleryViewer = inject(GalleryViewerService);
  /** File-card click → fullscreen file-detail overlay (same transient-overlay pattern as the gallery). */
  private readonly fileDetail = inject(FileDetailService);
  /** Plan A (browser overflow-anchor) is selected by route data.useNativeAnchor: the -a route sets it true; -b (default) uses Plan B (manual compensation). */
  readonly useNativeAnchor = (this.route.snapshot.data as { useNativeAnchor?: boolean }).useNativeAnchor === true;
  /** Desktop-class viewport (wide screen ≥1280px, width-only): true = persistent side rail; false = mobile drawer + FAB. */
  readonly isDesktop = this.layout.isDesktop;
  /** Mobile control-panel drawer toggle. */
  readonly panelOpen = signal(false);

  /** Mock data source (implements CbSource; the buildItems generator paginates). Created with `count` at setup. */
  private source?: MockItemSource;
  /** Generator loading (disables the data-volume buttons to prevent re-entry). */
  readonly loading = signal(false);
  /** Transient toast (e.g. jump miss), auto-cleared. */
  readonly toast = signal<string | null>(null);
  private toastTimer?: ReturnType<typeof setTimeout>;

  private readonly viewportRef = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly contentRef = viewChild<ElementRef<HTMLDivElement>>('content');
  private readonly fabRef = viewChild<ElementRef<HTMLButtonElement>>('fab');
  /** The chat header element — its bottom edge is the STABLE visible-top reference for the sticky-date pill
   *  (the viewport's own top slides under the header while the keyboard-lift transform is active). */
  private readonly headerRef = viewChild('pgHeader', { read: ElementRef<HTMLElement> });
  private readonly jumpInput = viewChild<ElementRef<HTMLInputElement>>('jumpInput');
  private readonly insertInput = viewChild<ElementRef<HTMLInputElement>>('insertInput');
  private readonly removeInput = viewChild<ElementRef<HTMLInputElement>>('removeInput');

  private scroller?: ScrollerApi<ChatItemData>;

  /** Remaining height above the viewport (= scrollTop; headroom scrollable up to the window top; debug). */
  readonly viewportAbove = signal(0);
  /** Remaining height below the viewport (= scrollHeight - vh - scrollTop; headroom scrollable down to the window bottom; debug). */
  readonly viewportBelow = signal(0);
  /** Whether pinned to the bottom (decides whether to follow on new messages). */
  readonly atBottom = signal(true);
  /** Debug mode: enables FAB badges + balance diagnostics to the console; all off in performance mode. */
  readonly debugMode = signal(true);
  /** Debug: disables mount checkpoints (balance won't trigger loadOlder/loadNewer). Default false (checkpoints load normally). Dev-only (kernel ngDevMode-guarded; stripped by production AOT). */
  readonly closeCheckpoint = signal(false);
  /** Source get latency (ms, simulates slow IO). Default 200; adjustable to 0/1s/5s to test loading/compensation behavior. */
  readonly sourceLatency = signal(200);
  /** Mock server-echo delay (ms): how long an optimistic bubble stays 'sending' before confirm flips it to 'sent'. Default 800. */
  readonly confirmDelay = signal(800);
  /** Mock WS reply delay (ms): time after confirm before the other party's message is pushed via appendLive. Default 1500. */
  readonly replyDelay = signal(1500);
  /** Mock WS push-signal delay (ms): time after the server caches the confirmed message before the WS signal delivers
   *  it (onMessageSignal → reconcile). Models broadcast latency — during it the optimistic bubble keeps showing the
   *  'sending' spinner. Default 0 (reconcile on the next tick, as before). */
  readonly pushSignalDelay = signal(0);
  /** Opponent-interleave scenario: on each send, deliver an opponent message in the same confirm batch, ordered
   *  BEFORE the sent message (it mounts above the optimistic bubble). Reproduces the "a reply lands above my sent
   *  message" race for testing the kernel's optimistic-tail mount ordering. Default off (chronological below-reply). */
  readonly opponentInterleave = signal(false);
  /** How many opponent (incoming) messages are pushed after each send. 0 = none — only your self-sent message confirms
   *  (the optimistic-send → check-fade flow in isolation, with no replies cluttering the chat). N > 0 = N opponent
   *  messages arrive per send. Does NOT affect the confirm reconcile itself (the server echo of your own message still
   *  arrives via onMessageSignal); only the "incoming reply" side of the mock WS. Default 1 (one below-reply). */
  readonly opponentPushCount = signal(1);
  /** Persistent setting: when on, EVERY send's confirm fails (network/timeout model) — the optimistic bubble is rebuilt
   *  as a failed bubble (retry glyph) instead of confirming. Stays on until toggled off, so the failure/retry flow can be
   *  exercised repeatedly without re-arming. To test "fail then succeed": turn on → send → turn off → click retry. */
  readonly mockSendError = signal(false);
  /** Drives `<app-connection-banner [demoState]>` via the chip's `demoState` override, pinning it to each
   *  ConnectionState in turn. Defaulted to `connecting` so the restyled Material chip is visible on first
   *  paint; the panel's "Connection chip" group toggles it through every state, and a `reconnecting → open`
   *  hop replays the recover flourish. */
  readonly connStatus = signal<ConnectionState>('connecting');
  /** Drives `<app-update-banner [demoAvailable]>` via the banner's demo override. In production this is the
   *  service worker's VERSION_READY latch (disabled in dev, so the playground simulates it). Default false
   *  (idle); set true to preview the "new version available" pill and watch it defer to the connection chip
   *  via the shared indicator slot. The banner's own Dismiss emits demoDismiss → clears this. */
  readonly updateDemo = signal(false);
  /** Skeleton preview override for the chat viewport. `false` (Auto) = the shimmer shows only during the
   *  `loading()` window (data generation); `true` (On) pins it so the skeleton can be inspected without waiting
   *  for a load or raising source latency. Same demo-override shape as connStatus/updateDemo, but consumed
   *  locally — it drives the skeleton `@if` in the template, not a child component input. */
  readonly skeletonDemo = signal(false);
  /** Kernel tuning (CbConfig). Passed to the kernel at setup; editing it via the modal → applyConfig rebuilds to take effect. */
  readonly config = signal<Required<CbConfig>>({ ...CB_DEFAULTS });
  /** Config-edit modal open flag + draft (applied only on confirm, so editing one field doesn't rebuild mid-stream). */
  readonly configModalOpen = signal(false);
  readonly configDraft = signal<Required<CbConfig>>({ ...CB_DEFAULTS });
  /** Telegram-style sticky date: the date label for the top of the viewport (updated live on scroll; null = no overlay shown). */
  readonly stickyDate = signal<string | null>(null);
  /** App-wide light/dark controller — the SAME ThemeService production uses (it writes <html data-theme>).
   *  No local theme signal or matchMedia: the playground's theme behavior is identical to the rest of the app. */
  readonly theme = inject(ThemeService);
  cycleTheme(): void { this.theme.cycleMode(); }

  // Controls
  /** Data-volume input (the Set button builds the source with this count and inits the kernel). Default 100. */
  readonly countInput = signal(100);
  /** Whether the kernel currently holds data — false on mount and after Reset, true after a successful Set. */
  readonly hasData = signal(false);
  /** @mention candidates (mock group members; production swaps in GroupService.getMembers()). */
  readonly members = signal<ChatMember[]>(MOCK_MEMBERS);

  togglePanel() { this.panelOpen.update(v => !v); }
  closePanel() { this.panelOpen.set(false); }

  // FAB: drag to reposition; on release it snaps to the nearest horizontal edge. Movement below the threshold counts as a click (toggles the panel).
  onFabDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // ignore non-left mouse buttons
    const fab = this.fabRef()?.nativeElement;
    if (!fab) return;
    e.preventDefault();
    const rect = fab.getBoundingClientRect();
    this.fabStartX = e.clientX;
    this.fabStartY = e.clientY;
    this.fabStartLeft = rect.left;
    this.fabStartTop = rect.top;
    this.fabMoved = false;
    // Switch from right/bottom anchoring to left/top so the FAB can be freely positioned.
    fab.style.left = `${rect.left}px`;
    fab.style.top = `${rect.top}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    fab.classList.add('pg-fab-dragging');
    this.fabDragging = true;
    window.addEventListener('pointermove', this.onFabMove);
    window.addEventListener('pointerup', this.onFabUp);
  }

  private onFabMove = (e: PointerEvent) => {
    if (!this.fabDragging) return;
    const fab = this.fabRef()?.nativeElement;
    if (!fab) return;
    const dx = e.clientX - this.fabStartX;
    const dy = e.clientY - this.fabStartY;
    if (!this.fabMoved && Math.hypot(dx, dy) < 5) return; // activation threshold — protects the click
    this.fabMoved = true;
    const w = fab.offsetWidth, h = fab.offsetHeight;
    // Boundary clamp: keep the whole button inside the viewport with an 8px margin.
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, this.fabStartLeft + dx));
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, this.fabStartTop + dy));
    fab.style.left = `${left}px`;
    fab.style.top = `${top}px`;
  };

  private onFabUp = (e: PointerEvent) => {
    window.removeEventListener('pointermove', this.onFabMove);
    window.removeEventListener('pointerup', this.onFabUp);
    const fab = this.fabRef()?.nativeElement;
    fab?.classList.remove('pg-fab-dragging');
    const wasMoved = this.fabMoved;
    this.fabDragging = false;
    this.fabMoved = false;
    if (!wasMoved) { this.togglePanel(); return; } // click → toggle the panel
    // Drag end: snap to the nearest horizontal edge (vertical position preserved).
    if (fab) {
      const targetLeft = e.clientX < window.innerWidth / 2 ? 16 : window.innerWidth - fab.offsetWidth - 16;
      fab.style.left = `${targetLeft}px`;
    }
  };

  private lastEmit = 0;
  private lastDebugLog = 0;

  // FAB drag state
  private fabDragging = false;
  private fabMoved = false;
  private fabStartX = 0;
  private fabStartY = 0;
  private fabStartLeft = 0;
  private fabStartTop = 0;

  /** Build source + kernel + init. Rebuilt on Set / config-apply (teardown then reconstruct with the new count). */
  private setup(viewport: HTMLDivElement, content: HTMLDivElement): void {
    try {
      this.scroller?.destroy();
      this.source = new MockItemSource(this.countInput(), this.sourceLatency(), new MockUserService(), 1);
      // Pick the kernel implementation from route data: Plan A (browser overflow-anchor) or Plan B (manual compensation); both conform to ScrollerApi.
      const Ctor: new (opts: CbOptions<ChatItemData>) => ScrollerApi<ChatItemData> =
        this.useNativeAnchor ? ChatBoxScrollerAnchor : ChatBoxScroller;
      this.scroller = new Ctor({
        viewport, content, source: this.source,
        config: this.config(),
        hooks: { createItem: (item, prev) => this.createItemEl(item, prev), createSkeleton: () => createGhostCbElement(), mergeItems: mergeAlbumItems, absorbTail: absorbAlbumTail },
        onScroll: (info) => this.onScroll(info),
        onDebug: isDevMode() ? (s) => this.onBalanceDebug(s) : undefined,
      });
      this.applyCloseCheckpoint();
      this.hasData.set(true);
      void this.load();
    } catch (e) {
      console.error('[playground] scroller init failed:', e);
    }
  }

  /** Apply the closeCheckpoint toggle to the kernel (cast to set the closeCheckpoint field; re-applied at the end of setup after a Set rebuild). */
  applyCloseCheckpoint(): void {
    const s = this.scroller as unknown as { closeCheckpoint?: boolean } | undefined;
    if (s) s.closeCheckpoint = this.closeCheckpoint();
  }

  /** Set the source get latency (mutates MockItemSource.latency live; no source rebuild needed). */
  setSourceLatency(ms: number): void {
    this.sourceLatency.set(ms);
    if (this.source) this.source.latency = ms;
  }
  /** Set the mock server-echo delay (read live by the confirm timer — no rebuild needed). */
  setConfirmDelay(ms: number): void { this.confirmDelay.set(ms); }
  /** Set the mock WS reply delay (read live by the reply timer — no rebuild needed). */
  setReplyDelay(ms: number): void { this.replyDelay.set(ms); }
  /** Set the mock WS push-signal delay (read live by the confirm timer — no rebuild needed). */
  setPushSignalDelay(ms: number): void { this.pushSignalDelay.set(ms); }
  /** Toggle the opponent-interleave-before-mine scenario. */
  toggleOpponentInterleave(): void { this.opponentInterleave.update(v => !v); }
  /** Set how many opponent messages are pushed per send (read live by the confirm path — no rebuild needed). */
  setOpponentPushCount(n: number): void { this.opponentPushCount.set(n); }
  /** Toggle the persistent "mock send error" setting (every send fails while on). */
  toggleMockSendError(): void { this.mockSendError.update(v => !v); }
  /** Set the connection chip's demo state (bound to `<app-connection-banner [demoState]>`). */
  setConnStatus(s: ConnectionState): void { this.connStatus.set(s); }
  /** Set the update banner's demo availability (bound to `<app-update-banner [demoAvailable]>`). */
  setUpdateDemo(v: boolean): void { this.updateDemo.set(v); }
  /** Set the skeleton preview mode (bound to the panel's Auto/On buttons). */
  setSkeletonDemo(v: boolean): void { this.skeletonDemo.set(v); }
  /** Replay the recover flourish: a `reconnecting → open` transition through `demoState`, which the chip's
   *  effect reads exactly like a real recovery (auto-expanded pill, then the green-check flourish + fade-out). */
  playConnRecover(): void {
    this.connStatus.set('reconnecting');
    setTimeout(() => this.connStatus.set('open'), 60);
  }

  /** Open the config-edit modal (draft = a copy of the current config). */
  openConfigModal(): void {
    this.configDraft.set({ ...this.config() });
    this.configModalOpen.set(true);
  }
  cancelConfigModal(): void { this.configModalOpen.set(false); }
  /** Edit the draft field (applied only on confirm). The template does NOT call signal.update directly — strict template type-checking can't infer the signature of a signal method bound in the template → TS2345 fails the whole build and no new code enters the bundle. */
  setConfigDraft(field: keyof CbConfig, value: number): void {
    this.configDraft.update(d => ({ ...d, [field]: value }));
  }
  /** Confirm the edit: config ← draft + setup rebuild (new params take effect) + close. */
  applyConfig(): void {
    this.config.set({ ...this.configDraft() });
    this.configModalOpen.set(false);
    // Rebuild only when the kernel already holds data — while empty, just store the config; the next Set picks it up.
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (this.hasData() && vp && ct) this.setup(vp, ct);
  }

  ngOnDestroy() {
    this.scroller?.destroy();
    clearTimeout(this.toastTimer);
    for (const t of this.confirmTimers) clearTimeout(t);
    this.confirmTimers.length = 0;
    window.removeEventListener('pointermove', this.onFabMove);
    window.removeEventListener('pointerup', this.onFabUp);
  }

  // --- Data loading ---

  /** init: the kernel loads batches via the source up to the threshold and pins to the bottom (all data lives in the source; the kernel fetches on demand). */
  private async load(): Promise<void> {
    const scroller = this.scroller;
    if (!scroller) return;
    this.loading.set(true);
    try {
      await scroller.init();
      this.updateStickyDate();
    } finally {
      this.loading.set(false);
    }
  }

  // --- Kernel hooks ---

  private createItemEl(item: CbItem<ChatItemData>, prev: CbItem<ChatItemData> | null): CbElement<ChatItemData> {
    // Real items only — the topmost skeleton-slot decision (prev/boundary/noOlder) lives in the kernel's createVs,
    // rendered via the createSkeleton hook supplied in setup. createItemEl never branches on ghost-vs-real.
    // Grouping + date-separator flags are derived from the OLDER neighbor `prev` (computeRowFlags — the same logic
    // CbElement.update uses, so after a reorder update recomputes grouping by the new prev; mount and in-place update
    // derive the same flags).
    const { isShowHead, isGroupStart, showDate } = computeRowFlags(item, prev);
    const vs = createMsgCbElement(
      item, isShowHead, isGroupStart, showDate, this.envInjector,
      id => this.retrySend(id),
      (images, index) => this.galleryViewer.open(images, index, 0),
      (data) => this.fileDetail.open(data, 0),
    );
    // Dev badge (head/body + message id): injected into the row by the playground; ngDevMode-guarded → production AOT creates none.
    if (ngDevMode) this.attachDevBadge(vs.el, item, isShowHead);
    return vs;
  }

  /** Inject a dev badge into .msg-row: head (green) / body (orange) + message id (+ PENDING/FAKE tag when kind is set). Dev-only (ngDevMode); destroyed with the component. */
  private attachDevBadge(host: HTMLElement, item: CbItem<ChatItemData>, isHead: boolean): void {
    const d = item.data;
    if (d.type !== 'msg') return; // message rows only (date rows have no grouping concept)
    const row = host.querySelector('.msg-row');
    if (!row) return;
    const badge = document.createElement('span');
    badge.className = 'pg-dev-badge' + (isHead ? ' pg-dev-badge--head' : ' pg-dev-badge--body');
    const label = this.devIdLabel(d);
    badge.textContent = d.kind ? `${label}·${d.kind.toUpperCase()}` : label;
    row.appendChild(badge);
  }

  /**
   * Badge id text: when an album aggregates multiple messages, show the range `[min-max]` (each image keeps its
   * original msgId); otherwise the single id. Mock albums are single-message → single id; production albums can span
   * multiple messages (merged by toItems) → range, so aggregation doesn't drop all but the first id.
   */
  private devIdLabel(d: ChatMsgData): string {
    if (d.contentType === 'IMAGE' && d.images) {
      const ids = [...new Set(d.images.map(i => i.msgId).filter((x): x is number => typeof x === 'number'))];
      if (ids.length > 1) {
        ids.sort((a, b) => a - b);
        return `[${ids[0]}-${ids[ids.length - 1]}]`;
      }
      if (ids.length === 1) return String(ids[0]);
    }
    return String(d.msgId);
  }

  /** balance diagnostics → console.debug (debug mode + only when there is mount/unmount activity + throttled, to avoid flooding when idle). */
  private onBalanceDebug(s: CbDebugStats) {
    if (!this.debugMode()) return;
    if (s.mount + s.unmount === 0) return;
    const now = performance.now();
    if (now - this.lastDebugLog < 200) return;
    this.lastDebugLog = now;
    console.debug('[vs balance]', s);
  }

  private onScroll(info: CbScrollInfo) {
    // Drain optimistic sends queued while the newer end was trimmed: noNewer means the mounted tail IS the global
    // newest, so tailAnchorId() is now safe to anchor on. (scrollToBottom's follow chain emits noNewer on the batch
    // that reaches the global newest.) Runs before the throttle below so the insert is prompt, not delayed by 100ms.
    if (info.noNewer && this.pendingOptimistic.length > 0) {
      const queue = this.pendingOptimistic;
      this.pendingOptimistic = [];
      for (const item of queue) this.insertMsg('PENDING_POST_MSG', this.tailAnchorId(), item);
    }
    this.atBottom.set(info.atBottom);
    this.updateStickyDate();
    if (!isDevMode()) return;
    const now = performance.now();
    if (now - this.lastEmit < 100) return; // throttle: avoid refreshing signals on every scroll event (100ms is enough)
    this.lastEmit = now;
    // Position of the viewport within content (= the mounted window): remaining height above/below (< edge=1000 triggers a load in that direction).
    this.viewportAbove.set(Math.round(info.scrollTop));
    this.viewportBelow.set(Math.max(0, Math.round(info.scrollHeight - info.viewportHeight - info.scrollTop)));
  }

  /**
   * Telegram-style sticky date: the text of the last date-separator row at or above the viewport top.
   * The overlay is independent of content and unaffected by virtual-scroll recycling — a date row near the viewport
   * top always falls within the mounted window. Date rows are now rendered by the real DateRowComponent (the .msg-date
   * class is preserved), so querySelectorAll still finds them.
   */
  private updateStickyDate() {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (!vp || !ct) { this.stickyDate.set(null); return; }
    // The visible top is the header's bottom edge (stable — the header does NOT carry the keyboard-lift
    // transform), NOT the viewport's getBoundingClientRect().top (which slides under the header while the
    // keyboard is up, so a vTop-relative threshold/fade would anchor to a hidden message). Falls back to
    // the viewport top before the header ref is available (early init).
    const visibleTop = this.headerRef()?.nativeElement.getBoundingClientRect().bottom
      ?? vp.getBoundingClientRect().top;
    // Fade band (px, from the visible top) tracks the floating sticky pill — its SCSS `top` is
    // calc(var(--sd-top) + 6px), so it sits ~6px below this visible top. The inline date pill fades out
    // exactly as it passes behind the float: lo = fully transparent, hi = fade start. The overlay's +6px gap
    // is baked into both offsets; move them together or a gap opens between the two pills.
    const STICKY_DATE_FADE_PX = { lo: 20, hi: 66 };
    const fadeLo = visibleTop + STICKY_DATE_FADE_PX.lo;
    const fadeHi = visibleTop + STICKY_DATE_FADE_PX.hi;
    const rows = Array.from(ct.querySelectorAll<HTMLElement>('.msg-date'))
      .map((d) => ({ d, top: d.getBoundingClientRect().top, label: d.textContent?.trim() ?? null }));
    let current = pickStickyDateLabel(rows, visibleTop, STICKY_DATE_FADE_PX.lo);
    // When the top ghost loading spinner (.cb-ghost-loading, centered) is visible it overlaps the centered date overlay →
    // hide the overlay while the spinner sits at the visible top (its bottom crosses it); it restores
    // naturally once the spinner is gone (the inline date row is still there).
    const ghost = ct.querySelector('.cb-ghost-loading');
    if (ghost && ghost.getBoundingClientRect().bottom > visibleTop) current = null;
    this.stickyDate.set(current);
    const hasFloat = current !== null;
    for (const { d, top } of rows) {
      d.style.opacity = stickyDateRowOpacity(top, fadeLo, fadeHi, hasFloat).toFixed(2);
    }
  }

  /** Recompute the sticky-date pill when the keyboard-lift `transform` settles on the viewport. The
   *  transform fires no scroll event, so onScroll alone would leave the pill on its pre-lift label across
   *  a keyboard open/close; this closes that gap. {@link isViewportTransformEnd} filters to the viewport's
   *  own `transform` (ignoring bubbled item transitions like cb-move). */
  onViewportTransitionEnd(event: TransitionEvent): void {
    if (!isViewportTransformEnd(event, this.viewportRef()?.nativeElement)) return;
    this.updateStickyDate();
  }

  // --- Controls ---

  /** Set: build the source with the current count input and init the kernel (tears down any existing scroller first). */
  applyCount(): void {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (vp && ct) this.setup(vp, ct); // (re)build source(countInput) + kernel + init
  }

  /** Reset: tear down the kernel + source and clear derived state so the chat area is empty until the next Set. */
  reset(): void {
    this.scroller?.destroy();
    this.scroller = undefined;
    this.source = undefined;
    this.hasData.set(false);
    this.viewportAbove.set(0);
    this.viewportBelow.set(0);
    this.atBottom.set(true);
    this.stickyDate.set(null);
  }

  /**
   * Jump to a message seq: if mounted, position directly; if not, the kernel re-seeds the window around that seq then
   * positions. anchor='center' centers it (best-effort: clamps to top/bottom near the newest/oldest) + a highlight flash.
   * If the seq doesn't exist the source returns empty → the kernel no-ops silently.
   */
  jumpToId(v: string): void {
    const scroller = this.scroller;
    const input = this.jumpInput()?.nativeElement;
    const s = (v ?? '').trim();
    if (!s || !scroller) return;
    if (!/^-?\d+$/.test(s)) { this.showToast('Jump supports seq numbers only'); return; }
    const n = parseInt(s, 10);
    if (n < 0) { this.showToast('seq must be non-negative'); return; }
    scroller.scrollToIndex(n, 'center', true);
    if (input) input.value = '';
  }

  /**
   * Insert a new message after a mounted seq: if mounted, the kernel insertAfter runs (no balance triggered — only
   * scroll-height compensation); if not mounted, the kernel ignores it (returns false) → toast. The inserted item
   * alternates creator self/other to exercise the successor's group-rebuild. Unlike appendLive, this is a viewport-level
   * insert that never enters the source (transient); once it scrolls out and is trimmed it's gone, by design.
   */
  insertAfterId(v: string): void {
    const scroller = this.scroller;
    const input = this.insertInput()?.nativeElement;
    const s = (v ?? '').trim();
    if (!s || !scroller) return;
    if (!/^-?\d+$/.test(s)) { this.showToast('Insert supports seq numbers only'); return; }
    const n = parseInt(s, 10);
    if (n < 0) { this.showToast('seq must be non-negative'); return; }
    const item = this.makeInsertItem();
    const ok = this.insertMsg('FAKE_MSG', n, item);
    if (input) input.value = '';
    this.showToast(ok ? `Inserted ${item.id} (after ${n})` : `${n} not mounted, insert ignored`);
  }

  /**
   * Remove mounted message(s) by seq — one seq or a comma/whitespace-separated list of seq numbers (history seq, or a
   * negative placeholder seq for a fake/optimistic/mock item). A fake/pending/real id or any album-member id all resolve
   * to the same entry. Plays a cb-leave exit animation (balance paused while it runs); not-mounted ids are ignored.
   * Toasts the count removed.
   */
  removeById(v: string): void {
    const scroller = this.scroller;
    const input = this.removeInput()?.nativeElement;
    const parts = (v ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0 || !scroller) return;
    const ids = parts.map(p => parseInt(p, 10)).filter(n => Number.isInteger(n));
    if (ids.length === 0) return;
    const removed = scroller.removeItem(ids);
    if (input) input.value = '';
    this.showToast(removed > 0 ? `Removed ${removed} item(s)` : 'Not mounted, ignored');
  }

  /** Build a mock debug-insert message (creator alternates 1=me/isSelf / 2=Alice; name/isSelf filled directly since
   *  insertAfter bypasses source.shape). kind:'fake' tags it in the dev badge; no status (debug inserts are not "sent").
   *  id/msgId = a synthetic negative seq (from -200001 down) — stable, unique, never collides with a server seq or the
   *  optimistic (-1..)/mock (-100001..) placeholder ranges. */
  private makeInsertItem(): CbItem<ChatItemData> {
    const now = new Date();
    const seq = this.insertSeq++;
    const creator = seq % 2 === 0 ? 1 : 2;
    const id = -200_001 - seq;
    const data: ChatMsgData = {
      type: 'msg',
      msgId: id,
      creator,
      isSelf: creator === 1,
      name: creator === 1 ? 'Me' : 'Alice',
      text: `[Insert ${seq}] inserted after the specified message`,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType: 'PURE_TEXT',
      images: null,
      file: null,
      createdAtMs: now.getTime(),
      kind: 'fake',
    };
    return { id, data };
  }

  private showToast(msg: string): void {
    this.toast.set(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 1800);
  }

  toTop() { this.scroller?.scrollToTop(); }
  toBottom() { this.scroller?.scrollToBottom(); }

  /**
   * ChatInputComponent send intent → dispatch. The composer owns presentation only; this switches on the
   * structured intent and routes to the mock optimistic-send paths. Text is plain (editor.getText()); the
   * editor is cleared inside the composer before this fires.
   */
  onSendIntent(intent: ChatSendIntent): void {
    switch (intent.kind) {
      case 'text': void this.sendText(intent.text); return;
      case 'image': void this.sendMediaFromFile(intent.files); return;
      case 'file': void this.sendFileFromFile(intent.files); return;
    }
  }

  /**
   * Optimistic text send: show a "sending" bubble right after the newest mounted item (insertAfter, transient),
   * register it with the source's pending area, and schedule a mock confirm. The optimistic item shares the real
   * (server-echoed) id, so on confirm the kernel settles the transient in place (clock -> check) instead of
   * mounting a duplicate. Stacks naturally: each insert anchors on the current tail (a prior fake or the real newest).
   */
  private async sendText(text: string): Promise<void> {
    const scroller = this.scroller;
    if (!text || !scroller) return;
    const item = this.makeOptimisticItem(text, 'PURE_TEXT', null, null);
    this.dispatchPending(item);
  }

  /** Mock WS incoming batch (the other party): cache `count` live messages in one shot and signal the kernel once —
   *  loadNewer pulls them via getNewer (shaping name/isSelf from profiles) and mounts them at the tail; the kernel
   *  follows to the bottom if pinned. A single pushLive + signal keeps the batch atomic (one loadNewer pass). */
  private async receiveMany(count: number): Promise<void> {
    const scroller = this.scroller;
    if (!scroller || count <= 0) return;
    const items = Array.from({ length: count }, () => {
      const phrase = REPLY_PHRASES[Math.floor(Math.random() * REPLY_PHRASES.length)];
      return this.makeMockItem(phrase, false, 'PURE_TEXT', null);
    });
    this.source?.pushLive(items);
    void scroller.onMessageSignal();
  }

  /**
   * Optimistic image send: read images locally -> show a "sending" album bubble (insertAfter, transient) -> mock confirm.
   * The real uploadMedia/sendMessage is skipped under mock (the bytes are already client-side).
   */
  async sendMediaFromFile(files: FileList | null): Promise<void> {
    const scroller = this.scroller;
    if (!files || files.length === 0 || !scroller) return;
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (list.length === 0) return;
    const imgs = await readImages(list);
    if (imgs.length === 0) return;
    const item = this.makeOptimisticItem('', 'IMAGE', imgs);
    this.dispatchPending(item);
  }

  /**
   * Optimistic file send: the playground is mock-only (no real backend round-trip), so the picked file is
   * exposed via a client object URL — the FileRow download anchor then genuinely downloads the real bytes,
   * making the card fully functional in the sandbox. (Production uses MsgService.uploadFile → POST /upload/file
   * and stores the returned /uploads/<name> url; the optimistic card here is the same shape with a blob url.)
   */
  async sendFileFromFile(files: FileList | null): Promise<void> {
    const scroller = this.scroller;
    if (!files || files.length === 0 || !scroller) return;
    for (const f of Array.from(files)) {
      const url = URL.createObjectURL(f);
      const file: FileInfo = {
        url,
        name: f.name,
        size: f.size,
        mimeType: f.type || 'application/octet-stream',
      };
      this.dispatchPending(this.makeOptimisticItem('', 'FILE', null, file));
    }
  }

  /** The id to anchor a newest-end insert after: the current tail (a prior fake/pending, or the real newest). -1 if empty
   *  (the kernel's insertAfter ignores afterId when the window is empty, so the sentinel never reaches indexOfId). */
  private tailAnchorId(): number {
    const id = this.scroller?.getInfo().newestId ?? null;
    return id != null ? id : -1;
  }

  /** Optimistic sends queued while the newer end was trimmed; drained in onScroll once noNewer is reported. */
  private pendingOptimistic: CbItem<ChatItemData>[] = [];

  /**
   * Route an optimistic send so it anchors on the GLOBAL newest only once that end is mounted. When pinned (noNewer,
   * the common case) this is synchronous: anchor and insert now. When the newer end is trimmed (scrolled into history),
   * queue the item and scrollToBottom() — the follow chain mounts the newest and onScroll drains the queue, inserting
   * each item on the now-correct tail. So tailAnchorId() never anchors on a mid-list item. A prior in-flight pending
   * bubble counts as "the newest" (it IS the mounted tail once noNewer), so rapid-fire sends still stack in order.
   */
  private dispatchPending(item: CbItem<ChatItemData>): void {
    const scroller = this.scroller;
    if (!scroller) return;
    if (scroller.getInfo().noNewer) {
      this.insertMsg('PENDING_POST_MSG', this.tailAnchorId(), item);
    } else {
      this.pendingOptimistic.push(item);
      scroller.scrollToBottom();
    }
  }

  /**
   * Domain-layer insert orchestrator: the `type` discriminator lives HERE (the kernel stays generic — it only knows the
   * viewport-level `transient` flag, never 'PENDING_POST_MSG'/'FAKE_MSG'). Both shapes route through kernel.insertAfter;
   * PENDING_POST_MSG additionally registers with the source pending area, ensures the newest end is mounted, and schedules
   * a mock confirm; FAKE_MSG is a pure viewport insert (the "insert message" debug action).
   */
  private insertMsg(type: 'PENDING_POST_MSG' | 'FAKE_MSG', afterId: number, item: CbItem<ChatItemData>): boolean {
    const scroller = this.scroller;
    if (!scroller) return false;
    // afterId is -1 on the first send into an empty thread (tailAnchorId() = -1 when nothing is mounted); the kernel's
    // insertAfter treats an empty window as "insert as the sole entry", so do NOT bail on a -1 here. FAKE_MSG always
    // carries a real seq — insertAfterId guards empty input before calling — so this only relaxes PENDING_POST_MSG.
    if (type === 'PENDING_POST_MSG') {
      // Register with the source pending area so the confirm echo (appendLive with a matching id) reconciles it.
      this.source?.addPending(item);
      // No pre-scroll: afterId IS the mounted tail (tailAnchorId → getInfo().newestId = mounted[last].id), so
      // insertAfter always finds its anchor — there is nothing to mount first. The follow that reveals the bubble
      // runs AFTER insertAfter (below) and is synchronous when pinned (noNewer → pinToBottom only, no source I/O).
    }
    const ok = scroller.insertAfter(afterId, item, { optimistic: type === 'PENDING_POST_MSG' });
    if (ok && type === 'PENDING_POST_MSG') {
      // insertAfter is viewport-stable (it only compensates scrollTop for above-viewport growth), so a sent message —
      // which lands at the newer end, below the fold when pinned — must be explicitly pinned to reveal the optimistic
      // bubble. Mirrors appendLive/loadNewer's wasAtBottom follow. (A send always means "show my message".)
      scroller.scrollToBottom();
      const optimistic = item;
      const t = setTimeout(() => this.confirmPending(optimistic), this.confirmDelay());
      this.confirmTimers.push(t);
    }
    return ok;
  }

  /**
   * Mock server confirm: allocate a fresh server msgId for the confirmed real (autoincrement, mirrors production
   * Message.id) and cache it with the SAME clientMessageId as the optimistic (the reconcile key — the kernel pairs them
   * by clientMessageId, not id, since the real's id is brand-new). After the push-signal delay, fire the WS signal so
   * loadNewer reconciles the pending entry and reconcileOptimistic removes the optimistic bubble and tags the real
   * cb-confirmed (status 'sending' → 'sent'; the check then fades out via CSS — see _row-base.scss). If the transient
   * was unmounted meanwhile (e.g. a jump during pending), the real mounts at the tail normally.
   *
   * Opponent pushes per send are controlled by opponentPushCount: 0 = no incoming messages at all (only your confirm);
   * N > 0 = N opponent messages. When opponentInterleave is on, ONE of those N is cached BEFORE the real so the source's
   * ascending order is [opponent, mine] and mountNewerReals inserts it ABOVE the optimistic tail (the "reply lands above
   * my sent message" race); the remaining N−1 arrive as a below batch after replyDelay. When interleave is off, all N
   * arrive below.
   */
  private confirmPending(optimistic: CbItem<ChatItemData>): void {
    const scroller = this.scroller;
    if (!scroller || !this.source) return;
    // Mock send error (persistent setting): the confirm "times out / errors" — the optimistic bubble is rebuilt as a
    // failed bubble (retry glyph) instead of confirming. The real is NOT pushed (no confirm). Stays on until toggled off.
    if (this.mockSendError()) {
      this.failPending(optimistic);
      return;
    }
    const realMsgId = this.source.allocateMsgId();
    const realItem: CbItem<ChatItemData> = {
      id: realMsgId,
      data: { ...optimistic.data, msgId: realMsgId, status: 'sent', kind: undefined },
      clientMessageId: optimistic.clientMessageId,
    };

    // Opponent budget for this send: 0 means no incoming messages at all (only the self-sent confirm below).
    const count = this.opponentPushCount();

    // Opponent-interleave: cache ONE opponent message BEFORE the real → ascending order [opponent, mine] → opponent
    // mounts above the optimistic bubble. Consumes one slot of the budget; the rest go to the below batch.
    let above = 0;
    if (count > 0 && this.opponentInterleave()) {
      const phrase = REPLY_PHRASES[Math.floor(Math.random() * REPLY_PHRASES.length)];
      this.source?.pushLive([this.makeMockItem(phrase, false, 'PURE_TEXT', null)]);
      above = 1;
    }
    this.source?.pushLive([realItem]);

    // WS push delivery, optionally delayed to model broadcast latency. On a non-zero delay the optimistic bubble keeps
    // showing the 'sending' spinner until the signal arrives and reconcile reveals the real (check → CSS fade).
    const signalTimer = setTimeout(() => { void scroller.onMessageSignal(); }, this.pushSignalDelay());
    this.confirmTimers.push(signalTimer);

    // Remaining opponent budget delivered as one below-batch after replyDelay (atomic pushLive + single signal).
    const below = count - above;
    if (below > 0) {
      const replyTimer = setTimeout(() => { void this.receiveMany(below); }, this.replyDelay());
      this.confirmTimers.push(replyTimer);
    }
  }

  /**
   * Failure path: the message stays the SAME entity (stable clientMessageId). The source owns the mutation — it flips
   * the pending entry's status to 'failed' and sinks it to the END of the pending queue — then reconcilePending morphs
   * the bubble IN PLACE (sending→failed, same DOM node) and FLIP-animates the slide to the tail. No removeItem /
   * insertAfter, no fabricated failed-N id: the failure is durable (the entry stays in source.pending) and the kernel
   * stays synced with the source's pending order.
   */
  private async failPending(optimistic: CbItem<ChatItemData>): Promise<void> {
    const scroller = this.scroller;
    if (!scroller || !this.source || optimistic.clientMessageId === undefined) return;
    this.source.failPending(optimistic.clientMessageId);
    await scroller.reconcilePending();
  }

  /**
   * Retry a failed send (the row's retry output → createMsgCbElement onRetry → here, emitting `data.msgId` = the stable
   * clientMessageId). Flip the SAME entry back to 'sending' at its current position (the end) via the source, then
   * reconcilePending morphs it in place (failed→sending) — stable identity, no fresh clientMessageId, no remount — and
   * re-arm the confirm timer for a normal confirm. No-op if the id is no longer pending (e.g. unmounted meanwhile).
   */
  async retrySend(msgId: string): Promise<void> {
    const scroller = this.scroller;
    if (!scroller || !this.source) return;
    const item = this.source.retryPending(msgId);
    if (!item) return;
    await scroller.reconcilePending();
    const t = setTimeout(() => this.confirmPending(item), this.confirmDelay());
    this.confirmTimers.push(t);
  }

  /** Build a fully-shaped optimistic self message (creator 1, name 'Me', status 'sending', kind 'pending'). Generates a
   *  client idempotency UUID (clientMessageId) — the correlation key between the in-flight bubble and the server-confirmed
   *  real (the kernel reconciles by THIS, not id). id/msgId = a synthetic NEGATIVE placeholder (msgId is a number now,
   *  so the bubble cannot carry the clientMessageId as its id); negative ids never collide with server-assigned seqs
   *  (always positive). insertAfter bypasses source.shape, so name/isSelf are filled directly (mirrors MockItemSource.shape
   *  for creator 1). Any album cell's msgId is stamped to the same placeholder so the dev-badge range stays self-consistent. */
  private makeOptimisticItem(text: string, contentType: ChatMsgData['contentType'], images: AlbumImage[] | null, file: FileInfo | null = null, rich = false): CbItem<ChatItemData> {
    const now = new Date();
    const clientMessageId = newClientMessageId();
    const placeholderId = this.nextOptimisticId--;
    const stampedImages = images?.map(im => ({ ...im, msgId: placeholderId })) ?? null;
    const data: ChatMsgData = {
      type: 'msg',
      msgId: placeholderId,
      creator: 1,
      isSelf: true,
      name: 'Me',
      text,
      rich,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType, images: stampedImages, file, createdAtMs: now.getTime(),
      status: 'sending',
      kind: 'pending',
    };
    return { id: placeholderId, data, clientMessageId };
  }
  /** Next synthetic id for an in-flight optimistic send (decrements from -1 so it never collides with a server seq). */
  private nextOptimisticId = -1;

  /** Build a mock received/sent ChatMsgData wrapped as a CbItem. The id is allocated from the source's autoincrement
   *  counter — the same path a confirmed self-send takes (`source.allocateMsgId()` → the next seq), mirroring a
   *  server-assigned Message.seq — so incoming messages carry a real id, not a synthetic placeholder. A negative
   *  placeholder is a fallback only for the impossible case where the source is unbound while the scroller is live. */
  private makeMockItem(text: string, isSelf: boolean, contentType: ChatMsgData['contentType'], images: AlbumImage[] | null, file: FileInfo | null = null): CbItem<ChatItemData> {
    const now = new Date();
    const data: ChatMsgData = {
      type: 'msg',
      msgId: this.source?.allocateMsgId() ?? this.nextMockId--,
      creator: isSelf ? 1 : 2,
      isSelf: false, name: '',  // placeholder: source.appendLive's shape fills name from profiles by creator (mirrors production toMsgData)
      text,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType, images, file, createdAtMs: now.getTime(),
    };
    return { id: data.msgId, data };
  }
  /** Fallback synthetic seq for mock items when the source is unbound (impossible in normal flow). Decrements from -100001
   *  to stay clear of the optimistic placeholder range (-1..) and never collide with a positive server seq. */
  private nextMockId = -100_001;
  /** Insert-message sequence counter (each debug insert gets a synthetic negative id; never collides with a server seq
   *  or the optimistic/mock placeholder ranges). */
  private insertSeq = 0;
  /** In-flight mock confirm timers (cleared on teardown so no settle fires after destroy). */
  private readonly confirmTimers: ReturnType<typeof setTimeout>[] = [];
}

/** Opponent reply phrases (mock). */
const REPLY_PHRASES = ['You there?', 'Got it', 'Haha', 'OK', 'Is virtual scroll stable?', 'Check the mount count'];

/** @mention candidate members (mock; production swaps in GroupService.getMembers() returning GroupMember[]). */
const MOCK_MEMBERS: ChatMember[] = [
  { id: '2', label: 'Alice' },
  { id: '3', label: 'Bob' },
  { id: '4', label: 'Carol' },
  { id: '5', label: 'David' },
  { id: '6', label: 'Eve' },
  { id: '7', label: 'Frank' },
  { id: '8', label: 'Grace' },
  { id: '9', label: 'Heidi' },
];

/** Generate a client-side idempotency UUID for an optimistic send (mirrors production SendMessageDto.clientMessageId —
 *  the correlation key between the in-flight bubble and the server-confirmed real). Delegates to lib/uuid so the
 *  playground stays on the same always-spec-compliant path as production. */
function newClientMessageId(): string {
  return uuid();
}

/** Read images locally into AlbumImage (dataURL + real dimensions; falls back to 400×300 on read failure). */
function readImages(files: File[]): Promise<AlbumImage[]> {
  return Promise.all(files.map(f => new Promise<AlbumImage>(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === 'string' ? reader.result : '';
      if (!src) { resolve({ kind: 'image', src: '', w: 400, h: 300 }); return; }
      const probe = new Image();
      probe.onload = () => resolve({ kind: 'image', src, w: probe.naturalWidth || 400, h: probe.naturalHeight || 300 });
      probe.onerror = () => resolve({ kind: 'image', src, w: 400, h: 300 });
      probe.src = src;
    };
    reader.onerror = () => resolve({ kind: 'image', src: '', w: 400, h: 300 });
    reader.readAsDataURL(f);
  })));
}
