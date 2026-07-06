import { Directive, effect, ElementRef, inject, signal } from '@angular/core';
import { InputDeviceService } from '../services/input-device.service';
import { LayoutService } from '../services/layout.service';

/**
 * Single source of soft-keyboard geometry for a chat surface.
 *
 * Placed on the full-height chat container (the playground `.pg-stage` and the production
 * `.msg-container`). Owns the ONE visualViewport listener — previously duplicated, with subtly
 * different shapes, in the playground and the message thread — and exposes:
 *
 * - {@link offset}: `host.clientHeight − visualViewport.height − visualViewport.offsetTop`, bound as
 *   the input bar's bottom inset (margin-bottom). The layout viewport does not resize on touch browsers
 *   (the default `resizes-visual` keeps it at the full screen size — the `interactive-widget=resizes-content`
 *   keyword that once shrank it on Chromium Android was removed when the viewport-keyboard strategy was
 *   abandoned), so this carries the FULL keyboard height on both iOS and Android; the flex column above
 *   shrinks by the same amount, so the message list reflows clear of the keyboard too. This is the
 *   finished lift calc — do not change it.
 *
 * Immunity frame: while `LayoutService.reflowFrozen()` (a route-transition animation is in flight) the
 * offset holds its current value — no mid-slide lift jitter — and recomputes once on thaw. Reading
 * `reflowFrozen()` inside the effect makes it re-run on freeze/thaw edges. A no-op on the playground,
 * which never route-transitions.
 */
@Directive({ selector: '[appKbdOffset]' })
export class KbdOffsetDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly layout = inject(LayoutService);
  private readonly inputDevice = inject(InputDeviceService);

  /** Soft-keyboard occlusion height (px) — bound as the input bar's bottom inset so it lifts above the
   *  keyboard. ~0 when no keyboard is open. */
  readonly offset = signal(0);

  private readonly track = effect((onCleanup) => {
    const frozen = this.layout.reflowFrozen(); // track → re-run on freeze/thaw edges
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    // Short-circuit on a PHYSICAL KEYBOARD (input modality), NOT on layout width. Keys on
    // InputDeviceService.hasPhysicalKeyboard because `layout.isDesktop` is width-only now — a wide touch
    // tablet (≥1280px desktop mode WITH a soft keyboard) must still track the keyboard, so the gate cannot
    // be the layout signal.
    if (this.inputDevice.hasPhysicalKeyboard() || !vv) { this.offset.set(0); return; }
    const el = this.host.nativeElement;
    const update = (): void => {
      if (this.layout.reflowFrozen()) return; // immunity frame: hold the current offset
      this.offset.set(Math.max(0, el.clientHeight - vv.height - vv.offsetTop));
    };
    if (!frozen) update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    onCleanup(() => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    });
  });
}
