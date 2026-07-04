import { Component, computed, effect, ElementRef, inject, input, OnDestroy, signal, viewChild } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { animate, type AnimationPlaybackControls } from 'motion';
import { WebsocketService, ConnectionState } from '../../services/websocket.service';
import { LanguageService } from '../../services/language.service';

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
 * === Animation (Motion) ===
 * The icon is ONE svg carrying every shape — a revolving arc (`.spin`), a check (`.check`), and an
 * offline ring+slash (`.off`). On each visual-state change, a Motion `effect` springs the chip's gradient
 * stops (`--g-from`/`--g-to`) and icon color (`--ic`) — registered `<color>` vars, so they interpolate —
 * and crossfades/draws the relevant shape via `stroke-dashoffset` (each shape is `pathLength="100"`, so
 * `dashoffset 100 → 0` is a uniform draw-on regardless of geometry). The perpetual idle spin stays in CSS
 * (cheap, GPU-friendly); Motion owns only the discrete state-transition morph. Motion is DOM-direct, so
 * it is fully zoneless-safe (no reliance on Angular change detection). `prefers-reduced-motion` snaps every
 * morph to its end state and halts the spin/shimmer CSS.
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
      <button class="chip"
              #chip
              type="button"
              [class.expanded]="expanded()"
              [class.recovering]="s === 'recovered'"
              [class.spinning]="s === 'connecting' || s === 'reconnecting'"
              [style.--spin-dur]="spinDur() + 'ms'"
              [attr.aria-label]="ariaLabel()"
              [attr.aria-expanded]="expanded()"
              (click)="onToggle()">
        <span class="icon" aria-hidden="true">
          <svg class="ic" viewBox="0 0 24 24" fill="none">
            <!-- The revolving spinner: track + arc. Opacity-animated by Motion; the group rotates via CSS. -->
            <g class="spin">
              <circle class="track" cx="12" cy="12" r="9" pathLength="100" />
              <circle class="arc"   cx="12" cy="12" r="9" pathLength="100" />
            </g>
            <!-- Recovered check. Drawn on by Motion (stroke-dashoffset 100 → 0). -->
            <path class="check" d="M7 12.8l3.1 3.1L17 9" pathLength="100" />
            <!-- Offline glyph. Drawn on together when the chip is in the 'closed' state. -->
            <g class="off">
              <circle class="off-ring" cx="12" cy="12" r="8" pathLength="100" />
              <line   class="slash"    x1="6.5" y1="6.5" x2="17.5" y2="17.5" pathLength="100" />
            </g>
          </svg>
        </span>
        @if (expanded()) {
          <span class="text" aria-live="polite">{{ label() }}</span>
        }
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
      position: relative; /* anchor for the ::before state layer */
      display: flex;
      align-items: center;
      gap: 8px;
      box-sizing: border-box;
      height: 36px;
      width: 36px;
      max-width: 36px;
      padding: 0;
      border: none; /* M3 tonal-fill chip: fill + elevation define the shape, no stroke */
      border-radius: 9999px; /* circle when collapsed (w==h==36), pill when expanded */
      /* Gradient = two animated <color> stops. background-size > 100% lets .spinning drift it (shimmer). */
      background-color: var(--g-from);
      background-image: linear-gradient(135deg, var(--g-from), var(--g-to));
      background-size: 220% 220%;
      background-position: 0% 0%;
      color: var(--ic); /* drives currentColor for every icon shape */
      /* M3 elevation level 1 (the spec dual-layer shadow). */
      box-shadow:
        0 1px 2px 0 rgba(0, 0, 0, 0.30),
        0 1px 3px 1px rgba(0, 0, 0, 0.15);
      cursor: pointer;
      overflow: hidden;
      /* Only layout/elevation transition here — the gradient + color are OWNED by Motion (spring), so they
         are deliberately excluded to avoid fighting it. Easing is the M3 standard curve; max-width/padding
         are box dims and stay integer px at every stop (36 / 260, 0 / 8·14). */
      transition:
        max-width 0.30s cubic-bezier(0.2, 0, 0, 1),
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
      max-width: 260px;
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
    /* The spinner group revolves around its own center; --spin-dur is bound per state (faster on reconnect). */
    .spin {
      transform-box: fill-box;
      transform-origin: center;
      animation: conn-spin var(--spin-dur, 1.6s) linear infinite;
      opacity: 0; /* Motion fades it in when a spin state is active */
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
    /* Check + offline shapes: drawn on by Motion via stroke-dashoffset. pathLength=100 ⇒ offset 100 = fully
       hidden, 0 = fully drawn. Initial state here is "hidden" (Motion reveals the active one). */
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
    }
    .slash { stroke-width: 3.2; }
    .text {
      white-space: nowrap;
      /* M3 label-large (14 / 500 / 20). line-height stays an integer-px length per the rule. */
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      opacity: 0;
      transform: translateX(-4px);
      transition: opacity 0.20s linear, transform 0.20s cubic-bezier(0.2, 0, 0, 1);
    }
    .chip.expanded .text {
      opacity: 1;
      transform: none;
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
      /* Shapes settle to their drawn state; the morph effect also snaps (duration 0) under reduced motion. */
      .check,
      .off-ring,
      .slash           { stroke-dashoffset: 0; opacity: 1; }
      .text            { transition: none; transform: none; }
    }
  `],
})
export class ConnectionBannerComponent implements OnDestroy {
  private readonly ws = inject(WebsocketService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

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

  /** Active Motion controls — stopped before each morph so transitions never overlap/fight. */
  private controls: AnimationPlaybackControls[] = [];

  /** Per-state idle spin period (ms). Reconnecting spins faster (urgency); connecting is a calm scan. */
  readonly spinDur = computed(() => this.effState() === 'reconnecting' ? 900 : 1600);

  /** Cached reduced-motion preference — snaps every morph to its end state instead of animating. */
  private readonly reduceMotion = typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    return this.label();
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
      } else if (s === 'open') {
        if (this.wasReconnecting) this.playRecoverFlourish();
        this.wasReconnecting = false;
      } else { // 'closed' (logout / force-login) — the shell navigates away; just reset.
        this.wasReconnecting = false;
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
  }

  /** Spring the gradient + icon color, then crossfade/draw the icon shapes for the new state. */
  private morphTo(s: ConnVisual): void {
    const chipEl = this.chipRef()?.nativeElement;
    if (!chipEl) return;
    const cs = getComputedStyle(chipEl);
    const p = PALETTE[s];
    const read = (name: string): string => cs.getPropertyValue(name).trim();

    this.controls.forEach((c) => c.stop());
    this.controls = [];

    // Reduced motion: snap everything to its end state (duration 0) and skip the draw choreography.
    if (this.reduceMotion) {
      chipEl.style.setProperty('--g-from', read(p.from));
      chipEl.style.setProperty('--g-to', read(p.to));
      chipEl.style.setProperty('--ic', read(p.ic));
      this.setShapeVisibility(chipEl, s);
      return;
    }

    // Gradient stops + icon color: spring the registered <color> vars.
    const colorSpring = { type: 'spring' as const, stiffness: 140, damping: 22 };
    this.controls.push(animate(chipEl, {
      '--g-from': read(p.from),
      '--g-to':   read(p.to),
      '--ic':     read(p.ic),
    }, colorSpring));

    const spinning = s === 'connecting' || s === 'reconnecting';
    const spin = chipEl.querySelector<SVGGElement>('.spin');
    if (spin) {
      this.controls.push(animate(spin, { opacity: spinning ? 1 : 0 }, { duration: 0.28, ease: 'easeOut' }));
    }

    const shapeOpts = { duration: 0.45, ease: [0.2, 0, 0, 1] as [number, number, number, number] };
    const shape = (sel: string, on: boolean): void => {
      const el = chipEl.querySelector(sel);
      if (!el) return;
      this.controls.push(animate(el, {
        opacity: on ? 1 : 0,
        strokeDashoffset: on ? 0 : 100,
      }, shapeOpts));
    };
    shape('.check', s === 'recovered');
    shape('.off-ring', s === 'closed');
    shape('.slash', s === 'closed');
  }

  /** Reduced-motion helper: toggle each shape's opacity/offset directly (no animation). */
  private setShapeVisibility(chipEl: HTMLButtonElement, s: ConnVisual): void {
    const set = (sel: string, on: boolean): void => {
      const el = chipEl.querySelector<SVGElement>(sel);
      if (!el) return;
      el.style.opacity = on ? '1' : '0';
      el.style.strokeDashoffset = on ? '0' : '100';
    };
    const spinning = s === 'connecting' || s === 'reconnecting';
    const spin = chipEl.querySelector<SVGGElement>('.spin');
    if (spin) spin.style.opacity = spinning ? '1' : '0';
    set('.check', s === 'recovered');
    set('.off-ring', s === 'closed');
    set('.slash', s === 'closed');
  }

  /** Click toggles the pill; a manual toggle cancels any pending auto-collapse so the user wins. */
  onToggle(): void {
    clearTimeout(this.autoExpandTimer);
    this.expanded.update((v) => !v);
  }

  private scheduleAutoExpand(): void {
    if (this.expanded()) return;
    this.expanded.set(true);
    clearTimeout(this.autoExpandTimer);
    this.autoExpandTimer = setTimeout(() => this.expanded.set(false), 3200);
  }

  private playRecoverFlourish(): void {
    this.expanded.set(false);
    this.recovering.set(true);
    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => this.recovering.set(false), 1400);
  }

  ngOnDestroy(): void {
    this.controls.forEach((c) => c.stop());
    clearTimeout(this.autoExpandTimer);
    clearTimeout(this.recoverTimer);
  }
}
