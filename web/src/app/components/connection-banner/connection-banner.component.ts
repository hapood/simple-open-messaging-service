import { Component, computed, effect, inject, OnDestroy, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { WebsocketService, ConnectionState } from '../../services/websocket.service';
import { LanguageService } from '../../services/language.service';

/**
 * Compact connection-status chip, fixed at the top-right corner of the viewport, sitting *below* the
 * app header (the shell's `--conn-chip-top` var offsets it by `--app-header-h` while the home header
 * is visible, so it never overlaps the search button). Replaces the former full-width amber strip — a
 * routine, recoverable reconnect no longer shoves a bar across the whole app.
 *
 * The whole reason this exists (unchanged from the strip): a silent SSE disconnect must not read as
 * "messages just stopped arriving". So the chip announces itself on the one transition that matters —
 * `open → reconnecting` — by briefly auto-expanding into a pill with the detail text, then collapsing
 * back to a spinner dot. Click expands it again any time. Boot `connecting` shows the dot quietly
 * (no auto-expand — there is no prior session to be confused about).
 *
 * On recovery (`reconnecting → open`) it plays a spinner → green-check flourish over ~1.4s, then
 * fades out and is removed from the DOM. Boot `connecting → open` does NOT flourish — only an actual
 * reconnect does.
 *
 * Visual states (driven by `show()`):
 *  - `connecting` / `reconnecting`: amber spinner dot (`.expanded` grows it into a pill).
 *  - `recovered`: green check flourish (`.recovering`), chip fades out at the end of the animation.
 *  - hidden otherwise (steady `open`, or `closed` = logged out, where the shell navigates away).
 *
 * Theme: amber tint is `color-mix` of `--app-warning` over `--app-surface`; the recovered flourish
 * uses `--app-success`. Both tokens carry `[data-theme=dark]` overrides, so the chip auto-themes.
 *
 * Layout: `position: fixed` so it stays visible over the mobile full-screen chat overlay (z-index 50,
 * audited against the shell's slot layers — same stacking the old strip used). It does NOT push
 * content: a corner chip owns no layout space, so the shell's old `--conn-banner-h` reservation is gone.
 */
@Component({
  selector: 'app-connection-banner',
  standalone: true,
  template: `
    @if (show(); as s) {
      <button class="chip"
              type="button"
              [class.expanded]="expanded()"
              [class.recovering]="s === 'recovered'"
              [attr.aria-label]="ariaLabel()"
              [attr.aria-expanded]="expanded()"
              (click)="onToggle()">
        <span class="icon" aria-hidden="true">
          @if (s === 'recovered') {
            <svg class="check" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7" />
            </svg>
          } @else {
            <span class="spinner"></span>
          }
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
         stays visible over the mobile full-screen chat overlay, AND above the update banner (51) so the
         connection status stays visible during a pending update; below modal/popover stacks. NOT a blind
         9999. */
      z-index: 52;
      display: block;
    }
    .chip {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 36px;
      width: 36px;
      max-width: 36px;
      padding: 0;
      border-radius: 9999px; /* circle when collapsed (w==h==36), pill when expanded */
      border: 1px solid color-mix(in srgb, var(--app-warning) 32%, transparent);
      background: color-mix(in srgb, var(--app-warning) 16%, var(--app-surface));
      color: var(--app-warning);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      cursor: pointer;
      overflow: hidden;
      /* The dot→pill morph: width + padding grow rightward from the circle, text fades/slides in.
         Exempt from the integer-px rule: max-width/padding are box dims and ARE integer px at every
         stop (36 / 260, 0 / 8·14); transition timing + the ease curve are non-box visual values. */
      transition:
        max-width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
        padding 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
        background 0.32s linear,
        color 0.32s linear,
        border-color 0.32s linear;
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
    .spinner {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid color-mix(in srgb, var(--app-warning) 30%, transparent);
      border-top-color: var(--app-warning);
      animation: conn-spin 0.7s linear infinite;
    }
    .check {
      width: 18px;
      height: 18px;
      stroke: var(--app-success);
      stroke-width: 2.4;
    }
    /* Draw the checkmark: stroke-dasharray/offset are non-box visual props (exempt from integer-px). */
    .check path {
      stroke-dasharray: 20;
      stroke-dashoffset: 20;
      animation: conn-check 0.45s 0.08s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }
    .text {
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
      line-height: 20px; /* length in integer px, per the CSS integer-pixel rule */
      opacity: 0;
      transform: translateX(-4px);
      transition: opacity 0.22s linear, transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .chip.expanded .text {
      opacity: 1;
      transform: none;
      transition-delay: 0.08s; /* let the pill begin opening before the text shows */
    }
    /* Recover flourish: green tint + the chip scales in, holds for the check draw, then fades out
       before the recovering signal flips to false and the element is removed. transform/opacity exempt. */
    .chip.recovering {
      background: color-mix(in srgb, var(--app-success) 18%, var(--app-surface));
      color: var(--app-success);
      border-color: color-mix(in srgb, var(--app-success) 36%, transparent);
      animation: conn-recover 1.4s ease-out forwards;
    }
    @keyframes conn-spin { to { transform: rotate(360deg); } }
    @keyframes conn-check { to { stroke-dashoffset: 0; } }
    @keyframes conn-recover {
      0%   { opacity: 0; transform: scale(0.82); }
      18%  { opacity: 1; transform: scale(1); }
      70%  { opacity: 1; transform: scale(1); }
      100% { opacity: 0; transform: scale(0.9); }
    }
    @media (prefers-reduced-motion: reduce) {
      .chip          { transition: none; }
      .chip.recovering { animation: none; }
      .spinner       { animation: none; opacity: 0.9; }
      .check path    { animation: none; stroke-dashoffset: 0; }
      .text          { transition: none; transform: none; }
    }
  `],
})
export class ConnectionBannerComponent implements OnDestroy {
  private readonly ws = inject(WebsocketService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  /** True for ~1.4s after a reconnect recovers — drives the spinner→check flourish. */
  readonly recovering = signal(false);

  /** Pill expanded (click toggles; auto-expand briefly on a mid-session reconnect). */
  readonly expanded = signal(false);

  /** Only meaningful between the reconnect drop and the open that follows it. */
  private wasReconnecting = false;

  private autoExpandTimer?: ReturnType<typeof setTimeout>;
  private recoverTimer?: ReturnType<typeof setTimeout>;

  /** The state to render: an in-progress state, 'recovered' during the flourish, or undefined (hidden). */
  readonly show = computed<'connecting' | 'reconnecting' | 'recovered' | undefined>(() => {
    if (this.recovering()) return 'recovered';
    const s = this.ws.state();
    return s === 'connecting' || s === 'reconnecting' ? s : undefined;
  });

  /** Detail text for the expanded pill / aria-label. Re-evaluates on language switch. */
  readonly label = computed(() => {
    this.language.lang();
    switch (this.ws.state()) {
      case 'connecting':   return this.transloco.translate('connection.connecting');
      case 'reconnecting': return this.transloco.translate('connection.reconnecting');
      default:             return this.transloco.translate('connection.recovered');
    }
  });

  readonly ariaLabel = computed(() => {
    this.language.lang();
    return this.label();
  });

  constructor() {
    /* State-transition watcher: the only writer of `recovering`/`wasReconnecting`, and the auto-expand
       trigger. Reading state() here is the single reactive input; the writes are to independent signals
       (no self-loop). Timers are cleared in ngOnDestroy. */
    effect(() => {
      const s: ConnectionState = this.ws.state();
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
    clearTimeout(this.autoExpandTimer);
    clearTimeout(this.recoverTimer);
  }
}
