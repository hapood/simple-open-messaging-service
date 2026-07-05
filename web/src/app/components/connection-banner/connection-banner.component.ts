import { afterRenderEffect, Component, computed, effect, ElementRef, inject, input, OnDestroy, signal, untracked, viewChild } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { type AnimationPlaybackControls } from 'motion';
import { WebsocketService, ConnectionState } from '../../services/websocket.service';
import { LanguageService } from '../../services/language.service';
import { IndicatorSlotService } from '../../services/indicator-slot.service';
import { prefersReducedMotion, springGradient } from '../../lib/motion-utils';

/** The rendered visual state of the chip. `closed` is only surfaced when a `demoState` override is set
 *  (the playground); in production `closed` = logged out and the shell navigates away, so it stays hidden. */
type ConnVisual = 'connecting' | 'reconnecting' | 'recovered' | 'closed';

/** Per-state palette, expressed as the names of the registered `<color>` CSS vars (--c-*) that hold the
 *  theme-aware concrete colors. {@link ConnectionBannerComponent.morphTo} resolves them at runtime via
 *  getComputedStyle, so Motion receives interpolable rgb() targets without this component knowing the theme. */
const PALETTE: Record<ConnVisual, { from: string; to: string; ic: string }> = {
  connecting:   { from: '--c-amber-1', to: '--c-amber-2', ic: '--c-amber' },
  reconnecting: { from: '--c-amber-2', to: '--c-amber-1', ic: '--c-amber' },
  recovered:    { from: '--c-green-1', to: '--c-green-2', ic: '--c-green' },
  closed:       { from: '--c-red-1',   to: '--c-red-2',   ic: '--c-red' },
};

/**
 * Compact connection-status chip, fixed at the top-right corner of the viewport, sitting *below* the
 * app header (the shell's `--conn-chip-top` var offsets it by `--app-header-h` while the home header
 * is visible, so it never overlaps the search button).
 *
 * The whole reason this exists: a silent SSE disconnect must not read as "messages just stopped arriving".
 * So the chip announces itself on the one transition that matters — `open → reconnecting` — by briefly
 * auto-expanding into a pill with the detail text, then collapsing back to a spinner dot. Click expands
 * it again any time. Boot `connecting` shows the dot quietly (no auto-expand). On recovery
 * (`reconnecting → open`) it morphs the spinner into a green check over ~1.4s, then fades out and is
 * removed from the DOM. Boot `connecting → open` does NOT flourish — only an actual reconnect does.
 *
 * === Animation (split: CSS for shapes, Motion for the gradient) ===
 * The icon is ONE svg carrying every shape — a revolving arc (`.spin`), a check (`.check`), and an
 * offline ring+slash (`.off`). Shape VISIBILITY and the draw-on crossfade are owned by CSS: the chip carries
 * a `[data-state]` binding, and per-state rules rest the active shape at opacity:1 / stroke-dashoffset:0
 * (each shape is `pathLength="100"`, so dashoffset 100→0 is a uniform draw-on regardless of geometry), with a
 * `transition` crossing opacity/dashoffset over ~0.28–0.45s. The perpetual idle spin is CSS too.
 *
 * Motion is used ONLY for the gradient morph — on each visual-state change a Motion `effect` springs the
 * chip's gradient stops (`--g-from`/`--g-to`) and icon color (`--ic`), the registered `<color>` vars that
 * interpolate cleanly. This split is deliberate: Motion's imperative opacity tween on these SVG elements
 * rides WAAPI with the default fill:none, so it reverts to the CSS base (opacity:0) the instant the crossfade
 * finishes — the spinner/check would disappear after ~0.3s. CSS transitions hold their end state reliably.
 * Motion is DOM-direct, so it is fully zoneless-safe (no reliance on Angular change detection).
 * `prefers-reduced-motion` snaps every transition/morph to its end state and halts the spin/shimmer CSS.
 *
 * Visual states (driven by `show()`):
 *  - `connecting` / `reconnecting`: amber gradient + revolving arc (reconnecting spins faster, auto-expands).
 *  - `recovered`: green gradient + check drawn on, then the chip fades out (`.recovering`).
 *  - `closed` (playground only): red gradient + offline ring/slash.
 *  - hidden otherwise (steady `open`, or production `closed` = logged out → navigate away).
 */
