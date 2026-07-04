import { Directive, effect, ElementRef, inject, signal } from '@angular/core';
import { LayoutService } from '../services/layout.service';

/**
 * Single source of soft-keyboard geometry for a chat surface.
 *
 * Placed on the full-height chat container (the playground `.pg-stage` and the production
 * `.msg-container`). Owns the ONE visualViewport listener — previously duplicated, with subtly
 * different shapes, in the playground and the message thread — and exposes TWO signals:
 *
 * - {@link offset}: `host.clientHeight − visualViewport.height − visualViewport.offsetTop`. The iOS
 *   manual-lift value (the layout viewport does not resize on iOS, so this is the real occlusion and
 *   is bound as the input bar's bottom inset). On Chromium Android (`interactive-widget=resizes-content`)
 *   the layout viewport itself shrinks, so the input rises for free and this evaluates to ~0 — correct
 *   there; the lift IS the layout shrink. This is the finished lift calc — do not change it.
 * - {@link occlusion}: the REAL keyboard height on Android, derived independently so the emoji swap can
 *   size its panel even where `offset` is 0. Computed as `baseHeight − host.clientHeight` where
 *   `baseHeight` is the largest clientHeight ever observed (the no-keyboard baseline; reset on
 *   orientation change so a portrait⇄landscape switch re-learns). Read at toggle time, BEFORE hide().
 *
 * Immunity frame: while `LayoutService.reflowFrozen()` (a route-transition animation is in flight) both
 * signals hold their current value — no mid-slide lift jitter — and recompute once on thaw. Reading
 * `reflowFrozen()` inside the effect makes it re-run on freeze/thaw edges. A no-op on the playground,
 * which never route-transitions.
 */
@Directive({ selector: '[appKbdOffset]' })
export class KbdOffsetDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly layout = inject(LayoutService);

  /** iOS manual-lift value (~0 on Chromium Android, where the layout viewport shrinks instead). Bind as
   *  the input bar's bottom inset. */
  readonly offset = signal(0);
  /** Real keyboard occlusion height (px), for sizing the emoji swap panel. ~0 when no keyboard. */
  readonly occlusion = signal(0);
  /** No-keyboard baseline: the largest host.clientHeight observed. Reset on orientation change. */
  private baseHeight = 0;

  private readonly track = effect((onCleanup) => {
    const frozen = this.layout.reflowFrozen(); // track → re-run on freeze/thaw edges
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (this.layout.isDesktop() || !vv) { this.offset.set(0); this.occlusion.set(0); return; }
    const el = this.host.nativeElement;
    const update = (): void => {
      if (this.layout.reflowFrozen()) return; // immunity frame: hold the current offset/occlusion
      const cur = el.clientHeight;
      // Learn the no-keyboard baseline: the viewport only ever reaches its full height when nothing
      // occludes it, so the running max IS the baseline. (Address-bar collapse grows the viewport; the
      // max tracks that too — fine, since the swap reads occlusion with the keyboard up, where the
      // current state and the baseline share the same address-bar state.)
      if (cur > this.baseHeight) this.baseHeight = cur;
      this.occlusion.set(Math.max(0, this.baseHeight - cur));
      this.offset.set(Math.max(0, cur - vv.height - vv.offsetTop));
    };
    if (!frozen) update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    // Portrait ⇄ landscape changes the baseline (different full height); re-learn from the next sample.
    const onOrient = (): void => { this.baseHeight = 0; };
    window.addEventListener('orientationchange', onOrient);
    onCleanup(() => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('orientationchange', onOrient);
    });
  });
}
