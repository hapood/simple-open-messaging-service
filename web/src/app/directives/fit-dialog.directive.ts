import { Directive, ElementRef, Input, OnDestroy, AfterViewInit, inject } from '@angular/core';
import { LayoutService } from '../services/layout.service';

/**
 * Dialog "best-fit height on first paint, then lock" mechanism (desktop only).
 *
 * Background: every dialog shares `.popup-com-wrapper.desktop` (height:auto;
 * max-height:80vh; overflow:auto). While the wrapper is height:auto, an inner
 * `flex:1 + overflow-y:auto` list inside a dialog loses its height constraint →
 * content keeps stretching until it hits 80vh, the scrollbar lands on the outer
 * wrapper, and the height jumps around with item count — looking cheap. This
 * directive pins the dialog to an optimal height so the inner list scrolls on its own.
 *
 * How it works (zoneless-friendly: reads/writes raw DOM only, no change detection):
 *  - On the first frame (ngOnInit) it reads host.scrollHeight to get the natural
 *    content height and pins host.style.height = clamp(natural, [min,max]) — so the
 *    dialog is at its final height from the very first paint. This eliminates the
 *    "starts at the minHeight floor, then grows to natural after settling" jump
 *    (the root cause of edit-profile and other static-content dialogs visibly
 *    growing: minHeight 380 < natural ≈510).
 *  - A ResizeObserver watches the host to pick up async content rendering
 *    (lists/images) — no readiness signal needed from each dialog.
 *  - Each size change reschedules a settleMs debounce; once quiet for settleMs the
 *    content is considered stable.
 *  - When stable it reads host.scrollHeight once more (the wrapper is overflow:auto,
 *    so scrollHeight is the unclipped content height; we never mutate style inside
 *    the RO callback, avoiding feedback loops/flicker), clamps it, and writes
 *    host.style.height exactly once, then locks and disconnects the RO. For static
 *    dialogs already sized on the first frame this is an idempotent no-op.
 *  - Once locked the host has a definite px height, so inner flex:1 scroll regions
 *    scroll internally. The inline style outweighs each dialog's height:100% /
 *    min-height:100%, so no !important is needed.
 *
 * mobile/tablet (non-.desktop wrapper, full-screen 100%/100%) is a no-op.
 */
export interface FitDialogOptions {
  /** px lower bound; default 200. Keeps an empty list from rendering a too-short, cheap-looking dialog. */
  minHeight?: number;
  /** px upper bound; default 0.8 * window.innerHeight (matches the wrapper's 80vh). */
  maxHeight?: number;
  /** How long content must be quiet before locking; default 180. Bump for dialogs whose async data lives in child components (e.g. 600). */
  settleMs?: number;
  /**
   * Optional selector for mutually-exclusive content panes (e.g. '.tab-pane'). When set, locking
   * temporarily unhides each pane to read the host's natural height and takes the max, then restores.
   * The caller is responsible for ensuring each pane's async data is ready at lock time. Most dialogs
   * don't need this — measuring the currently-visible content's natural height is enough.
   */
  paneSelector?: string;
}

@Directive({ selector: '[appFitDialog]' })
export class FitDialogDirective implements AfterViewInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly layout = inject(LayoutService);

  private ro?: ResizeObserver;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private locked = false;

  /** Bound via `[appFitDialog]="opts"`; bare `[appFitDialog]` yields '' → all defaults. */
  @Input('appFitDialog') opts: FitDialogOptions | '' = '';

  ngAfterViewInit(): void {
    if (!this.layout.isDesktop()) return; // mobile/tablet are full-screen, no fit needed
    const el = this.host.nativeElement;
    // The host (app-xxx / root div) defaults to display:inline, which breaks scrollHeight and flex
    // layout; promote to block only when it's actually inline — never disturb an existing flex column.
    const disp = getComputedStyle(el).display;
    if (disp === 'inline' || disp === 'inline-block') el.style.display = 'block';
    // Measure in ngAfterViewInit, NOT ngOnInit: a directive's ngOnInit fires when the host node is
    // created but BEFORE its template children (header/body/avatar/handle/…) are rendered, so
    // scrollHeight read there is ~0 → clamp fell back to the minHeight floor (380) → the dialog
    // painted short, then the ResizeObserver re-locked to the real natural height (~510) once the
    // children rendered. That re-lock was the visible "grows after show" jump (the text lines were
    // just the content arriving in the growth frame). ngAfterViewInit runs after the host's whole
    // view is initialized and still within the same change-detection pass (before the browser
    // paints), so the first pin already equals the final natural height — nothing to grow to.
    // If an ancestor is still display:none here, measure() returns 0 and clamp falls back to the
    // minHeight floor; the RO below then corrects to the real natural height once visible.
    const natural = this.measure();
    const height = this.clamp(natural);
    el.style.height = height + 'px';
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(el);
  }

  private onResize(): void {
    if (this.locked) return; // ignore the RO fire triggered by our own write-back after locking
    clearTimeout(this.settleTimer!);
    this.settleTimer = setTimeout(() => this.lockNow(), this.settleMs());
  }

  private lockNow(): void {
    if (this.locked) return;
    this.locked = true;
    this.ro?.disconnect();
    const el = this.host.nativeElement;
    const px = this.clamp(this.measure()) + 'px';
    if (el.style.height !== px) el.style.height = px; // write once, overriding height:100%
  }

  /** Clamp natural height to [minHeight, maxHeight]; first paint and lockNow share one definition so the two never disagree and cause a jump. */
  private clamp(natural: number): number {
    return Math.max(this.minHeight(), Math.min(natural, this.maxHeight()));
  }

  /** Natural content height: max across panes when paneSelector is set, otherwise host.scrollHeight (read-only). */
  private measure(): number {
    const el = this.host.nativeElement;
    const sel = this.options.paneSelector;
    // Temporarily lift the height constraint to read the "natural" content height. Runs synchronously
    // only in ngOnInit (RO not yet observing) and lockNow (RO already disconnected), and restores
    // inline — the browser never paints the intermediate state, so there's no flicker and no RO feedback.
    const prev = el.style.height;
    el.style.height = 'auto';
    try {
      if (!sel) return el.scrollHeight;
      const panes = Array.from(el.querySelectorAll(sel)) as unknown as HTMLElement[];
      if (panes.length === 0) return el.scrollHeight;
      // Temporarily reveal each pane to read the host's natural height, take the max, then restore.
      let max = 0;
      for (const p of panes) {
        const wasHidden = p.hidden;
        if (wasHidden) p.hidden = false;
        max = Math.max(max, el.scrollHeight);
        if (wasHidden) p.hidden = true;
      }
      return max;
    } finally {
      el.style.height = prev;
    }
  }

  /** Normalize '' (bare usage) to an empty object, avoiding the `'' && x ?? d` returns-'' trap. */
  private get options(): FitDialogOptions {
    return typeof this.opts === 'object' && this.opts !== null ? this.opts : {};
  }
  private minHeight(): number {
    return this.options.minHeight ?? 200;
  }
  private maxHeight(): number {
    return this.options.maxHeight ?? Math.round(0.8 * window.innerHeight);
  }
  private settleMs(): number {
    return this.options.settleMs ?? 180;
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    clearTimeout(this.settleTimer!);
  }
}