@Component({
  selector: 'app-connection-banner',
  standalone: true,
  template: `
    @if (show(); as s) {
      <button class="chip tonal-chip"
              #chip
              type="button"
              [class.expanded]="expanded()"
              [class.recovering]="s === 'recovered'"
              [class.spinning]="s === 'connecting' || s === 'reconnecting'"
              [attr.data-state]="s"
              [style.--spin-dur]="spinDur() + 'ms'"
              [attr.aria-label]="ariaLabel()"
              [attr.aria-expanded]="expanded()"
              (click)="onClick()">
        <span class="icon" aria-hidden="true">
          <svg class="ic" viewBox="0 0 24 24" fill="none">
            <!-- The revolving spinner: track + arc. The group rotates via CSS; its visibility is owned by the
                 [data-state] CSS rules (opacity transition), NOT Motion — see the styles block. -->
            <g class="spin">
              <circle class="track" cx="12" cy="12" r="9" pathLength="100" />
              <circle class="arc"   cx="12" cy="12" r="9" pathLength="100" />
            </g>
            <!-- Recovered check. Drawn on by CSS (stroke-dashoffset 100 → 0) when data-state="recovered". -->
            <path class="check" d="M7 12.8l3.1 3.1L17 9" pathLength="100" />
            <!-- Offline glyph. Drawn on together when the chip is in the 'closed' state. -->
            <g class="off">
              <circle class="off-ring" cx="12" cy="12" r="8" pathLength="100" />
              <line   class="slash"    x1="6.5" y1="6.5" x2="17.5" y2="17.5" pathLength="100" />
            </g>
          </svg>
        </span>
        <!-- Always rendered (NOT behind @if): the text column's width is JS-measured (scrollWidth → --text-w
             on the chip) and transitioned, so the dot↔pill morph is continuous both ways AND a label swap
             can't snap the width (content-driven width isn't transitionable; a measured, transitioned width
             is). aria-live announces state changes; the chip's aria-label carries the accessible name, so the
             duplicated inner text is not re-read. -->
        <span #text class="text" aria-live="polite">{{ label() }}</span>
      </button>
    }
  `,
  styles: [`
    :host {
      position: fixed;
      top: var(--conn-chip-top, 10px);
      right: 12px;
      /* Above the shell's slot layers (mobile aside-slot 40 / chat-slot 30 / tablet aside-slot 20) so it
         stays visible over the mobile full-screen chat overlay, AND above the update banner (51); below
         modal/popover stacks. NOT a blind 9999. */
      z-index: 52;
      display: block;
      /* Palette source-of-truth: theme-aware concrete colors resolved from --app-* tokens. The --c-* vars
         are registered <color> (see styles.scss), so these compute to concrete rgb() that Motion reads. */
      --c-amber-1: color-mix(in srgb, var(--app-warning) 16%, var(--app-surface));
      --c-amber-2: color-mix(in srgb, var(--app-warning) 30%, var(--app-surface));
      --c-green-1: color-mix(in srgb, var(--app-success) 18%, var(--app-surface));
      --c-green-2: color-mix(in srgb, var(--app-success) 34%, var(--app-surface));
      --c-red-1:   color-mix(in srgb, var(--app-danger)  16%, var(--app-surface));
      --c-red-2:   color-mix(in srgb, var(--app-danger)  32%, var(--app-surface));
      --c-amber:   var(--app-warning);
      --c-green:   var(--app-success);
      --c-red:     var(--app-danger);
      /* Initial gradient/icon color = the connecting palette; Motion retargets these on every state change. */
      --g-from: color-mix(in srgb, var(--app-warning) 16%, var(--app-surface));
      --g-to:   color-mix(in srgb, var(--app-warning) 30%, var(--app-surface));
      --ic:     var(--app-warning);
    }
    .chip {
      box-sizing: border-box;
      height: 36px;
      /* width is auto (content-driven): collapsed content = 36px icon ⇒ a 36px circle; expanded content =
         icon + gap + text + padding ⇒ a pill. The continuous dot↔pill transition is driven by the text
         column's width (see .text) plus gap/padding below — NOT by transitioning this element's width
         (auto isn't animatable) or max-width (a constant safety cap for long labels). */
      width: auto;
      max-width: 340px; /* safety cap; the text column is JS-measured, so the chip sizes to real content */
      padding: 0;
      gap: 0; /* collapsed: 0 gap ⇒ icon(36) + text(0) + padding(0) = exactly the 36px circle */
      cursor: pointer;
      overflow: hidden;
      /* The shimmer (background-position drift) needs a >100% background-size; the gradient itself, the
         elevation, the pill shape, and currentColor all come from the shared .tonal-chip shell. */
      background-size: 220% 220%;
      background-position: 0% 0%;
      /* gap + padding transition alongside the text's width → the dot↔pill morph is continuous. Easing is
         the M3 standard curve. (gradient + color are OWNED by Motion's spring, excluded to avoid fighting it.) */
      transition:
        gap 0.30s cubic-bezier(0.2, 0, 0, 1),
        padding 0.30s cubic-bezier(0.2, 0, 0, 1),
        box-shadow 0.20s cubic-bezier(0.2, 0, 0, 1);
    }
    /* Continuous gradient drift while a spin state is active (the "gradient animation"). Paused otherwise
       (offline/recovered stay still). Non-box visual values (exempt from the integer-px rule). */
    .chip.spinning {
      animation: conn-shimmer 2.6s linear infinite;
    }
    /* M3 state layer: a currentColor overlay atop the fill surfaces the interactive affordance on
       hover/focus/press. pointer-events:none so the click still hits the button. */
    .chip::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: currentColor;
      opacity: 0;
      transition: opacity 0.20s linear;
      pointer-events: none;
    }
    .chip:hover::before         { opacity: 0.08; }
    .chip:focus-visible::before { opacity: 0.10; }
    .chip:active::before        { opacity: 0.12; }
    .chip:focus-visible {
      outline: 2px solid color-mix(in srgb, currentColor 60%, transparent);
      outline-offset: 2px;
    }
    .chip.expanded {
      gap: 8px;
      padding: 0 14px 0 8px;
    }
    .icon {
      flex: 0 0 36px;
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
    }
    .ic {
      width: 20px;
      height: 20px;
      display: block;
      overflow: visible;
    }
    /* The spinner group revolves around its own center; --spin-dur is bound per state (faster on reconnect).
       Visibility is driven by [data-state] (below) and crossed over via a CSS transition. This is NOT left to
       Motion: its imperative opacity tween on these SVG elements doesn't hold a resting value (WAAPI fill:none
       reverts to the opacity:0 base once the crossfade finishes), so the spinner would vanish after ~0.28s. */
    .spin {
      transform-box: fill-box;
      transform-origin: center;
      animation: conn-spin var(--spin-dur, 1.6s) linear infinite;
      opacity: 0;
      transition: opacity 0.28s cubic-bezier(0.2, 0, 0, 1);
    }
    .track {
      fill: none;
      stroke: color-mix(in srgb, currentColor 22%, transparent);
      stroke-width: 3;
    }
    .arc {
      fill: none;
      stroke: currentColor;
      stroke-width: 3;
      stroke-linecap: round;
      stroke-dasharray: 24 76; /* ~86° arc; gap (76) > dash ⇒ a single arc segment on the pathLength=100 ring */
      animation: conn-arc 1.4s ease-in-out infinite; /* breathe the length for the indeterminate feel */
    }
    /* Check + offline shapes: drawn on by CSS via stroke-dashoffset. pathLength=100 ⇒ offset 100 = fully
       hidden, 0 = fully drawn. The resting (drawn) state for the active shape is set by the [data-state]
       rules below; opacity + dashoffset cross over via CSS transition. As with .spin, Motion is deliberately
       NOT used here — its WAAPI tween reverts to this hidden base once the draw finishes. */
    .check,
    .off-ring,
    .slash {
      fill: none;
      stroke: currentColor;
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: 100;
      stroke-dashoffset: 100;
      opacity: 0;
      transition:
        opacity 0.45s cubic-bezier(0.2, 0, 0, 1),
        stroke-dashoffset 0.45s cubic-bezier(0.2, 0, 0, 1);
    }
    .slash { stroke-width: 3.2; }
    /* Resting shape visibility, keyed off the chip's [data-state] binding — the single source of truth for
       which icon is shown. CSS owns this (and the transition into it); Motion owns only the gradient morph. */
    .chip[data-state="connecting"]   .spin,
    .chip[data-state="reconnecting"] .spin { opacity: 1; }
    .chip[data-state="recovered"]    .check { opacity: 1; stroke-dashoffset: 0; }
    /* The offline glyph draws on AFTER the pill→circle collapse (transition-delay = the collapse duration).
       Without the delay, the slash strokes across the still-resizing chip — a bright diagonal "flash" from
       bottom-right to top-left mid-collapse. Delaying only the draw-on (set here, in the active-state rule)
       means leaving 'closed' still fades the glyph out immediately. */
    .chip[data-state="closed"]       .off-ring,
    .chip[data-state="closed"]       .slash { opacity: 1; stroke-dashoffset: 0; transition-delay: 0.30s; }
    /* The text column's width is JS-measured (the effect writes scrollWidth → --text-w on the chip) and
       transitioned, NOT content-driven. This is the fix for the label-swap width glitch: content width can't
       be transitioned, so a label change while the pill is open used to snap the chip width instantly. With a
       measured target, width always animates 0 ↔ --text-w (or old --text-w ↔ new --text-w), smoothly.
       min-width:0 + overflow:hidden beat the flex shrink-floor so width:0 actually collapses it. */
    .text {
      white-space: nowrap;
      /* M3 label-large (14 / 500 / 20). line-height stays an integer-px length per the rule. */
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      min-width: 0;
      width: 0;
      opacity: 0;
      overflow: hidden;
      transition:
        width 0.30s cubic-bezier(0.2, 0, 0, 1),
        opacity 0.20s linear;
    }
    .chip.expanded .text {
      width: var(--text-w, 200px); /* fallback only; the effect sets the real measured width */
      opacity: 1;
      transition-delay: 0.08s; /* let the pill begin opening before the text shows */
    }
    /* Recover exit: the chip scales in, holds while Motion draws the check, then fades out before the
       recovering signal flips to false and the element is removed. Background/color are NOT set here —
       Motion's green morph owns them; this only animates opacity/scale (non-box, exempt). */
    .chip.recovering {
      animation: conn-recover 1.4s cubic-bezier(0.2, 0, 0, 1) forwards;
    }
    @keyframes conn-shimmer { to { background-position: 200% 200%; } }
    @keyframes conn-spin    { to { transform: rotate(360deg); } }
    @keyframes conn-arc {
      0%, 100% { stroke-dasharray: 18 82; }
      50%      { stroke-dasharray: 34 66; }
    }
    @keyframes conn-recover {
      0%   { opacity: 0; transform: scale(0.82); }
      18%  { opacity: 1; transform: scale(1); }
      70%  { opacity: 1; transform: scale(1); }
      100% { opacity: 0; transform: scale(0.9); }
    }
    @media (prefers-reduced-motion: reduce) {
      .chip            { transition: none; }
      .chip.spinning,
      .spin,
      .arc             { animation: none; }
      /* Static, fully-visible arc so the indicator is recognizable without motion. */
      .arc             { stroke-dasharray: 30 70; }
      /* Shapes snap (no crossfade) to their [data-state] resting visibility; the gradient morph also snaps. */
      .spin,
      .check,
      .off-ring,
      .slash           { transition: none; }
      .text            { transition: none; transform: none; }
    }
  `],
})
export class ConnectionBannerComponent implements OnDestroy {
  private readonly ws = inject(WebsocketService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  /** The top-right indicator slot — this component is its PRIORITY occupant. While visible, it occupies
   *  the slot so the lower-priority update banner defers (and shows once the chip clears, if still wanted). */
  private readonly slot = inject(IndicatorSlotService);

  /** Optional playground override: when non-null, the chip renders this state instead of the live
   *  WebsocketService signal — the chatbox playground's "Connection status" control uses it to preview
   *  every state. Production leaves it unset, so behavior is identical to the service. */
  readonly demoState = input<ConnectionState | null>(null);

  /** Effective state: the demo override if set, else the live SSE state. The single source read by
   *  show()/label()/the transition + morph effects — so a demo toggle drives the full machine. */
  protected readonly effState = computed<ConnectionState>(() => this.demoState() ?? this.ws.state());

  /** True for ~1.4s after a reconnect recovers — drives the spinner→check flourish. */
  readonly recovering = signal(false);

  /** Pill expanded (click toggles; auto-expand briefly on a mid-session reconnect). */
  readonly expanded = signal(false);

  /** Only meaningful between the reconnect drop and the open that follows it. */
  private wasReconnecting = false;

  private autoExpandTimer?: ReturnType<typeof setTimeout>;
  private recoverTimer?: ReturnType<typeof setTimeout>;

  /** The chip button, populated by the `@if` once show() turns truthy. Motion drives its children. */
  private readonly chipRef = viewChild<ElementRef<HTMLButtonElement>>('chip');

  /** The detail-text span. Its scrollWidth is measured to drive the expanded pill width (see measureText). */
  private readonly textRef = viewChild<ElementRef<HTMLSpanElement>>('text');

  /** Active Motion controls — stopped before each morph so transitions never overlap/fight. */
  private controls: AnimationPlaybackControls[] = [];

  /** Lazily-created Canvas 2D context used to measure label widths via TextMetrics (see afterRenderEffect). */
  private measureCtx: CanvasRenderingContext2D | null | undefined;

  /** Per-state idle spin period (ms). Reconnecting spins faster (urgency); connecting is a calm scan. */
  readonly spinDur = computed(() => this.effState() === 'reconnecting' ? 900 : 1600);

  /** Cached reduced-motion preference — snaps every morph to its end state instead of animating. */
  private readonly reduceMotion = prefersReducedMotion();

  /** The visual state to render, or undefined (hidden). `closed` surfaces only in the playground. */
  readonly show = computed<ConnVisual | undefined>(() => {
    if (this.recovering()) return 'recovered';
    const s = this.effState();
    if (s === 'connecting' || s === 'reconnecting') return s;
    if (s === 'closed' && this.demoState() !== null) return 'closed'; // playground-only
    return undefined;
  });

  /** Detail text for the expanded pill / aria-label. Re-evaluates on language switch. */
  readonly label = computed(() => {
    this.language.lang();
    switch (this.effState()) {
      case 'connecting':   return this.transloco.translate('connection.connecting');
      case 'reconnecting': return this.transloco.translate('connection.reconnecting');
      case 'closed':       return this.transloco.translate('connection.offline');
      default:             return this.transloco.translate('connection.recovered');
    }
  });

  readonly ariaLabel = computed(() => {
    this.language.lang();
    const base = this.label();
    // In `reconnecting` the click is a retry trigger — convey that affordance in the accessible name.
    return this.effState() === 'reconnecting'
      ? `${base}. ${this.transloco.translate('connection.retry')}`
      : base;
  });

  constructor() {
    /* State-transition watcher: the only writer of `recovering`/`wasReconnecting`, and the auto-expand
       trigger. Reading effState() here is the single reactive input; writes go to independent signals. */
    effect(() => {
      const s: ConnectionState = this.effState();
      if (s === 'reconnecting') {
        // The failure mode this component exists for — announce it, don't rely on the user spotting a dot.
        this.wasReconnecting = true;
        this.scheduleAutoExpand();
      } else if (s === 'connecting') {
        // Boot connect: show the dot quietly (no auto-expand, no flourish on the open that follows).
        this.wasReconnecting = false;
        this.collapse();
      } else if (s === 'open') {
        if (this.wasReconnecting) this.playRecoverFlourish();
        this.wasReconnecting = false;
      } else { // 'closed' (logout / force-login) — the shell navigates away; just reset.
        this.wasReconnecting = false;
        this.collapse();
      }
    });

    /* Motion morph: runs on every visual-state change AND on first mount (once chipRef resolves). Tracks
       show() so it follows effState + recovering; no signal writes (pure DOM via Motion). */
    effect(() => {
      const s = this.show();
      const el = this.chipRef();
      if (!el || !s) return;
      this.morphTo(s);
    });

    /* Report visibility to the indicator slot so the lower-priority update banner can defer while this
       chip is showing (and surface once it clears). show() is the single source of chip visibility. */
    effect(() => {
      this.slot.priorityOccupied.set(!!this.show());
    });

    /* Measure the detail label's natural width whenever it changes (state or language) and publish it as
       --text-w on the chip. The .text column transitions its `width` to var(--text-w), so the pill sizes to
       the real label AND a label swap animates width old → new instead of snapping (content width itself
       can't be transitioned — that snap was the glitch).
       Measurement uses Canvas TextMetrics, NOT el.scrollWidth: scrollWidth reflects browser layout, which
       lagged the {{label()}} DOM update by a frame even inside afterRenderEffect (forcing reflow didn't help)
       — so a label change read the PREVIOUS label's width. Canvas measureText computes the width from the
       font metrics directly, with no layout dependency, so it's correct the instant the textContent updates.
       +2px keeps sub-pixel rounding from clipping the last glyph. */
    afterRenderEffect(() => {
      this.label(); // track: re-measure on any state or language change
      const textEl = this.textRef()?.nativeElement;
      const chipEl = this.chipRef()?.nativeElement;
      if (!textEl || !chipEl) return;
      const ctx = this.measureCtx ??= document.createElement('canvas').getContext('2d');
      if (!ctx) return;
      ctx.font = getComputedStyle(textEl).font;
      const w = Math.ceil(ctx.measureText(textEl.textContent ?? '').width) + 2;
      if (w > 2) chipEl.style.setProperty('--text-w', `${w}px`);
    });
  }

  /** Spring the gradient stops + icon color to the new state's palette. The icon shapes' visibility and
   *  draw-on are owned by CSS — keyed off the `[data-state]` binding in the template — so Motion handles
   *  only the gradient morph here, the one thing it does better than CSS (interpolating registered `<color>`
   *  stops via a spring). See the styles block for why shape opacity/dashoffset are NOT Motion-driven. */
  private morphTo(s: ConnVisual): void {
    const chipEl = this.chipRef()?.nativeElement;
    if (!chipEl) return;
    const cs = getComputedStyle(chipEl);
    const p = PALETTE[s];
    const read = (name: string): string => cs.getPropertyValue(name).trim();

    this.controls.forEach((c) => c.stop());
    this.controls = [];

    // Reduced motion: snap the gradient/icon color (the shapes snap via the CSS reduced-motion transition:none).
    if (this.reduceMotion) {
      chipEl.style.setProperty('--g-from', read(p.from));
      chipEl.style.setProperty('--g-to', read(p.to));
      chipEl.style.setProperty('--ic', read(p.ic));
      return;
    }

    // Gradient stops + icon color: spring the registered <color> vars (shared with the update banner).
    this.controls.push(springGradient(chipEl, { from: p.from, to: p.to, ic: p.ic }));
  }

  /** Chip click. In `reconnecting` (the one state where the user has agency) it triggers an immediate
   *  retry — skipping the worker's backoff — and collapses the pill as visible feedback that the tap
   *  landed; the dot keeps spinning while the reconnect is retried, and the recover flourish fires on
   *  success. In the other shown states the click just toggles the pill open/closed to read the detail. */
  onClick(): void {
    clearTimeout(this.autoExpandTimer);
    if (this.effState() === 'reconnecting') {
      this.expanded.set(false);
      this.ws.retryNow();
    } else {
      this.expanded.update((v) => !v);
    }
  }

  private scheduleAutoExpand(): void {
    // untracked is load-bearing: this is called from the state-transition effect, and reading expanded()
    // reactively here would register it as a dependency. The effect would then re-run on every toggle, hit
    // the reconnecting branch, and call this again — immediately re-expanding (so manual collapse and the
    // 3.2s auto-collapse could never take effect while reconnecting). Read it without tracking.
    if (untracked(this.expanded)) return;
    this.expanded.set(true);
    clearTimeout(this.autoExpandTimer);
    this.autoExpandTimer = setTimeout(() => this.expanded.set(false), 3200);
  }

  /** Collapse the pill and cancel any pending auto-collapse. Called when leaving the announcement state for
   *  a quiet one (connecting/closed) so those states always read as a dot/glyph, never inheriting a stale
   *  `expanded` left over from a prior reconnecting announcement. A manual click still wins between transitions. */
  private collapse(): void {
    clearTimeout(this.autoExpandTimer);
    this.expanded.set(false);
  }

  private playRecoverFlourish(): void {
    // A fast reconnecting → open can leave the 3.2s auto-expand timer pending; cancel it so it can't fire
    // mid-flourish (or after, into a freshly re-mounted chip) and toggle the pill back open.
    clearTimeout(this.autoExpandTimer);
    this.expanded.set(false);
    this.recovering.set(true);
    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => this.recovering.set(false), 1400);
  }

  ngOnDestroy(): void {
    this.controls.forEach((c) => c.stop());
    clearTimeout(this.autoExpandTimer);
    clearTimeout(this.recoverTimer);
    this.slot.priorityOccupied.set(false); // release the indicator slot so a deferred update can show
  }
}
