import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  Injector,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { isAndroidNative, isTauri, tauriInvoke } from '../../services/runtime';
import { DiagnosticsReportService } from '../../services/diagnostics-report.service';
import { getConsoleEntries } from '../../services/log-buffer';
import {
  fromJsEntry,
  type IdentifiedLine,
  type LogLevel,
  mergeByTs,
  parseNativeLine,
  splitLines,
} from './debug-log-merge';
import { DebugLogRowComponent } from './debug-log-row.component';
import { DebugLogStore } from './debug-log.store';

interface NativeTail {
  path: string;
  content: string;
}

/** A merged line carrying a stable id so `@for … track l.id` recycles DOM nodes across snapshots. */
type Line = IdentifiedLine;
type DockMode = 'float' | 'right' | 'bottom';
type UploadState = 'idle' | 'confirming' | 'uploading';

/**
 * The 3-layer debug log viewer. Opened on demand from {@link DebugLogFabComponent}; reads the JS ring
 * buffer in memory + tails the two native logs via the Rust `read_native_log` command, then merges them by
 * timestamp with source attribution + level coloring. The merged view is what the removed
 * `attachRustConsole` approximated by polluting the JS console — here it is a first-class, filterable panel.
 *
 * **Snapshot reconciliation:** each refresh reads the bounded source tails, merges them, then reuses row ids
 * by occurrence. This keeps delayed/out-of-order native records visible without rebuilding unchanged DOM.
 *
 * **Independent live/follow state:** collection continues every 2 s while the user reads older rows; only
 * automatic scrolling pauses, and the panel exposes how many unseen rows arrived.
 *
 * Zoneless-safe: state is signals; the interval only writes signals; DOM scroll is deferred to
 * `afterNextRender` (guaranteed after the row render, not racy on microtask-vs-macrotask ordering).
 */
