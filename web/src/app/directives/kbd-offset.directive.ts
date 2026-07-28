import { Directive, effect, inject, signal } from '@angular/core';
import { KeyboardInsetService } from '../services/keyboard-inset.service';
import { InputDeviceService } from '../services/input-device.service';
import { LayoutService } from '../services/layout.service';

/**
 * Soft-keyboard lift policy for a chat surface.
 *
 * Placed on the full-height chat container (the playground `.pg-stage` and the production
 * `.msg-container`). Binds the keyboard occlusion height as the `--kbd-lift` CSS variable on its host
 * (consumed by `.msg-viewport` and `.ci-input-bar` as a compositor-only `translateY(-K)` lift — see those
 * SCSS files). The keyboard GEOMETRY itself — the single `inset` signal, unified across the Android
 * native push and the browser `visualViewport` — is owned by {@link KeyboardInsetService}; this directive
 * applies only POLICY on top of it:
 *
 * - {@link offset}: the lift height. 0 when a physical keyboard is in use, or while a route-transition
 *   slide is in flight (immunity frame — hold the current lift so a native push mid-slide does not lift
 *   mid-transition). Otherwise it mirrors {@link KeyboardInsetService.inset}.
 *
 * Immunity frame: while {@link LayoutService.reflowFrozen} is true the offset holds its current value —
 * no mid-slide lift jitter — and recomputes once on thaw. Reading `reflowFrozen()` inside the effect
 * makes it re-run on freeze/thaw edges. The `if (frozen) return` guard sits BEFORE the `inset()` read so
 * `inset` is NOT tracked during a freeze (a native push mid-slide would otherwise re-run the effect and
 * lift mid-transition); on thaw the effect re-runs and reads it fresh.
 */
@Directive({
  selector: '[appKbdOffset]',
  host: {
    '[style.--kbd-lift]': 'offset() + "px"',
    '[style.--kbd-duration]': 'duration() + "ms"',
  },
})
export class KbdOffsetDirective {
  private readonly kbd = inject(KeyboardInsetService);
  private readonly layout = inject(LayoutService);
  private readonly inputDevice = inject(InputDeviceService);

  /** Soft-keyboard lift height (px) — bound as `--kbd-lift` on the host so `.msg-viewport` and
   *  `.ci-input-bar` translate the surface above the keyboard. ~0 when no keyboard is open. */
  readonly offset = signal(0);
  /** Native IME duration while an endpoint-driven animation is active; 60ms retains the existing
   *  low-pass smoothing for ordinary/non-animated inset corrections. */
  readonly duration = signal(60);

  private readonly track = effect(() => {
    const frozen = this.layout.reflowFrozen(); // track → re-run on freeze/thaw edges
    // Short-circuit on a PHYSICAL KEYBOARD (input modality), NOT on layout width. Keys on
    // InputDeviceService.hasPhysicalKeyboard because `layout.isDesktop` is width-only now — a wide touch
    // tablet (≥1280px desktop mode WITH a soft keyboard) must still track the keyboard, so the gate
    // cannot be the layout signal.
    if (this.inputDevice.hasPhysicalKeyboard()) { this.offset.set(0); return; }
    // Immunity frame: hold the current offset mid route-transition slide; recompute on thaw. MUST precede
    // the `inset()` read so `inset` is not tracked during a freeze (a native push mid-slide would
    // otherwise re-run the effect and lift mid-transition). Returning here keeps the effect subscribed to
    // `reflowFrozen()`, so it re-runs on thaw.
    if (frozen) return;
    const override = this.kbd.layoutOverride();
    const animation = this.kbd.animation();
    this.duration.set(animation?.durationMs ?? 60);
    this.offset.set(override ?? animation?.target ?? this.kbd.inset());
  });
}
