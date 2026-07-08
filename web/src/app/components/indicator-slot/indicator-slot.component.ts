import { Component } from '@angular/core';

/**
 * The single positioned anchor for every top-right status indicator — the connection chip, the update
 * banner, and any future one. ONE fixed position is declared HERE (on this `:host`); the indicators
 * themselves carry NO positioning — they're projected children, so adding a new indicator later is just
 * dropping it inside the slot, and every indicator shares one consistent corner with zero per-indicator
 * positioning work.
 *
 * {@link IndicatorSlotService} enforces mutual exclusion: at most one indicator is visible at any moment
 * (the connection chip has priority; the update banner defers while it shows). So the slot hosts at most a
 * single child, and its shrink-to-fit width adopts whichever indicator is currently shown. The slot is a
 * 0×0 box (invisible, no hit area) when no indicator is visible.
 *
 * The top offset clears the 56px header that always sits at the viewport top inside the home shell — the
 * ChatPane's `.msg-header` on desktop / chat-open, or the home header (`HomeHeaderComponent`) in the
 * mobile/tablet list view. A 6px gap mirrors the sticky-date overlay's `--sd-top: var(--msg-header-h)`
 * clearance of the same ChatPane header. (Hardcoded rather than tokenized: this `:host` lives outside
 * `.shell`/`.msg-container`, so it can't inherit their header-height tokens — custom properties inherit
 * DOWN the DOM only.)
 *
 * Playground parity: the chatbox playground wraps its OWN demo indicators in an `<app-indicator-slot>`
 * inside `.pg-stage`, then overrides THIS rule to `position: absolute; top: 54px` (anchored to the stage,
 * clearing its 48px header). The indicators are byte-for-byte identical in both places — only the slot's
 * positioning context differs.
 */
@Component({
  selector: 'app-indicator-slot',
  template: '<ng-content />',
  styles: [`
    :host {
      position: fixed;
      top: 62px;      /* clear the 56px header (msg-header / home header) + 6px gap */
      right: 12px;
      /* Above the shell's routed overlays (mobile aside-slot 40 / chat-slot 30 / tablet aside-slot 20) so
         the chip stays visible over the mobile full-screen chat overlay, and above the update banner during
         the brief priority handoff; below the modal (1000) and lightbox (1100) tiers. NOT a blind 9999. */
      z-index: 52;
      display: block;
    }
  `],
})
export class IndicatorSlotComponent {}