@Component({
  selector: 'app-debug-log-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DebugLogRowComponent],
  providers: [DebugLogStore],
  template: `
    <div class="dbg-overlay dock-{{ dock() }}" (click)="onBackdropClick()">
      <section
        #panel
        class="dbg-panel"
        role="dialog"
        aria-labelledby="dbg-title"
        (click)="$event.stopPropagation()"
      >
        <header
          class="dbg-grip"
          (pointerdown)="onGripDown($event)"
          title="Drag to move"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            aria-hidden="true"
            fill="currentColor"
          >
            <circle cx="9" cy="6" r="1.4" />
            <circle cx="15" cy="6" r="1.4" />
            <circle cx="9" cy="12" r="1.4" />
            <circle cx="15" cy="12" r="1.4" />
            <circle cx="9" cy="18" r="1.4" />
            <circle cx="15" cy="18" r="1.4" />
          </svg>
          <strong id="dbg-title">Logs</strong>
          <span class="dbg-live" [class.on]="live()">{{
            live() ? 'LIVE' : 'PAUSED'
          }}</span>
          @if (actionNotice()) {
            <span class="dbg-notice" role="status">{{ actionNotice() }}</span>
          }
          <button
            type="button"
            class="dbg-btn header-btn dock-btn"
            (pointerdown)="$event.stopPropagation()"
            (click)="cycleDock()"
            [attr.aria-label]="dockLabel()"
            [title]="dockLabel()"
          >
            <svg
              class="dock-icon"
              viewBox="0 0 20 20"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
            >
              @switch (dock()) {
                @case ('float') {
                  <!-- Next action: dock the window to the right. -->
                  <rect x="2.5" y="3" width="15" height="14" rx="2" />
                  <path d="M12 3v14" />
                }
                @case ('right') {
                  <!-- Next action: dock the window to the bottom. -->
                  <rect x="2.5" y="3" width="15" height="14" rx="2" />
                  <path d="M2.5 11.5h15" />
                }
                @default {
                  <!-- Next action: restore a floating window. -->
                  <rect x="5" y="5.5" width="12.5" height="11.5" rx="2" />
                  <path d="M2.5 13V5a2 2 0 0 1 2-2H14" />
                }
              }
            </svg>
          </button>
          <button
            type="button"
            class="dbg-btn close"
            (pointerdown)="$event.stopPropagation()"
            (click)="close.emit()"
            aria-label="Close logs"
          >
            ✕
          </button>
        </header>
        <div class="dbg-bar">
          <div class="dbg-srcs">
            <button
              type="button"
              class="chip src-js"
              [class.on]="showJs()"
              [attr.aria-pressed]="showJs()"
              (click)="showJs.set(!showJs())"
            >
              JS
            </button>
            <button
              type="button"
              class="chip src-rust"
              [class.on]="showRust()"
              [attr.aria-pressed]="showRust()"
              [disabled]="!rustAvailable"
              (click)="showRust.set(!showRust())"
            >
              Rust
            </button>
            <button
              type="button"
              class="chip src-kotlin"
              [class.on]="showKotlin()"
              [attr.aria-pressed]="showKotlin()"
              [disabled]="!kotlinAvailable"
              (click)="showKotlin.set(!showKotlin())"
            >
              Kotlin
            </button>
          </div>
          <select
            class="dbg-level"
            aria-label="Minimum log level"
            [value]="minLevel()"
            (change)="setMinLevel($any($event.target).value)"
          >
            <option value="debug">Debug+</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error</option>
          </select>
          <input
            class="dbg-search"
            type="search"
            aria-label="Filter logs"
            placeholder="Filter logs…"
            [value]="query()"
            (input)="onQueryInput($any($event.target).value)"
          />
          <button
            type="button"
            class="dbg-btn search-opt"
            [class.on]="caseSensitive()"
            [attr.aria-pressed]="caseSensitive()"
            (click)="toggleCaseSensitive()"
            title="Match case"
          >
            Aa
          </button>
          <button
            type="button"
            class="dbg-btn search-opt"
            [class.on]="regexMode()"
            [attr.aria-pressed]="regexMode()"
            (click)="toggleRegexMode()"
            title="Use regular expression"
          >
            .*
          </button>
          <button
            type="button"
            class="dbg-btn search-nav"
            [disabled]="filtered().length === 0 || !query()"
            (click)="selectMatch(-1)"
            title="Previous match"
            aria-label="Previous search match"
          >
            ↑
          </button>
          <button
            type="button"
            class="dbg-btn search-nav"
            [disabled]="filtered().length === 0 || !query()"
            (click)="selectMatch(1)"
            title="Next match"
            aria-label="Next search match"
          >
            ↓
          </button>
          <button
            type="button"
            class="dbg-btn live-btn"
            [class.on]="live()"
            [attr.aria-pressed]="live()"
            (click)="toggleLive()"
          >
            {{ live() ? 'Pause' : 'Resume' }}
          </button>
          <button
            type="button"
            class="dbg-btn"
            [disabled]="filtered().length === 0"
            (click)="copyVisible()"
            title="Copy filtered logs"
          >
            Copy
          </button>
          @switch (uploadState()) {
            @case ('idle') {
              <button
                type="button"
                class="dbg-btn"
                [disabled]="!rustAvailable"
                (click)="beginUpload()"
                title="Upload a full diagnostic report"
              >
                Upload
              </button>
            }
            @case ('confirming') {
              <button type="button" class="dbg-btn" (click)="cancelUpload()">
                Cancel
              </button>
              <button
                type="button"
                class="dbg-btn upload-confirm"
                (click)="uploadReport()"
              >
                Confirm upload
              </button>
            }
            @case ('uploading') {
              <button type="button" class="dbg-btn" disabled>Uploading…</button>
            }
          }
        </div>
        <div class="dbg-status">
          <button type="button" class="session-btn" (click)="toggleSession()">
            {{ sessionMinId() === null ? 'Start new session' : 'Show history' }}
          </button>
          <span
            >{{ filtered().length }} shown · {{ lines().length }} buffered</span
          >
          @if (query()) {
            <span [class.search-error]="searchMatcher().error">
              @if (searchMatcher().error) {
                {{ searchMatcher().error }}
              } @else {
                {{ selectedIndex() >= 0 ? selectedIndex() + 1 : 0 }}/{{
                  filtered().length
                }}
                matches
              }
            </span>
          }
          @if (uploadState() === 'confirming') {
            <span class="upload-consent">
              The full diagnostic bundle may contain URLs and account
              identifiers.
            </span>
          }
          <span class="spacer"></span>
          <span class="hint">{{
            live() ? 'refreshing every 2s' : 'collection paused'
          }}</span>
        </div>
        <div #scroll class="dbg-list" role="listbox" (scroll)="onScroll()">
          @for (l of filtered(); track l.id) {
            <app-debug-log-row
              [line]="l"
              [selected]="selectedId() === l.id"
              [matcher]="searchMatcher().regex"
              (select)="selectLine($event)"
              (copy)="copyLine($event)"
            />
          } @empty {
            <div class="dbg-empty">No matching lines.</div>
          }
        </div>
        @if (!followTail() && unseen() > 0) {
          <button type="button" class="dbg-new" (click)="followNewest()">
            {{ unseen() }} new {{ unseen() === 1 ? 'line' : 'lines' }} · Jump to
            latest
          </button>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .dbg-overlay {
        position: fixed;
        inset: 0;
        z-index: 1200; /* above lightbox (1100) — the debug surface must stay reachable over any overlay */
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .dbg-panel {
        width: min(96vw, 1100px);
        height: min(82vh, 720px);
        min-width: 420px;
        min-height: 260px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        background: #1e1e1e;
        color: #e6e6e6;
        border: 1px solid #000;
        border-radius: 12px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        pointer-events: auto;
        resize: both;
      }
      .dbg-grip {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 36px;
        padding: 0 8px;
        line-height: 24px;
        background: #2a2a2a;
        border-bottom: 1px solid #000;
        color: #666;
        cursor: grab;
        touch-action: none; /* the grip owns the gesture: a drag never scrolls the log list or the page */
        user-select: none;
      }
      .dbg-grip > svg {
        color: #666;
      }
      .dbg-grip strong {
        font:
          600 13px/1 system-ui,
          sans-serif;
        letter-spacing: 0.2px;
      }
      .dbg-live {
        color: #888;
        font:
          700 9px/1 system-ui,
          sans-serif;
        letter-spacing: 0.8px;
      }
      .dbg-live.on {
        color: #4ade80;
      }
      .dbg-notice {
        color: #93c5fd;
        font:
          500 11px/1 system-ui,
          sans-serif;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dbg-grip .close {
        cursor: pointer;
      }
      .dbg-grip .dock-btn {
        margin-left: auto;
      }
      .header-btn {
        min-height: 26px;
        min-width: 28px;
        padding: 0 6px;
        font-size: 13px;
      }
      .dock-icon {
        display: block;
        width: 18px;
        height: 18px;
        margin: auto;
      }
      .dbg-grip:active {
        cursor: grabbing;
      }
      .dbg-panel.dragging {
        transition: none; /* follow the pointer exactly, no easing */
        will-change: transform; /* promote to a compositor layer so translate moves never trigger layout */
        user-select: none;
      }
      .dbg-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px;
        background: #2a2a2a;
        border-bottom: 1px solid #000;
        flex-wrap: wrap; /* narrow/mobile: wrap to a second row instead of clipping controls */
      }
      .dbg-srcs {
        display: flex;
        gap: 4px;
      }
      .chip {
        border: 1px solid #444;
        background: transparent;
        color: #aaa;
        font-size: 11px;
        line-height: 20px;
        font-weight: 600;
        padding: 0 10px;
        min-height: 32px;
        border-radius: 16px;
        cursor: pointer;
        opacity: 0.5;
      }
      .chip.on {
        opacity: 1;
        color: #fff;
      }
      .chip:disabled {
        opacity: 0.25;
        cursor: not-allowed;
      }
      .chip.src-js.on {
        background: #2563eb;
        border-color: #2563eb;
      }
      .chip.src-rust.on {
        background: #d97706;
        border-color: #d97706;
      }
      .chip.src-kotlin.on {
        background: #16a34a;
        border-color: #16a34a;
      }
      .dbg-level,
      .dbg-search {
        background: #1e1e1e;
        color: #e6e6e6;
        border: 1px solid #444;
        border-radius: 8px;
        font-size: 13px;
        line-height: 20px;
        min-height: 32px;
        padding: 4px 8px;
      }
      .dbg-search {
        flex: 1 1 auto;
        min-width: 96px;
      }
      .search-opt {
        font:
          600 12px/20px ui-monospace,
          monospace;
      }
      .search-nav {
        padding: 0 5px;
        min-width: 28px;
      }
      .dbg-btn {
        border: 1px solid #444;
        background: #1e1e1e;
        color: #e6e6e6;
        font-size: 15px;
        line-height: 20px;
        min-height: 32px;
        min-width: 32px;
        padding: 0 8px;
        border-radius: 8px;
        cursor: pointer;
      }
      .dbg-btn.on {
        background: #2563eb;
        border-color: #2563eb;
        color: #fff;
      }
      .dbg-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      .live-btn {
        min-width: 68px;
      }
      .dbg-status {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 4px 12px;
        font-size: 11px;
        line-height: 18px;
        color: #888;
        background: #242424;
        border-bottom: 1px solid #000;
      }
      .dbg-status .na {
        color: #d97706;
      }
      .dbg-status .spacer {
        flex: 1 1 auto;
      }
      .session-btn {
        border: 0;
        background: transparent;
        color: #93c5fd;
        padding: 0;
        font: inherit;
        cursor: pointer;
      }
      .search-error {
        color: #ff6b6b;
      }
      .upload-consent {
        color: #fbbf24;
      }
      .upload-confirm {
        border-color: #2563eb;
        background: #1d4ed8;
      }
      .dbg-list {
        flex: 1 1 auto;
        overflow-y: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 18px;
        padding: 6px 8px;
      }
      .dbg-new {
        position: absolute;
        left: 50%;
        bottom: 14px;
        transform: translateX(-50%);
        border: 1px solid #3b82f6;
        border-radius: 18px;
        background: #1d4ed8;
        color: #fff;
        padding: 7px 14px;
        font:
          600 12px/18px system-ui,
          sans-serif;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      }
      .dbg-panel {
        position: relative;
      }
      .dbg-overlay.dock-right {
        align-items: stretch;
        justify-content: flex-end;
        padding: 8px;
      }
      .dock-right .dbg-panel {
        width: min(48vw, 720px);
        height: auto;
        max-height: none;
        border-radius: 10px;
        resize: horizontal;
        transform: none !important;
      }
      .dbg-overlay.dock-bottom {
        align-items: flex-end;
        padding: 8px;
      }
      .dock-bottom .dbg-panel {
        width: calc(100vw - 16px);
        height: min(44vh, 460px);
        max-width: none;
        border-radius: 10px;
        resize: vertical;
        transform: none !important;
      }
      .dbg-empty {
        color: #666;
        padding: 24px;
        text-align: center;
      }
      @media (max-width: 599px) {
        .dbg-overlay {
          background: rgba(0, 0, 0, 0.55);
          pointer-events: auto;
        }
        .dbg-panel {
          width: 100vw;
          height: 100dvh;
          min-width: 0;
          min-height: 0;
          max-width: none;
          max-height: none;
          border: 0;
          border-radius: 0;
          transform: none !important;
          resize: none;
        }
        .dbg-overlay.dock-right,
        .dbg-overlay.dock-bottom {
          align-items: center;
          justify-content: center;
          padding: 0;
        }
        .dbg-grip {
          cursor: default;
          padding-top: var(--soms-safe-top, 0px);
        }
        .dbg-grip > svg {
          display: none;
        }
        .dock-btn {
          display: none;
        }
        .dbg-bar {
          align-items: stretch;
        }
        .dbg-search {
          flex-basis: 100%;
          order: 3;
        }
      }
    `,
  ],
})
export class DebugLogOverlayComponent implements OnDestroy {
  /** Emitted when the user closes (backdrop, ✕, or FAB toggle) — the FAB drops the panel. */
  readonly close = output<void>();

