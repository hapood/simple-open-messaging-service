import { Component, ChangeDetectionStrategy } from '@angular/core';

/**
 * The single positioned anchor for top-center status indicators. ONE fixed position is declared HERE (on
 * this `:host`); projected indicators own appearance and behavior but no viewport positioning.
 *
 * The connection chip currently occupies this lane alone. Update and event feedback use the global bottom
 * Material snackbar, so they never compete with the persistent connection state.
 *
 * The top offset clears the 56px header that always sits at the viewport top inside the home shell — the
 * ChatPane's `.msg-header` on desktop / chat-open, or the home header (`HomeHeaderComponent`) in the
 * mobile/tablet list view. A 6px gap mirrors the sticky-date overlay's `--sd-top: var(--msg-header-h)`
 * clearance of the same ChatPane header. The native safe-area inset is added explicitly because this
 * `:host` lives outside `.shell`/`.msg-container` and therefore cannot inherit their header-height tokens.
 * Horizontal centering is viewport-relative, so multi-pane desktop/tablet layouts do not make the status
 * appear to belong to any individual pane.
 *
 * Playground parity: the chatbox playground wraps its OWN demo indicators in an `<app-indicator-slot>`
 * inside `.pg-stage`, then overrides THIS rule to `position: absolute; top: 54px` (anchored to the stage,
 * clearing its 48px header). The indicators are byte-for-byte identical in both places — only the slot's
 * positioning context differs.
 */
@Component({
  selector: 'app-indicator-slot',
  template: '<ng-content />',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        position: fixed;
        top: calc(62px + var(--soms-safe-top, 0px));
        left: 50%;
        transform: translateX(-50%);
        /* Above the shell's routed overlays (mobile aside-slot 40 / chat-slot 30 / tablet aside-slot 20) so
         the chip stays visible over the mobile full-screen chat overlay; below the modal (1000) and
         lightbox (1100) tiers. NOT a blind 9999. */
        z-index: 52;
        display: block;
      }
    `,
  ],
})
export class IndicatorSlotComponent {}
