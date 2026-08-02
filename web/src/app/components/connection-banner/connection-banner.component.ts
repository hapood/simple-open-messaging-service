import { Component, computed, effect, ElementRef, inject, input, OnDestroy, signal, viewChild } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { type AnimationPlaybackControls } from 'motion';
import { WebsocketService, ConnectionState } from '../../services/websocket.service';
import { LanguageService } from '../../services/language.service';
import { IndicatorSlotService } from '../../services/indicator-slot.service';
import { prefersReducedMotion, springGradient } from '../../lib/motion-utils';
import { statusRingTemplate } from '../../lib/status-ring';

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
 * Compact connection-status chip. NOT self-positioned: it is projected into `<app-indicator-slot>`,
 * the single top-center anchor that clears the 56px header (see IndicatorSlotComponent). One position for
 * every indicator — this component only owns its own appearance and behavior.
 *
 * The whole reason this exists: a silent SSE disconnect must not read as "messages just stopped arriving".
 * So the chip announces itself on the one transition that matters — `open → reconnecting` — by expanding
 * into a pill that STAYS open for the whole backoff window, showing a live "reconnecting in Ns" countdown
 * (driven by {@link WebsocketService.reconnectIn}, which each transport feeds with its scheduled-backoff
 * deadline and the facade decrements on a ticker). It collapses the instant it recovers. Boot `connecting`
 * shows the dot quietly (no expand). On recovery (`reconnecting → open`) it morphs the spinner into a
 * green check over ~1.4s, then fades out and is removed from the DOM. Boot `connecting → open` does NOT
 * flourish — only an actual reconnect does.
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
 *  - `connecting` / `reconnecting`: amber gradient + revolving arc (reconnecting spins faster, stays
 *    expanded with the live countdown).
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
              [attr.data-state]="s"
              [style.--spin-dur]="spinDur() + 'ms'"
              [attr.aria-label]="ariaLabel()"
              [attr.aria-expanded]="expanded()"
              (click)="onClick()">
        <span class="icon" aria-hidden="true">
          <svg class="ic" viewBox="0 0 24 24" fill="none">
            <!-- The revolving spinner: track + arc. The group rotates via CSS; its visibility is owned by the
                 [data-state] CSS rules (opacity transition), NOT Motion — see the styles block. -->
            ${statusRingTemplate('spin', 'track', 'arc')}
            <!-- Recovered check. Drawn on by CSS (stroke-dashoffset 100 → 0) when data-state="recovered". -->
            <path class="check" d="M7 12.8l3.1 3.1L17 9" pathLength="100" />
            <!-- Offline glyph. Drawn on together when the chip is in the 'closed' state. -->
            <g class="off">
              <circle class="off-ring" cx="12" cy="12" r="8" pathLength="100" />
              <line   class="slash"    x1="6.5" y1="6.5" x2="17.5" y2="17.5" pathLength="100" />
            </g>
          </svg>
        </span>
        <!-- The visible detail text stays mounted so the dot↔pill transition can be CSS-only. Its wrapper
             animates max-width instead of measuring scrollWidth on every countdown tick; tabular digits keep
             equal-length countdown values stable. aria-hidden prevents per-second screen-reader chatter.
             State transitions are voiced once via the CDK LiveAnnouncer. -->
        <span class="text" aria-hidden="true">{{ label() }}</span>
      </button>
    }
  `,
  styles: [`
    :host {
      /* No positioning here — this component is projected into <app-indicator-slot>, the single
         top-center anchor (its :host carries the position/top/centering/z-index). This :host only owns
         the palette; layout is the slot's job. */
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
      /* width is content-driven: collapsed content = 36px icon; expanded content adds the CSS-clipped text
         column. No DOM width measurement is used, so countdown updates cannot accumulate rounding pixels. */
      width: auto;
      max-width: min(340px, calc(100vw - 32px));
      padding: 0;
      gap: 0; /* collapsed: 0 gap ⇒ icon(36) + text(0) + padding(0) = exactly the 36px circle */
      cursor: pointer;
      overflow: hidden;
      /* The gradient fill, elevation, pill shape, and currentColor all come from the shared .tonal-chip
         shell (the gradient fills the chip at its natural size). Deliberately NO background-position
         shimmer: animating a 2-stop gradient's position sweeps its tonal midpoint diagonally across the
         chip — a moving line that read as a drifting crosshair (the dropped conn-shimmer). The gradient
         stays static during the spin state; Motion morphs it on state changes, and the revolving .arc
         carries the loading motion. */
      /* gap + padding transition alongside the text's max-width → the dot↔pill morph is continuous. Easing is
         the M3 standard curve. (gradient + color are OWNED by Motion's spring, excluded to avoid fighting it.) */
      transition:
        gap 0.30s cubic-bezier(0.2, 0, 0, 1),
        padding 0.30s cubic-bezier(0.2, 0, 0, 1),
        box-shadow 0.20s cubic-bezier(0.2, 0, 0, 1);
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
    .chip[data-state="recovered"]    .check {
      opacity: 1;
      stroke-dashoffset: 0;
      /* Delay the draw-on until the spinner has faded out (.spin's 0.28s opacity transition) AND the
         pill↔circle collapse finishes (the 0.30s gap/padding transition) — otherwise the outgoing arc and
         the incoming check overlap into crossing lines mid-recover, and the check strokes across the
         still-resizing chip. Same gate the 'closed' glyph uses below (transition-delay: 0.30s). Leaving
         'recovered' is a chip unmount, so this delay only shapes the draw-on direction. */
      transition-delay: 0.30s;
    }
    /* The offline glyph draws on AFTER the pill→circle collapse (transition-delay = the collapse duration).
       Without the delay, the slash strokes across the still-resizing chip — a bright diagonal "flash" from
       bottom-right to top-left mid-collapse. Delaying only the draw-on (set here, in the active-state rule)
       means leaving 'closed' still fades the glyph out immediately. */
    .chip[data-state="closed"]       .off-ring,
    .chip[data-state="closed"]       .slash { opacity: 1; stroke-dashoffset: 0; transition-delay: 0.30s; }
    /* CSS-only text reveal. The old scrollWidth + 2px measurement fed the already-constrained width back
       into itself on every countdown render, allowing rounding to grow the pill a pixel at a time. A bounded
       max-width transition keeps the same dot↔pill reveal without synchronous layout reads. */
    .text {
      display: block;
      white-space: nowrap;
      /* M3 label-large (14 / 500 / 20). line-height stays an integer-px length per the rule. */
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      /* tabular-nums: the reconnecting countdown counts down one digit per second (5s→4s→…). Without it,
         proportional digits would each have a different advance width, so the pill would re-flow its
         measured width every tick (the re-measure effect runs on every label() change). Fixed-width digits
         keep the countdown's width constant across ticks. Not a height-contributing property (exempt). */
      font-variant-numeric: tabular-nums;
      min-width: 0;
      max-width: 0;
      opacity: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      transition:
        max-width 0.30s cubic-bezier(0.2, 0, 0, 1),
        opacity 0.20s linear;
    }
    .chip.expanded .text {
      max-width: 274px; /* 340px chip cap minus icon, gap, and horizontal padding */
      opacity: 1;
      transition-delay: 0.08s; /* let the pill begin opening before the text shows */
    }
    /* Recover exit: the chip scales in, holds while Motion draws the check, then fades out before the
       recovering signal flips to false and the element is removed. Background/color are NOT set here —
       Motion's green morph owns them; this only animates opacity/scale (non-box, exempt). */
    .chip.recovering {
      animation: conn-recover 1.4s cubic-bezier(0.2, 0, 0, 1) forwards;
    }
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
  /** CDK LiveAnnouncer: proactively voices connection-state transitions to assistive tech — more reliable
   *  across screen readers than a raw aria-live region (whose mount-announcement is AT-dependent). Used ONLY
   *  for the two transitions worth hearing (drop + recovery); the ticking countdown stays silent (it's the
   *  aria-hidden visible text, never announced per-second). */
  private readonly liveAnnouncer = inject(LiveAnnouncer);
  private readonly language = inject(LanguageService);
  /** The top-center indicator slot — this component is its PRIORITY occupant. While visible, it occupies
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

  /** Pill expanded (stays open while reconnecting to show the live countdown; toggled by click in the other
   *  shown states). */
  readonly expanded = signal(false);

  /** Only meaningful between the reconnect drop and the open that follows it. */
  private wasReconnecting = false;

  private recoverTimer?: ReturnType<typeof setTimeout>;

  /** The chip button, populated by the `@if` once show() turns truthy. Motion drives its children. */
  private readonly chipRef = viewChild<ElementRef<HTMLButtonElement>>('chip');

  /** Active Motion controls — stopped before each morph so transitions never overlap/fight. */
  private controls: AnimationPlaybackControls[] = [];

  /** Per-state idle spin period (ms). Reconnecting spins faster (urgency); connecting is a calm scan. */
  readonly spinDur = computed(() => this.effState() === 'reconnecting' ? 900 : 1600);

  /** Cached reduced-motion preference — snaps every morph to its end state instead of animating. */
  private readonly reduceMotion = prefersReducedMotion();

  /** The visual state to render, or undefined (hidden). `closed` surfaces only in the playground.
   *  `disconnected` (OS offline) reuses the `reconnecting` amber visual — it's still transient connection
   *  trouble worth surfacing expanded — but its label is the static "no network" message (no countdown). */
  readonly show = computed<ConnVisual | undefined>(() => {
    if (this.recovering()) return 'recovered';
    const s = this.effState();
    if (s === 'connecting' || s === 'reconnecting' || s === 'disconnected') return s === 'disconnected' ? 'reconnecting' : s;
    if (s === 'closed' && this.demoState() !== null) return 'closed'; // playground-only
    return undefined;
  });

  /** The static, NON-ticking per-state message — the accessible text (the key {@link announce} voices via
   *  the LiveAnnouncer + the aria-label base). It deliberately EXCLUDES the countdown so assistive tech
   *  hears ONE announcement per state transition, not one per second; the visible pill separately renders
   *  {@link label} (which overlays the ticking number). Re-evaluates on language switch. */
  readonly stateMessage = computed(() => {
    this.language.lang();
    switch (this.effState()) {
      case 'connecting':   return this.transloco.translate('connection.connecting');
      case 'reconnecting': return this.transloco.translate('connection.reconnecting');
      case 'disconnected': return this.transloco.translate('connection.disconnected');
      case 'closed':       return this.transloco.translate('connection.offline');
      default:             return this.transloco.translate('connection.recovered');
    }
  });

  /** The VISIBLE pill text. Same as {@link stateMessage} except in `reconnecting`, where it overlays the
   *  live "reconnecting in Ns" countdown (driven by WebsocketService.reconnectIn, which the facade
   *  decrements on a 250ms ticker). Because this ticks every second it MUST stay out of any aria-live
   *  region — the visible span is aria-hidden, and the separate sr-only live region is bound to
   *  {@link stateMessage}. Re-evaluates on language switch and on every countdown tick. */
  readonly label = computed(() => {
    this.language.lang();
    if (this.effState() !== 'reconnecting') return this.stateMessage();
    // Live countdown: render "reconnecting in Ns" when a backoff deadline is known (>0). Fall back to the
    // plain "reconnecting" message for the brief pre-emit gap, the dead-worker respawn window, and the
    // 0-edge — never show "reconnecting in 0s". Reading reconnectIn() registers it as a dependency, so the
    // label re-evaluates (and the pill width re-measures) on every tick.
    const ms = this.ws.reconnectIn();
    if (ms != null && ms > 0) {
      const secs = Math.max(1, Math.ceil(ms / 1000));
      return this.transloco.translate('connection.reconnectingIn', { s: secs });
    }
    return this.stateMessage();
  });

  readonly ariaLabel = computed(() => {
    this.language.lang();
    // Non-ticking base ({@link stateMessage}) so the accessible name is stable across countdown ticks; in
    // `reconnecting` the click is a retry trigger, conveyed as part of the name.
    const base = this.stateMessage();
    return this.effState() === 'reconnecting'
      ? `${base}. ${this.transloco.translate('connection.retry')}`
      : base;
  });

  constructor() {
    /* State-transition watcher: the only writer of `recovering`/`wasReconnecting`, and the stay-expanded
       driver while reconnecting. Reading effState() here is the single reactive input; writes go to
       independent signals. */
    effect(() => {
      const s: ConnectionState = this.effState();
      if (s === 'reconnecting' || s === 'disconnected') {
        // The failure mode this component exists for — STAY expanded so the live countdown (reconnecting) /
        // the "no network" label (disconnected) stays readable for the whole window (not just a 3.2s announce).
        // There is no timed collapse: the pill is the readout, and it collapses the instant we recover
        // (playRecoverFlourish) or go quiet (connecting/closed). Clicking while reconnecting retries instead of
        // toggling; while disconnected (OS offline) a retry is pointless, so it just toggles.
        this.wasReconnecting = true;
        this.expanded.set(true);
        this.announce(s === 'disconnected' ? 'connection.disconnected' : 'connection.reconnecting');
      } else if (s === 'connecting') {
        // Boot connect: show the dot quietly (no auto-expand, no flourish on the open that follows). NOT
        // announced — boot is a routine state, voicing it on every launch would be noise.
        this.wasReconnecting = false;
        this.collapse();
      } else if (s === 'open') {
        if (this.wasReconnecting) {
          this.playRecoverFlourish();
          this.announce('connection.recovered');
        }
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
   *  retry — skipping the backoff — and leaves the pill expanded; the visible feedback is the countdown
   *  resetting (the next failure emits a fresh, small deadline) or the recover flourish firing on success
   *  (which collapses it). In the other shown states the click just toggles the pill open/closed. */
  onClick(): void {
    if (this.effState() === 'reconnecting') {
      this.ws.retryNow();
    } else {
      this.expanded.update((v) => !v);
    }
  }

  /** Collapse the pill. Called when leaving the reconnecting state for a quiet one (connecting/closed) so
   *  those states always read as a dot/glyph, never inheriting a stale `expanded` left over from the
   *  reconnecting window. */
  private collapse(): void {
    this.expanded.set(false);
  }

  /** Voice a connection-state transition to assistive tech via the CDK LiveAnnouncer. Translates the key
   *  at call time (announce fires once per transition, on the language current at that moment). */
  private announce(key: 'connection.reconnecting' | 'connection.recovered' | 'connection.disconnected'): void {
    this.liveAnnouncer.announce(this.transloco.translate(key));
  }

  private playRecoverFlourish(): void {
    this.expanded.set(false);
    this.recovering.set(true);
    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => this.recovering.set(false), 1400);
  }

  ngOnDestroy(): void {
    this.controls.forEach((c) => c.stop());
    clearTimeout(this.recoverTimer);
    this.slot.priorityOccupied.set(false); // release the indicator slot so a deferred update can show
  }
}