  private readonly refreshMs = 2000;
  private readonly tailLines = 2000;

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scroll');
  private readonly panelEl = viewChild<ElementRef<HTMLDivElement>>('panel');
  private readonly injector = inject(Injector);
  private readonly store = inject(DebugLogStore);
  private readonly reports = inject(DiagnosticsReportService);

  readonly rustAvailable = isTauri();
  readonly kotlinAvailable = isAndroidNative();

  readonly showJs = this.store.showJs;
  readonly showRust = this.store.showRust;
  readonly showKotlin = this.store.showKotlin;
  readonly minLevel = this.store.minLevel;
  readonly query = this.store.query;
  readonly caseSensitive = this.store.caseSensitive;
  readonly regexMode = this.store.regexMode;
  readonly selectedId = this.store.selectedId;
  readonly sessionMinId = this.store.sessionMinId;
  readonly lines = this.store.lines;
  readonly filtered = this.store.filtered;
  readonly searchMatcher = this.store.searchMatcher;
  readonly selectedIndex = this.store.selectedIndex;
  /** Whether source snapshots continue to be collected. Independent from scroll following. */
  readonly live = signal(true);
  /** Whether incoming rows should keep the viewport pinned to the tail. */
  readonly followTail = signal(true);
  /** Rows received while the user is reading above the tail. */
  readonly unseen = signal(0);
  readonly dock = signal<DockMode>('float');
  readonly actionNotice = signal('');
  readonly uploadState = signal<UploadState>('idle');
  readonly dockLabel = computed(() => {
    if (this.dock() === 'float') return 'Dock logs to the right';
    if (this.dock() === 'right') return 'Dock logs to the bottom';
    return 'Use floating log window';
  });
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;
  private destroyed = false;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.refresh();
    this.timer = setInterval(() => {
      if (this.live()) void this.refresh();
    }, this.refreshMs);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.dragging) {
      window.removeEventListener('pointermove', this.onGripMove);
      window.removeEventListener('pointerup', this.onGripUp);
      window.removeEventListener('pointercancel', this.onGripCancel);
    }
    window.removeEventListener('pointerdown', this.clearSuppress);
  }

  /** Read all three sources, then append only the lines past the last one shown (stable ids → recycled
   *  DOM). A rotation that pushes our tail out of the fetch window resyncs from the fresh tail. */
  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      const js = [...getConsoleEntries()].map(fromJsEntry);
      const [rust, kotlin] = await Promise.all([
        this.readNative('rust'),
        this.readNative('kotlin'),
      ]);
      if (this.destroyed) return;
      const parsed = mergeByTs([
        ...js,
        ...splitLines(rust).map((l) => parseNativeLine(l, 'rust')),
        ...splitLines(kotlin).map((l) => parseNativeLine(l, 'kotlin')),
      ]);
      const added = this.store.reconcile(parsed);
      if (added === 0) return;
      if (this.followTail()) {
        afterNextRender(() => this.scrollToBottom(), {
          injector: this.injector,
        });
      } else {
        this.unseen.update((count) => count + added);
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  /** Tail one native log via the Rust command; '' when the source isn't reachable on this platform. */
  private async readNative(source: 'rust' | 'kotlin'): Promise<string> {
    if (source === 'rust' && !this.rustAvailable) return '';
    if (source === 'kotlin' && !this.kotlinAvailable) return '';
    try {
      const r = await tauriInvoke<NativeTail>('read_native_log', {
        source,
        tailLines: this.tailLines,
      });
      return r?.content ?? '';
    } catch {
      // Tauri rejections are already logged by tauriInvoke; treat as empty for the merge.
      return '';
    }
  }

  /** Stick-to-bottom detector (scroll handler). Scrolling up pauses the live tail; returning to the
   *  bottom resumes + catches up at once. */
  onScroll(): void {
    const el = this.scrollEl()?.nativeElement;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (atBottom) {
      this.followTail.set(true);
      this.unseen.set(0);
    } else {
      this.followTail.set(false);
    }
  }

  private scrollToBottom(): void {
    const el = this.scrollEl()?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
      this.followTail.set(true);
      this.unseen.set(0);
    }
  }

  // ---------- Drag-to-move (compositor-only — zero reflow) ----------
  // The grip repositions the panel by mutating `transform` only. We never touch `left`/`top`/`position`:
  // those force layout on a large panel that also hosts a live-refreshing log list, which reflows on every
  // pointermove and janks. `transform` is GPU-composited (no layout, no content paint) and offsetHeight-
  // invariant, so it can't perturb any measured-height model either. Geometry is read ONCE at pointerdown
  // (a single getBoundingClientRect); each pointermove does no layout reads and at most one transform write,
  // coalesced through one requestAnimationFrame so several moves within a frame collapse into one compositor
  // update. The panel stays flex-centered; the translate offsets the composited layer from there.
  private dragging = false;
  private moved = false;
  private startX = 0;
  private startY = 0;
  /** Centered layout origin + size, captured once per drag (visual rect minus the current translate). */
  private baseLeft = 0;
  private baseTop = 0;
  private baseW = 0;
  private baseH = 0;
  /** Translate at grab time (the panel may already be offset from a prior drag this open session). */
  private grabTx = 0;
  private grabTy = 0;
  /** Current total translate applied (persists across drags until the panel is unmounted). */
  private tx = 0;
  private ty = 0;
  /** Latest desired offset + the pending frame that will commit it (rAF coalescing). */
  private pendingTx = 0;
  private pendingTy = 0;
  private rafId = 0;
  /** The grip element currently capturing the active pointer (null between gestures). */
  private gripEl: HTMLElement | null = null;
  /** The pointerId captured on {@link gripEl}; -1 between gestures. */
  private pointerId = -1;
  /** Swallow the one backdrop click a drag synthesizes on release over the dim layer. */
  private suppressClose = false;

  onGripDown(e: PointerEvent): void {
    if (
      this.dock() !== 'float' ||
      window.matchMedia('(max-width: 599px)').matches
    )
      return;
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left-button only for mouse
    const panel = this.panelEl()?.nativeElement;
    if (!panel) return;
    const grip = e.currentTarget as HTMLElement;
    // Capture the pointer on the grip for the whole gesture. A window-only listener loses the touch stream
    // in a WebView the moment implicit capture is dropped or a stray pan issues pointercancel — so on touch
    // the drag never starts (mouse-on-desktop happened to work because mouse pointers need no capture). This
    // is the pattern the app's other pointer drags (avatar-editor, gallery-viewer) already use; a captured
    // event is still dispatched to its target and bubbles, so the window listeners below keep firing.
    grip.setPointerCapture(e.pointerId);
    this.gripEl = grip;
    this.pointerId = e.pointerId;
    e.preventDefault();
    // The single layout read of the drag: visual rect = centered layout + the current (tx, ty) translate.
    const rect = panel.getBoundingClientRect();
    this.baseLeft = rect.left - this.tx;
    this.baseTop = rect.top - this.ty;
    this.baseW = rect.width;
    this.baseH = rect.height;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.grabTx = this.tx;
    this.grabTy = this.ty;
    this.moved = false;
    this.dragging = true;
    panel.classList.add('dragging'); // will-change: transform promotes the panel to its own compositor layer
    window.addEventListener('pointermove', this.onGripMove);
    window.addEventListener('pointerup', this.onGripUp);
    window.addEventListener('pointercancel', this.onGripCancel);
  }

  private onGripMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    if (!this.moved && Math.hypot(dx, dy) < 5) return; // activation threshold — keeps an inert tap inert
    this.moved = true;
    // Desired offset = grab offset + pointer delta, clamped so the visual position (baseLeft + offset) stays
    // inside the viewport with an 8 px margin. No layout reads: base* are cached and innerWidth/Height are
    // viewport metrics.
    this.pendingTx = Math.max(
      8 - this.baseLeft,
      Math.min(
        window.innerWidth - this.baseW - 8 - this.baseLeft,
        this.grabTx + dx,
      ),
    );
    this.pendingTy = Math.max(
      8 - this.baseTop,
      Math.min(
        window.innerHeight - this.baseH - 8 - this.baseTop,
        this.grabTy + dy,
      ),
    );
    if (!this.rafId) this.rafId = requestAnimationFrame(this.applyTransform);
  };

  private applyTransform = (): void => {
    this.rafId = 0;
    const panel = this.panelEl()?.nativeElement;
    if (!panel) return;
    this.tx = this.pendingTx;
    this.ty = this.pendingTy;
    panel.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0)`;
  };

  private onGripUp = (): void => {
    const moved = this.moved;
    this.endDrag();
    if (moved) {
      // A drag ending over the dim backdrop can still synthesize a click on .dbg-overlay — swallow it once,
      // and clear on the next pointerdown anywhere so a later genuine click still closes.
      this.suppressClose = true;
      window.addEventListener('pointerdown', this.clearSuppress, {
        once: true,
      });
    }
    this.moved = false;
  };

  /** pointercancel (a system interrupt — OS notification, gesture theft) ends the gesture the same way a
   *  release does, minus the released-over-backdrop swallow, so the panel is never left mid-drag. */
  private onGripCancel = (): void => {
    this.endDrag();
    this.moved = false;
  };

  /** Tear down the gesture: unhook the listeners, commit any trailing rAF offset, release capture, drop the
   *  compositor-promoting class. Shared by real pointerup and pointercancel. */
  private endDrag(): void {
    window.removeEventListener('pointermove', this.onGripMove);
    window.removeEventListener('pointerup', this.onGripUp);
    window.removeEventListener('pointercancel', this.onGripCancel);
    // Commit the final offset synchronously: a trailing move may have a frame scheduled that won't fire now.
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.applyTransform();
    }
    this.panelEl()?.nativeElement.classList.remove('dragging');
    if (this.gripEl) {
      try {
        this.gripEl.releasePointerCapture?.(this.pointerId);
      } catch {
        // Already released (e.g. the pointer vanished) — nothing to do.
      }
      this.gripEl = null;
    }
    this.dragging = false;
  }

  private clearSuppress = (): void => {
    this.suppressClose = false;
  };

  /** Backdrop click closes — unless the preceding gesture was a drag released over the dim layer. */
  onBackdropClick(): void {
    if (this.suppressClose) {
      this.suppressClose = false;
      window.removeEventListener('pointerdown', this.clearSuppress);
      return;
    }
    this.close.emit();
  }

  toggleLive(): void {
    const enabled = !this.live();
    this.live.set(enabled);
    if (enabled) void this.refresh();
  }

  followNewest(): void {
    this.scrollToBottom();
    if (this.live()) void this.refresh();
  }

  toggleSession(): void {
    if (this.sessionMinId() === null) {
      this.store.startSession();
      this.unseen.set(0);
      this.showNotice('New observation session started');
    } else {
      this.store.restoreHistory();
      this.showNotice('Retained history restored');
    }
  }

  onQueryInput(query: string): void {
    this.query.set(query);
    this.selectFirstMatch();
  }

  toggleCaseSensitive(): void {
    this.caseSensitive.update((value) => !value);
    this.selectFirstMatch();
  }

  toggleRegexMode(): void {
    this.regexMode.update((value) => !value);
    this.selectFirstMatch();
  }

  selectLine(id: number): void {
    this.selectedId.set(id);
  }

  selectMatch(direction: -1 | 1): void {
    const matches = this.filtered();
    if (matches.length === 0) return;
    const current = this.selectedIndex();
    const index =
      current < 0
        ? direction > 0
          ? 0
          : matches.length - 1
        : (current + direction + matches.length) % matches.length;
    this.selectedId.set(matches[index].id);
    this.scrollSelectedIntoView();
  }

  async copyLine(line: Line): Promise<void> {
    if (await this.writeClipboard(line.raw))
      this.showNotice('Copied selected line');
  }

  async copyVisible(): Promise<void> {
    const text = this.visibleText();
    if (!text) return;
    if (await this.writeClipboard(text))
      this.showNotice(`Copied ${this.filtered().length} lines`);
  }

  beginUpload(): void {
    if (!this.rustAvailable) return;
    this.uploadState.set('confirming');
  }

  cancelUpload(): void {
    this.uploadState.set('idle');
  }

  async uploadReport(): Promise<void> {
    if (this.uploadState() === 'uploading') return;
    this.uploadState.set('uploading');
    try {
      const id = await this.reports.upload();
      this.showNotice(`Diagnostic report #${id} uploaded`);
    } catch {
      // Rust retains a failed bundle for its next-launch retry path.
      this.showNotice('Upload failed; report retained for retry');
    } finally {
      this.uploadState.set('idle');
    }
  }

  cycleDock(): void {
    const next: DockMode =
      this.dock() === 'float'
        ? 'right'
        : this.dock() === 'right'
          ? 'bottom'
          : 'float';
    this.dock.set(next);
    if (next !== 'float') {
      const panel = this.panelEl()?.nativeElement;
      if (panel) panel.style.transform = '';
      this.tx = 0;
      this.ty = 0;
      this.pendingTx = 0;
      this.pendingTy = 0;
    }
  }

  private visibleText(): string {
    return this.filtered()
      .map((line) => line.raw)
      .join('\n');
  }

  private selectFirstMatch(): void {
    const first = this.filtered()[0];
    const selected = this.query() && first ? first.id : null;
    this.selectedId.set(selected);
    if (selected !== null) this.scrollSelectedIntoView();
  }

  private scrollSelectedIntoView(): void {
    afterNextRender(
      () => {
        const id = this.selectedId();
        if (id === null) return;
        const row = this.scrollEl()?.nativeElement.querySelector<HTMLElement>(
          `[data-log-id="${id}"]`,
        );
        row?.scrollIntoView({ block: 'nearest' });
      },
      { injector: this.injector },
    );
  }

  private async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      this.showNotice('Clipboard unavailable');
      return false;
    }
  }

  private showNotice(message: string): void {
    this.actionNotice.set(message);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.actionNotice.set('');
      this.noticeTimer = null;
    }, 2200);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close.emit();
  }

  @HostListener('document:keydown', ['$event'])
  onLogKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const editing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable;
    if (editing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.selectMatch(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      const selected = this.lines().find(
        (line) => line.id === this.selectedId(),
      );
      if (!selected) return;
      event.preventDefault();
      void this.copyLine(selected);
    }
  }

  setMinLevel(l: LogLevel): void {
    this.minLevel.set(l);
  }
}
