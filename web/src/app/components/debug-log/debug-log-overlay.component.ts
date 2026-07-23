import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { isAndroidNative, isTauri, tauriInvoke } from '../../services/runtime';
import { clearConsoleBuffer, getConsoleEntries } from '../../services/log-buffer';
import {
  fromJsEntry,
  type LogLevel,
  mergeByTs,
  type MergedLine,
  parseNativeLine,
  splitLines,
} from './debug-log-merge';

interface NativeTail {
  path: string;
  content: string;
}

/** A merged line carrying a stable id so the `@for … track l.id` recycles DOM nodes across refreshes
 *  (the append-only merge in {@link refresh} assigns ids monotonically and never reuses them). */
type Line = MergedLine & { id: number };

/**
 * The 3-layer debug log viewer. Opened on demand from {@link DebugLogFabComponent}; reads the JS ring
 * buffer in memory + tails the two native logs via the Rust `read_native_log` command, then merges them by
 * timestamp with source attribution + level coloring. The merged view is what the removed
 * `attachRustConsole` approximated by polluting the JS console — here it is a first-class, filterable panel.
 *
 * **Append-only:** each refresh reads the full tails but APPENDS only the lines past the last one already
 * shown (matched by source+raw+ts). This gives every line a stable id, so the view never rebuilds the whole
 * list — new lines are appended, old ones persist (efficient + no scroll jitter).
 *
 * **Stick-to-bottom:** while the viewport sits at the bottom, the panel auto-refreshes (2 s) and pins to the
 * newest line. Scrolling UP freezes the tail (the interval skips while not stuck) so you can read a region
 * undisturbed; scrolling back to the bottom resumes + catches up immediately.
 *
 * Zoneless-safe: state is signals; the interval only writes signals; DOM scroll is deferred to
 * `afterNextRender` (guaranteed after the row render, not racy on microtask-vs-macrotask ordering).
 */
@Component({
  selector: 'app-debug-log-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dbg-overlay" role="dialog" aria-label="Debug logs" (click)="onBackdropClick()">
      <div #panel class="dbg-panel" (click)="$event.stopPropagation()">
        <div class="dbg-grip" (pointerdown)="onGripDown($event)" title="Drag to move" aria-label="Drag panel">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">
            <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
            <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
            <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
          </svg>
        </div>
        <div class="dbg-bar">
          <div class="dbg-srcs">
            <button type="button" class="chip src-js" [class.on]="showJs()" (click)="showJs.set(!showJs())">JS</button>
            <button type="button" class="chip src-rust" [class.on]="showRust()" (click)="showRust.set(!showRust())">Rust</button>
            <button type="button" class="chip src-kotlin" [class.on]="showKotlin()" (click)="showKotlin.set(!showKotlin())">Kotlin</button>
          </div>
          <select class="dbg-level" [value]="minLevel()" (change)="setMinLevel($any($event.target).value)">
            <option value="debug">Debug+</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error</option>
          </select>
          <input
            class="dbg-search"
            type="search"
            placeholder="filter…"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
          <button type="button" class="dbg-btn" [class.on]="auto()" (click)="toggleAuto()" title="Auto-refresh">⟳</button>
          <button type="button" class="dbg-btn" (click)="copyAll()" title="Copy filtered">⧉</button>
          <button type="button" class="dbg-btn" (click)="exportTxt()" title="Export .txt">⤓</button>
          <button type="button" class="dbg-btn" (click)="clearJs()" title="Clear">⌫</button>
          <button type="button" class="dbg-btn close" (click)="close.emit()" title="Close">✕</button>
        </div>
        <div class="dbg-status">
          @if (!rustAvailable) { <span class="na">Rust n/a</span> }
          @if (!kotlinAvailable) { <span class="na">Kotlin n/a</span> }
          <span>{{ filtered().length }}/{{ lines().length }}</span>
          <span class="spacer"></span>
          <span class="hint">{{ auto() ? (stick() ? 'live 2s' : 'paused (scrolled up)') : 'paused' }}</span>
        </div>
        <div #scroll class="dbg-list" (scroll)="onScroll()">
          @for (l of filtered(); track l.id) {
            <div class="dbg-line lvl-{{ l.level }}">
              <span class="badge src-{{ l.source }}">{{ l.source }}</span>
              @if (l.rawTs) {
                <span class="ts">{{ l.rawTs.slice(11, 23) }}</span>
              }
              <span class="msg">{{ l.text }}</span>
            </div>
          } @empty {
            <div class="dbg-empty">No matching lines.</div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .dbg-overlay {
        position: fixed;
        inset: 0;
        z-index: 1200; /* above lightbox (1100) — the debug surface must stay reachable over any overlay */
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .dbg-panel {
        width: min(96vw, 1100px);
        height: min(82vh, 720px);
        background: #1e1e1e;
        color: #e6e6e6;
        border: 1px solid #000;
        border-radius: 12px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .dbg-grip {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 24px;
        line-height: 24px; /* integer px — keeps the grip strip a whole-pixel height */
        background: #2a2a2a;
        border-bottom: 1px solid #000;
        color: #666;
        cursor: grab;
        touch-action: none; /* the grip owns the gesture: a drag never scrolls the log list or the page */
        user-select: none;
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
      .chip.src-js.on { background: #2563eb; border-color: #2563eb; }
      .chip.src-rust.on { background: #d97706; border-color: #d97706; }
      .chip.src-kotlin.on { background: #16a34a; border-color: #16a34a; }
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
      .dbg-btn.close {
        margin-left: auto;
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
      .dbg-status .na { color: #d97706; }
      .dbg-status .spacer { flex: 1 1 auto; }
      .dbg-list {
        flex: 1 1 auto;
        overflow-y: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 18px;
        padding: 6px 8px;
      }
      .dbg-line {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .badge {
        flex: 0 0 auto;
        font-size: 10px;
        line-height: 14px;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 4px;
        margin-top: 1px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .badge.src-js { background: #2563eb; color: #fff; }
      .badge.src-rust { background: #d97706; color: #fff; }
      .badge.src-kotlin { background: #16a34a; color: #fff; }
      .ts {
        flex: 0 0 auto;
        color: #777;
      }
      .msg { flex: 1 1 auto; }
      .dbg-line.lvl-error .msg { color: #ff6b6b; }
      .dbg-line.lvl-warn .msg { color: #ffd166; }
      .dbg-line.lvl-debug .msg { color: #888; }
      .dbg-empty {
        color: #666;
        padding: 24px;
        text-align: center;
      }
    `,
  ],
})
export class DebugLogOverlayComponent implements OnDestroy {
  /** Emitted when the user closes (backdrop, ✕, or FAB toggle) — the FAB drops the panel. */
  readonly close = output<void>();

  private readonly refreshMs = 2000;
  private readonly maxView = 1500;
  private readonly tailLines = 2000;
  private readonly levelRank: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, log: 3, debug: 4 };

  private readonly scrollEl = viewChild<ElementRef<HTMLDivElement>>('scroll');
  private readonly panelEl = viewChild<ElementRef<HTMLDivElement>>('panel');
  private readonly injector = inject(Injector);

  readonly rustAvailable = isTauri();
  readonly kotlinAvailable = isAndroidNative();

  readonly showJs = signal(true);
  readonly showRust = signal(true);
  readonly showKotlin = signal(true);
  readonly minLevel = signal<LogLevel>('debug');
  readonly query = signal('');
  /** Master auto-refresh toggle. */
  readonly auto = signal(true);
  /** Stick-to-bottom: false while the viewport is scrolled up (freezes the live tail). */
  readonly stick = signal(true);

  readonly lines = signal<Line[]>([]);
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly filtered = computed<Line[]>(() => {
    const min = this.levelRank[this.minLevel()];
    const q = this.query().trim().toLowerCase();
    const wantJs = this.showJs();
    const wantRust = this.showRust();
    const wantKotlin = this.showKotlin();
    const out: Line[] = [];
    for (const l of this.lines()) {
      if (!wantJs && l.source === 'js') continue;
      if (!wantRust && l.source === 'rust') continue;
      if (!wantKotlin && l.source === 'kotlin') continue;
      if (this.levelRank[l.level] > min) continue;
      if (q && !l.raw.toLowerCase().includes(q)) continue;
      out.push(l);
    }
    return out;
  });

  constructor() {
    void this.refresh();
    this.timer = setInterval(() => {
      // Skip while the user has scrolled up to read (stick-to-bottom) — resume when they return to the
      // bottom (onScroll triggers an immediate catch-up refresh there).
      if (this.auto() && this.stick()) void this.refresh();
    }, this.refreshMs);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.dragging) {
      window.removeEventListener('pointermove', this.onGripMove);
      window.removeEventListener('pointerup', this.onGripUp);
    }
    window.removeEventListener('pointerdown', this.clearSuppress);
  }

  /** Read all three sources, then append only the lines past the last one shown (stable ids → recycled
   *  DOM). A rotation that pushes our tail out of the fetch window resyncs from the fresh tail. */
  private async refresh(): Promise<void> {
    const js = [...getConsoleEntries()].map(fromJsEntry);
    const [rust, kotlin] = await Promise.all([this.readNative('rust'), this.readNative('kotlin')]);
    const parsed = mergeByTs([
      ...js,
      ...splitLines(rust).map((l) => parseNativeLine(l, 'rust')),
      ...splitLines(kotlin).map((l) => parseNativeLine(l, 'kotlin')),
    ]);
    const current = this.lines();
    let fresh: MergedLine[];
    if (current.length === 0) {
      fresh = parsed;
    } else {
      const last = current[current.length - 1];
      const idx = parsed.findIndex(
        (l) => l.source === last.source && l.raw === last.raw && l.ts === last.ts,
      );
      // idx >= 0 → append the lines after our tail; idx < 0 → our tail rotated out of the window, resync.
      fresh = idx >= 0 ? parsed.slice(idx + 1) : parsed;
    }
    if (fresh.length === 0) return;
    const withIds: Line[] = fresh.map((l) => ({ ...l, id: this.nextId++ }));
    this.lines.update((list) => [...list, ...withIds].slice(-this.maxView));
    if (this.stick()) {
      // afterNextRender runs after the appended rows paint, so scrollHeight includes them.
      afterNextRender(() => this.scrollToBottom(), { injector: this.injector });
    }
  }

  /** Tail one native log via the Rust command; '' when the source isn't reachable on this platform. */
  private async readNative(source: 'rust' | 'kotlin'): Promise<string> {
    if (source === 'rust' && !this.rustAvailable) return '';
    if (source === 'kotlin' && !this.kotlinAvailable) return '';
    try {
      const r = await tauriInvoke<NativeTail>('read_native_log', { source, tailLines: this.tailLines });
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
    const wasStick = this.stick();
    this.stick.set(atBottom);
    if (atBottom && !wasStick) void this.refresh();
  }

  private scrollToBottom(): void {
    const el = this.scrollEl()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
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
  /** Swallow the one backdrop click a drag synthesizes on release over the dim layer. */
  private suppressClose = false;

  onGripDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left-button only for mouse
    const panel = this.panelEl()?.nativeElement;
    if (!panel) return;
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
      Math.min(window.innerWidth - this.baseW - 8 - this.baseLeft, this.grabTx + dx),
    );
    this.pendingTy = Math.max(
      8 - this.baseTop,
      Math.min(window.innerHeight - this.baseH - 8 - this.baseTop, this.grabTy + dy),
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
    window.removeEventListener('pointermove', this.onGripMove);
    window.removeEventListener('pointerup', this.onGripUp);
    // Commit the final offset synchronously: a trailing move may have a frame scheduled that won't fire now.
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.applyTransform();
    }
    this.panelEl()?.nativeElement.classList.remove('dragging');
    this.dragging = false;
    if (this.moved) {
      // A drag ending over the dim backdrop can still synthesize a click on .dbg-overlay — swallow it once,
      // and clear on the next pointerdown anywhere so a later genuine backdrop click still closes.
      this.suppressClose = true;
      window.addEventListener('pointerdown', this.clearSuppress, { once: true });
    }
    this.moved = false;
  };

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

  toggleAuto(): void {
    this.auto.update((v) => !v);
  }

  setMinLevel(l: LogLevel): void {
    this.minLevel.set(l);
  }

  async copyAll(): Promise<void> {
    const text = this.filtered()
      .map((l) => l.raw)
      .join('\n');
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard blocked (permissions / non-secure context) — silent; the export action still works.
    }
  }

  exportTxt(): void {
    const text = this.filtered()
      .map((l) => l.raw)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soms-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Wipe the JS ring buffer AND reset the panel view (the cleared JS lines no longer exist, so the
   *  append-only cursor is reset too). Native files are left untouched. */
  clearJs(): void {
    clearConsoleBuffer();
    this.lines.set([]);
    this.nextId = 1;
    void this.refresh();
  }
}
